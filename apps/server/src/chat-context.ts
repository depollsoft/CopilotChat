import { randomUUID } from "node:crypto";
import type { ProviderChatRequest, ProviderMessage, ProviderTitleTool } from "@copilotchat/provider";
import type { Chat, SendMessageRequest } from "@copilotchat/shared";
import { formatMemoryContext, messageAttachmentSchema } from "@copilotchat/shared";
import { buildConversationTools } from "./conversation-tools.js";
import type { AppDatabase } from "./db.js";

export interface ChatContextOptions { isolatedWorkspaceRoot: string; allowStdioMcp?: boolean }
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
    formatMemoryContext("Project memories:", memories),
    references.length > 0 ? ["Project reference materials:", ...references.map((reference) => `## ${reference.title}\n${reference.content}`)].join("\n\n") : "",
    chatReferences.length > 0 ? ["Referenced prior chat content:", ...chatReferences.map((reference) => `- ${reference.title}: ${reference.excerpt}`)].join("\n") : "",
  ].filter(Boolean).join("\n\n") || null;
}

function buildUserContext(db: AppDatabase, ownerId: string): string | null {
  const context = db.getUserContext(ownerId);
  const memories = db.listMemories(ownerId, null).filter((memory) => memory.enabled);
  return [
    context.profile ? `Profile supplied by the user:\n${context.profile}` : "",
    formatMemoryContext("User memories:", memories),
    context.location ? `Location shared by the user (${context.location.precision}): ${context.location.latitude}, ${context.location.longitude}; accuracy about ${Math.round(context.location.accuracy)} meters; captured ${context.location.capturedAt}.` : "",
  ].filter(Boolean).join("\n\n") || null;
}
