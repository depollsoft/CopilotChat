import { randomUUID } from "node:crypto";
import type { ProviderChatRequest, ProviderMessage, ProviderTitleTool } from "@copilotchat/provider";
import type { Chat, MessageAttachment, SendMessageRequest } from "@copilotchat/shared";
import { messageAttachmentSchema } from "@copilotchat/shared";
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

export function buildProviderChatRequest(input: { db: AppDatabase; ownerId: string; chat: Chat; message: SendMessageRequest; pendingUserMessage?: { content: string; attachments: MessageAttachment[] }; messageOverride?: { id: string; content: string; attachments: MessageAttachment[] }; defaultModel: string; gitHubToken: string | null; context: ChatContextOptions; titleTool?: ProviderTitleTool }): ProviderChatRequest {
  const project = input.chat.projectId ? input.db.getProject(input.ownerId, input.chat.projectId) : null;
  const messages: ProviderMessage[] = input.db.listMessages(input.chat.id, { includeAttachmentData: true, includeAttachmentFilePaths: true }).map((message) => message.id === input.messageOverride?.id ? { role: message.role, content: input.messageOverride.content, attachments: providerAttachments(input.messageOverride.attachments) } : { role: message.role, content: message.content, attachments: readProviderAttachments(message.metadata) });
  if (input.pendingUserMessage) messages.push({ role: "user", content: input.pendingUserMessage.content, attachments: providerAttachments(input.pendingUserMessage.attachments) });
  const workingDirectory = chatWorkingDirectory(input.db, input.ownerId, input.chat, input.context.isolatedWorkspaceRoot);
  return {
    messages,
    sessionId: input.chat.providerSessionId ?? newProviderSessionId(input.ownerId, input.chat.id),
    resumeSession: Boolean(input.chat.providerSessionId),
    model: input.message.model ?? input.chat.model ?? project?.defaultModel ?? input.defaultModel,
    reasoningEffort: input.message.reasoningEffort ?? input.chat.reasoningEffort ?? undefined,
    contextTier: input.message.contextTier ?? input.chat.contextTier ?? undefined,
    permissionMode: input.message.permissionMode ?? "ask",
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
  return providerAttachments(parsed.data);
}

function providerAttachments(values: MessageAttachment[]): ProviderMessage["attachments"] {
  const attachments: NonNullable<ProviderMessage["attachments"]> = [];
  for (const attachment of values) {
    if (attachment.filePath) attachments.push({ type: "file", path: attachment.filePath, displayName: attachment.name, size: attachment.size });
    else if (attachment.data) attachments.push({ type: "blob", data: attachment.data, mimeType: attachment.mimeType, displayName: attachment.name, size: attachment.size });
  }
  return attachments.length > 0 ? attachments : undefined;
}

function newProviderSessionId(ownerId: string, chatId: string): string {
  return `copilotchat-${ownerId}-${chatId}-${randomUUID()}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function isolatedChatWorkspace(root: string, chatId: string): string {
  return `${root.replace(/\/+$/, "")}/${chatId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

export function chatWorkingDirectory(db: AppDatabase, ownerId: string, chat: Chat, isolatedWorkspaceRoot: string): string {
  return chat.workspaceId ? db.getWorkspace(ownerId, chat.workspaceId).rootPath : isolatedChatWorkspace(isolatedWorkspaceRoot, chat.id);
}

function buildProjectContext(db: AppDatabase, ownerId: string, projectId: string): string | null {
  const project = db.getProject(ownerId, projectId);
  const references = db.listProjectReferences(ownerId, projectId);
  const chatReferences = db.listProjectChatReferences(ownerId, projectId);
  return [
    project.instructions ? `Project instructions:\n${project.instructions}` : "",
    project.memory ? `Shared project memory:\n${project.memory}` : "",
    references.length > 0 ? ["Project reference materials:", ...references.map((reference) => `## ${reference.title}\n${reference.content}`)].join("\n\n") : "",
    chatReferences.length > 0 ? ["Referenced prior chat content:", ...chatReferences.map((reference) => `- ${reference.title}: ${reference.excerpt}`)].join("\n") : "",
  ].filter(Boolean).join("\n\n") || null;
}
