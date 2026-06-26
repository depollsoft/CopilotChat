import { z } from "zod";

export const appName = "CopilotChat";
export const apiPrefix = "/api";
export const chatRoles = ["system", "user", "assistant", "tool"] as const;
export type ChatRole = (typeof chatRoles)[number];
export const reasoningEffortSchema = z.enum(["default", "none", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export const permissionModeSchema = z.enum(["ask", "yolo"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const ownerSchema = z.object({
  id: z.string(),
  login: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  authProvider: z.enum(["local", "github"]),
});
export type Owner = z.infer<typeof ownerSchema>;

export const projectSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  instructions: z.string().nullable(),
  memory: z.string().nullable(),
  defaultModel: z.string().nullable(),
  favorite: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectReferenceSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  projectId: z.string(),
  title: z.string(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectReference = z.infer<typeof projectReferenceSchema>;

export const projectChatReferenceSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  projectId: z.string(),
  sourceChatId: z.string(),
  sourceMessageId: z.string(),
  title: z.string(),
  excerpt: z.string(),
  createdAt: z.string(),
});
export type ProjectChatReference = z.infer<typeof projectChatReferenceSchema>;

export const chatSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  projectId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  providerSessionId: z.string().nullable(),
  providerSessionWorkspacePath: z.string().nullable(),
  model: z.string().nullable(),
  reasoningEffort: reasoningEffortSchema.nullable(),
  title: z.string(),
  titleManuallySet: z.boolean().default(false),
  archived: z.boolean(),
  favorite: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Chat = z.infer<typeof chatSchema>;

export const messageAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  data: z.string().min(1).optional(),
});
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;
export const messageAttachmentInputSchema = messageAttachmentSchema.extend({ data: z.string().min(1) });

export const messageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: z.enum(chatRoles),
  content: z.string(),
  provider: z.string().nullable(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof messageSchema>;

export const artifactKindSchema = z.enum(["text", "markdown", "code", "json", "mermaid", "html", "file-bundle"]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const artifactSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  projectId: z.string().nullable(),
  chatId: z.string().nullable(),
  messageId: z.string().nullable(),
  filePath: z.string().nullable(),
  title: z.string(),
  kind: artifactKindSchema,
  language: z.string().nullable(),
  content: z.string(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Artifact = z.infer<typeof artifactSchema>;
export const artifactSummarySchema = artifactSchema.omit({ content: true }).extend({
  contentPreview: z.string(),
  contentLength: z.number().int().nonnegative(),
});
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

export const skillPermissionSchema = z.enum(["network", "filesystem:read", "filesystem:write", "shell", "mcp", "github", "artifacts"]);
export type SkillPermission = z.infer<typeof skillPermissionSchema>;

export const skillManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  instructions: z.string(),
  prompts: z.array(z.object({ id: z.string(), title: z.string(), body: z.string() })).default([]),
  workflow: z.array(z.string()).default([]),
  artifactTemplates: z.array(z.object({ id: z.string(), title: z.string(), kind: artifactKindSchema, content: z.string() })).default([]),
  mcpDependencies: z.array(z.string()).default([]),
  toolDependencies: z.array(z.string()).default([]),
  activationRules: z.array(z.string()).default([]),
  permissions: z.array(skillPermissionSchema).default([]),
});
export type SkillManifest = z.infer<typeof skillManifestSchema>;

export const skillSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  projectId: z.string().nullable(),
  enabled: z.boolean(),
  builtIn: z.boolean(),
  manifest: skillManifestSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Skill = z.infer<typeof skillSchema>;

export const mcpServerSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().nullable(),
  args: z.array(z.string()).default([]),
  url: z.string().nullable(),
  tools: z.array(z.string()).default([]),
  enabled: z.boolean(),
  projectId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

export const workspaceSchema = z.object({
  id: z.string(), ownerId: z.string(), name: z.string(), rootPath: z.string(), enabled: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const toolRunSchema = z.object({
  id: z.string(), ownerId: z.string(), chatId: z.string().nullable(), workspaceId: z.string().nullable(), toolName: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]), input: z.record(z.unknown()).default({}), output: z.record(z.unknown()).default({}), error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
});
export type ToolRun = z.infer<typeof toolRunSchema>;

export const importSourceSchema = z.enum(["chatgpt", "claude", "gemini", "auto"]);
export type ImportSource = z.infer<typeof importSourceSchema>;
export const importedMessageSchema = z.object({ role: z.enum(["user", "assistant", "system", "tool"]), content: z.string(), createdAt: z.string().nullable().default(null), metadata: z.record(z.unknown()).default({}) });
export type ImportedMessage = z.infer<typeof importedMessageSchema>;
export const importedProjectReferenceSchema = z.object({ sourceId: z.string().nullable().default(null), title: z.string(), content: z.string(), createdAt: z.string().nullable().default(null), metadata: z.record(z.unknown()).default({}) });
export type ImportedProjectReference = z.infer<typeof importedProjectReferenceSchema>;
export const importedProjectSchema = z.object({ source: z.enum(["chatgpt", "claude", "gemini"]), sourceId: z.string().nullable(), name: z.string(), description: z.string().nullable().default(null), instructions: z.string().nullable().default(null), memory: z.string().nullable().default(null), references: z.array(importedProjectReferenceSchema).default([]), metadata: z.record(z.unknown()).default({}) });
export type ImportedProject = z.infer<typeof importedProjectSchema>;
export const importedConversationSchema = z.object({ source: z.enum(["chatgpt", "claude", "gemini"]), sourceId: z.string().nullable(), projectSourceId: z.string().nullable().default(null), title: z.string(), createdAt: z.string().nullable().default(null), updatedAt: z.string().nullable().default(null), messages: z.array(importedMessageSchema), artifacts: z.array(artifactSchema.omit({ ownerId: true })).default([]), reusableHelpers: z.array(skillManifestSchema).default([]), metadata: z.record(z.unknown()).default({}) });
export type ImportedConversation = z.infer<typeof importedConversationSchema>;
export const importPreviewSchema = z.object({ source: z.enum(["chatgpt", "claude", "gemini"]), conversations: z.array(importedConversationSchema), projects: z.array(importedProjectSchema).default([]), warnings: z.array(z.string()).default([]) });
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export const importDraftSchema = z.object({ id: z.string(), fileName: z.string(), source: importSourceSchema, encoding: z.enum(["text", "base64"]), createdAt: z.string() });
export type ImportDraft = z.infer<typeof importDraftSchema>;

export const providerModelSchema = z.object({ id: z.string(), name: z.string(), supportsReasoningEffort: z.boolean().default(false), supportedReasoningEfforts: z.array(z.string()).default([]), defaultReasoningEffort: z.string().optional(), contextWindowTokens: z.number().int().positive().optional(), maxPromptTokens: z.number().int().positive().optional() });
export type ProviderModel = z.infer<typeof providerModelSchema>;
export const providerStatusSchema = z.object({ id: z.string(), label: z.string(), available: z.boolean(), details: z.string(), capabilities: z.array(z.string()).default([]), models: z.array(providerModelSchema).default([]), defaultModel: z.string().optional() });
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const appStateSchema = z.object({ owner: ownerSchema, projects: z.array(projectSchema), projectReferences: z.array(projectReferenceSchema), projectChatReferences: z.array(projectChatReferenceSchema), chats: z.array(chatSchema), archivedChats: z.array(chatSchema), artifacts: z.array(artifactSummarySchema), skills: z.array(skillSchema), mcpServers: z.array(mcpServerSchema), workspaces: z.array(workspaceSchema), provider: providerStatusSchema, activeChatIds: z.array(z.string()).default([]) });
export type AppState = z.infer<typeof appStateSchema>;

export const sendMessageRequestSchema = z.object({ content: z.string(), attachments: z.array(messageAttachmentInputSchema).optional(), projectId: z.string().nullable().optional(), workspaceId: z.string().nullable().optional(), skillIds: z.array(z.string()).optional(), model: z.string().min(1).optional(), reasoningEffort: reasoningEffortSchema.optional(), permissionMode: permissionModeSchema.optional() });
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
export const activeResponseInputRequestSchema = sendMessageRequestSchema.extend({ mode: z.enum(["steer", "queue"]) });
export type ActiveResponseInputRequest = z.infer<typeof activeResponseInputRequestSchema>;
export const editMessageRequestSchema = sendMessageRequestSchema.omit({ projectId: true, workspaceId: true });
export type EditMessageRequest = z.infer<typeof editMessageRequestSchema>;
export const createProjectRequestSchema = z.object({ name: z.string().min(1), description: z.string().optional().nullable(), instructions: z.string().optional().nullable(), memory: z.string().optional().nullable(), defaultModel: z.string().optional().nullable() });
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export const updateProjectRequestSchema = z.object({ name: z.string().min(1).optional(), description: z.string().optional().nullable(), instructions: z.string().optional().nullable(), memory: z.string().optional().nullable(), defaultModel: z.string().optional().nullable(), favorite: z.boolean().optional() });
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;
export const createProjectReferenceRequestSchema = z.object({ projectId: z.string().min(1), title: z.string().min(1), content: z.string().min(1) });
export type CreateProjectReferenceRequest = z.infer<typeof createProjectReferenceRequestSchema>;
export const updateProjectReferenceRequestSchema = z.object({ title: z.string().min(1).optional(), content: z.string().min(1).optional() });
export type UpdateProjectReferenceRequest = z.infer<typeof updateProjectReferenceRequestSchema>;
export const createProjectChatReferenceRequestSchema = z.object({ projectId: z.string().min(1), messageId: z.string().min(1) });
export type CreateProjectChatReferenceRequest = z.infer<typeof createProjectChatReferenceRequestSchema>;
export const projectChatSearchResultSchema = z.object({ chatId: z.string(), messageId: z.string(), title: z.string(), role: z.enum(chatRoles), excerpt: z.string(), createdAt: z.string() });
export type ProjectChatSearchResult = z.infer<typeof projectChatSearchResultSchema>;
export const conversationScopeSchema = z.enum(["current_project", "other_projects", "all"]);
export type ConversationScope = z.infer<typeof conversationScopeSchema>;
export const conversationSearchResultSchema = z.object({ chatId: z.string(), chatTitle: z.string(), projectId: z.string().nullable(), projectName: z.string().nullable(), messageId: z.string(), role: z.enum(chatRoles), excerpt: z.string(), createdAt: z.string() });
export type ConversationSearchResult = z.infer<typeof conversationSearchResultSchema>;
export const conversationSummarySchema = z.object({ chatId: z.string(), title: z.string(), projectId: z.string().nullable(), projectName: z.string().nullable(), archived: z.boolean(), favorite: z.boolean(), messageCount: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string() });
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export const conversationTranscriptMessageSchema = z.object({ id: z.string(), role: z.enum(chatRoles), content: z.string(), createdAt: z.string() });
export type ConversationTranscriptMessage = z.infer<typeof conversationTranscriptMessageSchema>;
export const conversationTranscriptSchema = z.object({ chatId: z.string(), title: z.string(), projectId: z.string().nullable(), projectName: z.string().nullable(), messageCount: z.number().int().nonnegative(), truncated: z.boolean(), messages: z.array(conversationTranscriptMessageSchema) });
export type ConversationTranscript = z.infer<typeof conversationTranscriptSchema>;
export const createChatRequestSchema = z.object({ title: z.string().min(1), projectId: z.string().optional().nullable(), workspaceId: z.string().optional().nullable(), model: z.string().min(1).optional().nullable(), reasoningEffort: reasoningEffortSchema.optional().nullable() });
export type CreateChatRequest = z.infer<typeof createChatRequestSchema>;
export const updateChatRequestSchema = z.object({ title: z.string().min(1).optional(), archived: z.boolean().optional(), projectId: z.string().optional().nullable(), workspaceId: z.string().optional().nullable(), model: z.string().min(1).optional().nullable(), reasoningEffort: reasoningEffortSchema.optional().nullable(), favorite: z.boolean().optional() });
export type UpdateChatRequest = z.infer<typeof updateChatRequestSchema>;
export const createArtifactRequestSchema = z.object({ projectId: z.string().optional().nullable(), chatId: z.string().optional().nullable(), messageId: z.string().optional().nullable(), title: z.string().min(1), kind: artifactKindSchema, language: z.string().optional().nullable(), content: z.string() });
export type CreateArtifactRequest = z.infer<typeof createArtifactRequestSchema>;
export const updateArtifactRequestSchema = z.object({ title: z.string().min(1).optional(), kind: artifactKindSchema.optional(), language: z.string().optional().nullable(), content: z.string().optional() });
export type UpdateArtifactRequest = z.infer<typeof updateArtifactRequestSchema>;
export const updateSkillRequestSchema = z.object({ enabled: z.boolean().optional(), manifest: skillManifestSchema.optional() });
export type UpdateSkillRequest = z.infer<typeof updateSkillRequestSchema>;
export const updateMcpServerRequestSchema = z.object({ name: z.string().min(1).optional(), transport: z.enum(["stdio", "http", "sse"]).optional(), command: z.string().optional().nullable(), args: z.array(z.string()).optional(), url: z.string().optional().nullable(), tools: z.array(z.string()).optional(), enabled: z.boolean().optional(), projectId: z.string().optional().nullable() });
export type UpdateMcpServerRequest = z.infer<typeof updateMcpServerRequestSchema>;
export const registerWorkspaceRequestSchema = z.object({ name: z.string().min(1), rootPath: z.string().min(1) });
export type RegisterWorkspaceRequest = z.infer<typeof registerWorkspaceRequestSchema>;
export const updateWorkspaceRequestSchema = z.object({ name: z.string().min(1).optional(), enabled: z.boolean().optional() });
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;
export const runWorkspaceCommandRequestSchema = z.object({ command: z.string().min(1), cwd: z.string().optional().default("."), timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000) });
export type RunWorkspaceCommandRequest = z.infer<typeof runWorkspaceCommandRequestSchema>;
export const importPreviewRequestSchema = z.object({ source: importSourceSchema.default("auto"), fileName: z.string().min(1), content: z.string().min(1), encoding: z.enum(["text", "base64"]).default("text") });
export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;

export function titleFromContent(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "New chat";
  return compact.split(" ").slice(0, 6).join(" ");
}
