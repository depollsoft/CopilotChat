import type { ProviderChatRequest, ProviderMessage, ProviderTitleTool } from "@copilotchat/provider";
import type { Chat, SendMessageRequest } from "@copilotchat/shared";
import { messageAttachmentSchema } from "@copilotchat/shared";
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
    sessionId: input.chat.providerSessionId ?? stableProviderSessionId(input.ownerId, input.chat.id),
    resumeSession: Boolean(input.chat.providerSessionId),
    model: input.message.model ?? input.chat.model ?? project?.defaultModel ?? input.defaultModel,
    reasoningEffort: input.message.reasoningEffort ?? input.chat.reasoningEffort ?? undefined,
    permissionMode: input.message.permissionMode ?? "ask",
    projectContext: project ? buildProjectContext(input.db, input.ownerId, project.id) : null,
    skills: input.db.enabledSkillManifests(input.ownerId, input.message.skillIds, input.chat.projectId, input.message.content),
    mcpServers: input.db.enabledMcpServers(input.ownerId, input.chat.projectId).filter((server) => input.context.allowStdioMcp || server.transport !== "stdio"),
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

function stableProviderSessionId(ownerId: string, chatId: string): string {
  return `copilotchat-${ownerId}-${chatId}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function isolatedChatWorkspace(root: string, chatId: string): string {
  return `${root.replace(/\/+$/, "")}/${chatId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
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
