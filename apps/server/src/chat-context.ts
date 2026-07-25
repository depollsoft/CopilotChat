import { randomUUID } from "node:crypto";
import type { ProviderChatRequest, ProviderMessage, ProviderTitleTool } from "@copilotchat/provider";
import type { Chat, Memory, SendMessageRequest } from "@copilotchat/shared";
import { messageAttachmentSchema } from "@copilotchat/shared";
import { buildConversationTools } from "./conversation-tools.js";
import type { AppDatabase } from "./db.js";

export interface ChatContextOptions { isolatedWorkspaceRoot: string; allowStdioMcp?: boolean }
const memoryContextCharacterBudget = 16_000;
const memoryContextNoticeReserve = 220;
const memoryTruncationNotice = "\n[Memory truncated to fit the context budget.]";
export function applyChatTurnScope(db: AppDatabase, ownerId: string, chatId: string, input: Pick<SendMessageRequest, "projectId" | "workspaceId">): Chat {
  const chat = db.getChat(ownerId, chatId);
  const projectId = input.projectId === undefined ? chat.projectId : input.projectId;
  const workspaceId = input.workspaceId === undefined ? chat.workspaceId : input.workspaceId;
  if (projectId === chat.projectId && workspaceId === chat.workspaceId) return chat;
  return db.updateChat(ownerId, chat.id, { projectId, workspaceId });
}

export function buildProviderChatRequest(input: { db: AppDatabase; ownerId: string; chat: Chat; message: SendMessageRequest; defaultModel: string; gitHubToken: string | null; context: ChatContextOptions; titleTool?: ProviderTitleTool }): ProviderChatRequest {
  const project = input.chat.projectId ? input.db.getProject(input.ownerId, input.chat.projectId) : null;
  const workspace = input.chat.workspaceId ? input.db.getWorkspace(input.ownerId, input.chat.workspaceId) : null;
  const messages: ProviderMessage[] = input.db.listMessages(input.chat.id, { includeAttachmentData: true }).map((message) => ({ role: message.role, content: message.content, attachments: readProviderAttachments(message.metadata) }));
  const workingDirectory = workspace?.rootPath ?? isolatedChatWorkspace(input.context.isolatedWorkspaceRoot, input.chat.id);
  return {
    messages,
    sessionId: input.chat.providerSessionId ?? newProviderSessionId(input.ownerId, input.chat.id),
    resumeSession: Boolean(input.chat.providerSessionId),
    model: input.message.model ?? input.chat.model ?? project?.defaultModel ?? input.defaultModel,
    reasoningEffort: input.message.reasoningEffort ?? input.chat.reasoningEffort ?? undefined,
    contextTier: input.message.contextTier ?? input.chat.contextTier ?? undefined,
    permissionMode: input.message.permissionMode ?? "ask",
    userContext: buildUserContext(input.db, input.ownerId),
    projectContext: project ? buildProjectContext(input.db, input.ownerId, project.id) : null,
    skills: input.db.enabledSkillManifests(input.ownerId, input.message.skillIds, input.chat.projectId, input.message.content),
    mcpServers: input.db.enabledMcpServers(input.ownerId, input.chat.projectId).filter((server) => input.context.allowStdioMcp || server.transport !== "stdio"),
    tools: buildConversationTools({ db: input.db, ownerId: input.ownerId, chat: input.chat }),
    gitHubToken: input.gitHubToken,
    workingDirectory,
    titleTool: input.chat.titleManuallySet ? undefined : input.titleTool,
  };
}

function readProviderAttachments(metadata: Record<string, unknown>): ProviderMessage["attachments"] {
  const parsed = messageAttachmentSchema.array().safeParse(metadata.attachments);
  if (!parsed.success || parsed.data.length === 0) return undefined;
  return parsed.data.flatMap((attachment) => attachment.data ? [{ type: "blob" as const, data: attachment.data, mimeType: attachment.mimeType, displayName: attachment.name }] : []);
}

function newProviderSessionId(ownerId: string, chatId: string): string {
  return `copilotchat-${ownerId}-${chatId}-${randomUUID()}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function isolatedChatWorkspace(root: string, chatId: string): string {
  return `${root.replace(/\/+$/, "")}/${chatId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

function buildProjectContext(db: AppDatabase, ownerId: string, projectId: string): string | null {
  const project = db.getProject(ownerId, projectId);
  const memories = db.listMemories(ownerId, projectId).filter((memory) => memory.enabled);
  const references = db.listProjectReferences(ownerId, projectId);
  const chatReferences = db.listProjectChatReferences(ownerId, projectId);
  return [
    project.instructions ? `Project instructions:\n${project.instructions}` : "",
    project.memory ? `Shared project memory:\n${project.memory}` : "",
    buildMemoryContext("Project memories:", memories),
    references.length > 0 ? ["Project reference materials:", ...references.map((reference) => `## ${reference.title}\n${reference.content}`)].join("\n\n") : "",
    chatReferences.length > 0 ? ["Referenced prior chat content:", ...chatReferences.map((reference) => `- ${reference.title}: ${reference.excerpt}`)].join("\n") : "",
  ].filter(Boolean).join("\n\n") || null;
}

function buildUserContext(db: AppDatabase, ownerId: string): string | null {
  const context = db.getUserContext(ownerId);
  const memories = db.listMemories(ownerId, null).filter((memory) => memory.enabled);
  return [
    context.profile ? `Profile supplied by the user:\n${context.profile}` : "",
    buildMemoryContext("User memories:", memories),
    context.location ? `Location shared by the user (${context.location.precision}): ${context.location.latitude}, ${context.location.longitude}; accuracy about ${Math.round(context.location.accuracy)} meters; captured ${context.location.capturedAt}.` : "",
  ].filter(Boolean).join("\n\n") || null;
}

function buildMemoryContext(heading: string, memories: Memory[]): string {
  if (memories.length === 0) return "";
  const ordered = [...memories].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  const blocks: string[] = [];
  const contentLimit = memoryContextCharacterBudget - memoryContextNoticeReserve;
  let used = heading.length;
  let omitted = 0;
  let truncated = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const memory = ordered[index]!;
    const prefix = `## ${memory.title}\n`;
    const separatorLength = 2;
    const available = contentLimit - used - separatorLength;
    const block = `${prefix}${memory.content}`;
    if (block.length <= available) {
      blocks.push(block);
      used += separatorLength + block.length;
      continue;
    }
    const contentLength = available - prefix.length - memoryTruncationNotice.length;
    if (contentLength > 0) {
      blocks.push(`${prefix}${memory.content.slice(0, contentLength)}${memoryTruncationNotice}`);
      truncated = 1;
      omitted = ordered.length - index - 1;
    } else {
      omitted = ordered.length - index;
    }
    break;
  }
  const limitations = [
    truncated ? "1 memory truncated" : "",
    omitted ? `${omitted} ${omitted === 1 ? "memory" : "memories"} omitted` : "",
  ].filter(Boolean);
  const notice = limitations.length > 0 ? `[Memory context limited to ${memoryContextCharacterBudget} characters; ${limitations.join("; ")}.]` : "";
  return [heading, ...blocks, notice].filter(Boolean).join("\n\n");
}
