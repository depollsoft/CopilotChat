import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { previewImportPayload } from "@copilotchat/importers";
import { createCopilotProvider } from "@copilotchat/provider";
import type { ProviderChatRequest } from "@copilotchat/provider";
import { activeResponseInputRequestSchema, apiPrefix, createArtifactRequestSchema, createChatRequestSchema, createProjectChatReferenceRequestSchema, createProjectReferenceRequestSchema, createProjectRequestSchema, editMessageRequestSchema, importPreviewRequestSchema, permissionModeSchema, registerWorkspaceRequestSchema, runWorkspaceCommandRequestSchema, sendMessageRequestSchema, skillManifestSchema, titleFromContent, updateArtifactRequestSchema, updateChatRequestSchema, updateMcpServerRequestSchema, updateProjectReferenceRequestSchema, updateProjectRequestSchema, updateSkillRequestSchema, updateWorkspaceRequestSchema } from "@copilotchat/shared";
import type { Chat, ChatMessage, ImportPreview, MessageAttachment, Owner, ProviderStatus, SendMessageRequest } from "@copilotchat/shared";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { artifactSystemContext, syncArtifactFiles, writeExistingArtifactFile, writeFileArtifact } from "./artifact-files.js";
import { applyChatTurnScope, buildProviderChatRequest, isolatedChatWorkspace } from "./chat-context.js";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { applyImportPreview } from "./import-apply.js";
import { ImportDraftStore } from "./import-drafts.js";
import { buildImportTools } from "./import-tools.js";
import { ActiveChatResponses } from "./responses.js";
import { runWorkspaceCommand, validateRegisteredWorkspaceRoot } from "./workspace.js";

const config = loadConfig();
if (config.authMode === "github" && !config.sessionSecret) throw new Error("COPILOTCHAT_SESSION_SECRET is required when COPILOTCHAT_AUTH_MODE=github.");
if (config.authMode === "github" && config.githubClientSecret && !config.publicUrl) throw new Error("COPILOTCHAT_PUBLIC_URL is required for GitHub OAuth web login.");
const db = new AppDatabase(config.dataDir);
const isolatedWorkspaceRoot = path.join(config.dataDir, "isolated-workspaces");
const importDrafts = new ImportDraftStore(path.join(config.dataDir, "import-drafts"));
fs.mkdirSync(isolatedWorkspaceRoot, { recursive: true });
const provider = createCopilotProvider({ provider: config.copilotProvider, apiBaseUrl: config.copilotApiBaseUrl, apiToken: config.copilotApiToken, model: config.copilotModel, cliCommand: config.copilotCliCommand, sdkCliPath: config.copilotSdkCliPath, gitHubToken: config.copilotGitHubToken });
const activeResponses = new ActiveChatResponses();
const app = Fastify({ logger: true, bodyLimit: config.bodyLimitBytes });
const requestOwners = new WeakMap<FastifyRequest, Owner>();
const sessionCookieName = "copilotchat_session";
const oauthStateCookieName = "copilotchat_oauth_state";
const providerStatusTtlMs = 5 * 60_000;
let providerStatusCache: { status: ProviderStatus; expiresAt: number } | null = null;
let providerStatusInFlight: Promise<ProviderStatus> | null = null;
const allowedOrigins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, "http://127.0.0.1:5173", "http://localhost:5173", ...config.allowedOrigins]);
await app.register(cors, { origin: (origin, cb) => { if (!origin || allowedOrigins.has(origin)) { cb(null, true); return; } cb(new Error(`Origin not allowed: ${origin}`), false); }, credentials: false });
app.addHook("preHandler", async (request, reply) => {
  if (!request.raw.url?.startsWith(apiPrefix)) return;
  const bearerOk = Boolean(config.apiToken && request.headers.authorization === `Bearer ${config.apiToken}`);
  if (config.authMode === "github" && !isAuthExemptPath(request.raw.url)) {
    const owner = bearerOk ? db.getOwner() : readSessionOwner(request);
    if (!owner) { reply.code(401).send({ error: "Login required", loginUrl: `${apiPrefix}/auth/github/login` }); return; }
    requestOwners.set(request, owner);
  } else if (config.apiToken && !bearerOk && config.authMode !== "github") {
    reply.code(401).send({ error: "Unauthorized" }); return;
  }
  if (!config.requireCsrf || !isMutatingMethod(request.method) || isAuthExemptPath(request.raw.url)) return;
  if (request.headers["x-copilotchat-csrf"] !== "1") { reply.code(403).send({ error: "Missing X-CopilotChat-CSRF header." }); return; }
});
const githubDeviceStartResponseSchema = z.object({ device_code: z.string(), user_code: z.string(), verification_uri: z.string(), expires_in: z.number(), interval: z.number() });
const githubDevicePollResponseSchema = z.union([z.object({ access_token: z.string(), token_type: z.string(), scope: z.string() }), z.object({ error: z.string(), error_description: z.string().optional() })]);
const githubUserSchema = z.object({ login: z.string(), name: z.string().nullable(), avatar_url: z.string().nullable() });
async function prepareChatTurn(ownerId: string, chatId: string, input: SendMessageRequest, existingUserMessage?: ChatMessage): Promise<{ chat: Chat; userMessage: ChatMessage; providerRequest: ReturnType<typeof buildProviderChatRequest> }> {
  const attachments = validateMessageAttachments(input);
  let chat = applyChatTurnScope(db, ownerId, chatId, input);
  if (input.model !== undefined || input.reasoningEffort !== undefined) chat = db.updateChat(ownerId, chat.id, { model: input.model ?? chat.model, reasoningEffort: input.reasoningEffort ?? chat.reasoningEffort });
  const userMessage = existingUserMessage ?? db.addMessage({ chatId: chat.id, role: "user", content: input.content });
  if (!existingUserMessage && attachments.length > 0) db.replaceMessageAttachments(ownerId, chat.id, userMessage.id, attachments);
  if (!existingUserMessage && !chat.titleManuallySet && (chat.title === "New chat" || chat.title === "Untitled chat")) chat = db.updateChatTitle(ownerId, chat.id, input.content.trim() ? titleFromContent(input.content) : titleFromContent(attachments.map((attachment) => attachment.name).join(" ")), "auto");
  const titleRequired = !chat.titleManuallySet && db.listMessages(chat.id).filter((message) => message.role === "user").length <= 1;
  const providerRequest = buildProviderChatRequest({ db, ownerId, chat, message: input, defaultModel: config.copilotModel, gitHubToken: db.getGitHubToken() ?? config.copilotGitHubToken ?? null, context: { isolatedWorkspaceRoot, allowStdioMcp: config.authMode !== "github" }, titleTool: chat.titleManuallySet ? undefined : { currentTitle: chat.title, required: titleRequired, setTitle: async (title) => { const current = db.getChat(ownerId, chat.id); if (current.titleManuallySet) return current.title; return db.updateChatTitle(ownerId, chat.id, title, "auto").title; } } });
  attachImportGuidance(ownerId, input, providerRequest);
  await fs.promises.mkdir(providerRequest.workingDirectory ?? isolatedWorkspaceRoot, { recursive: true });
  providerRequest.artifactContext = artifactSystemContext(await syncArtifactFiles({ db, ownerId, chat, workspaceDir: providerRequest.workingDirectory ?? isolatedWorkspaceRoot }));
  return { chat, userMessage, providerRequest: { ...providerRequest, reasoningEffort: providerRequest.reasoningEffort ?? "default" } };
}
app.get(`${apiPrefix}/health`, async () => ({ ok: true, name: "CopilotChat", time: new Date().toISOString() }));
app.get(`${apiPrefix}/auth/status`, async (request) => { const owner = ownerForOptional(request); return { mode: config.authMode, owner, authenticated: Boolean(owner), githubOAuthConfigured: Boolean(config.githubClientId && config.githubClientSecret), githubAuthenticated: config.authMode === "github" ? Boolean(owner) : db.hasGitHubAuth(), apiTokenRequired: Boolean(config.apiToken), copilotTokenSource: config.copilotGitHubTokenSource ?? null, copilotCliPath: config.copilotSdkCliPath ?? null }; });
app.get(`${apiPrefix}/auth/github/login`, async (request, reply) => {
  if (!config.githubClientId || !config.githubClientSecret) throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for GitHub login.");
  const state = randomBytes(24).toString("base64url");
  reply.header("Set-Cookie", cookie(oauthStateCookieName, signState(state), 600));
  const params = new URLSearchParams({ client_id: config.githubClientId, redirect_uri: `${publicOrigin(request)}/api/auth/github/callback`, scope: "read:user", state });
  reply.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});
app.get(`${apiPrefix}/auth/github/callback`, async (request, reply) => {
  if (!config.githubClientId || !config.githubClientSecret) throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for GitHub login.");
  const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(request.query);
  const stateCookie = readCookie(request, oauthStateCookieName);
  if (!stateCookie || verifyState(stateCookie) !== query.state) { reply.code(400).send({ error: "Invalid OAuth state." }); return; }
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: config.githubClientId, client_secret: config.githubClientSecret, code: query.code, redirect_uri: `${publicOrigin(request)}/api/auth/github/callback` }) });
  if (!tokenResponse.ok) throw new Error(`GitHub token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  const token = z.object({ access_token: z.string(), token_type: z.string(), scope: z.string().optional() }).parse(await tokenResponse.json());
  const userResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token.access_token}`, "X-GitHub-Api-Version": "2022-11-28" } });
  if (!userResponse.ok) throw new Error(`GitHub user lookup failed: ${userResponse.status} ${await userResponse.text()}`);
  const githubUser = githubUserSchema.parse(await userResponse.json());
  const owner = db.getOrCreateGitHubOwner({ login: githubUser.login, displayName: githubUser.name, avatarUrl: githubUser.avatar_url });
  reply.header("Set-Cookie", [cookie(sessionCookieName, signSession(owner), 60 * 60 * 24 * 30), clearCookie(oauthStateCookieName)]);
  reply.redirect("/");
});
app.post(`${apiPrefix}/auth/logout`, async (_request, reply) => { reply.header("Set-Cookie", clearCookie(sessionCookieName)); return { ok: true }; });
app.post(`${apiPrefix}/auth/github/device/start`, async () => { if (!config.githubClientId) throw new Error("GITHUB_CLIENT_ID is required for GitHub OAuth device flow."); const response = await fetch("https://github.com/login/device/code", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: config.githubClientId, scope: "read:user" }) }); if (!response.ok) throw new Error(`GitHub device flow failed: ${response.status} ${await response.text()}`); return githubDeviceStartResponseSchema.parse(await response.json()); });
app.post(`${apiPrefix}/auth/github/device/poll`, async (request) => { if (!config.githubClientId) throw new Error("GITHUB_CLIENT_ID is required for GitHub OAuth device flow."); const body = z.object({ deviceCode: z.string().min(1) }).parse(request.body); const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: config.githubClientId, device_code: body.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) }); if (!response.ok) throw new Error(`GitHub token exchange failed: ${response.status} ${await response.text()}`); const tokenResponse = githubDevicePollResponseSchema.parse(await response.json()); if ("error" in tokenResponse) { if (tokenResponse.error === "authorization_pending" || tokenResponse.error === "slow_down") return { status: tokenResponse.error }; throw new Error(tokenResponse.error_description ?? tokenResponse.error); } const userResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${tokenResponse.access_token}`, "X-GitHub-Api-Version": "2022-11-28" } }); if (!userResponse.ok) throw new Error(`GitHub user lookup failed: ${userResponse.status} ${await userResponse.text()}`); const githubUser = githubUserSchema.parse(await userResponse.json()); return { status: "authenticated", owner: db.setGitHubAuth({ accessToken: tokenResponse.access_token, login: githubUser.login, displayName: githubUser.name, avatarUrl: githubUser.avatar_url }) }; });
app.get(`${apiPrefix}/state`, async (request) => {
  const owner = ownerFor(request);
  const state = db.getState(await cachedProviderStatus(), [], owner.id);
  const chatIds = new Set([...state.chats, ...state.archivedChats].map((chat) => chat.id));
  return { ...state, activeChatIds: activeResponses.chatIds().filter((id) => chatIds.has(id)) };
});
app.delete(`${apiPrefix}/data`, async (request) => {
  const owner = ownerFor(request);
  const chats = [...db.listChats(owner.id), ...db.listArchivedChats(owner.id)];
  for (const chat of chats) activeResponses.cancel(chat.id);
  db.clearAllData(owner.id);
  await Promise.all(chats.map((chat) => fs.promises.rm(isolatedChatWorkspace(isolatedWorkspaceRoot, chat.id), { recursive: true, force: true })));
  await importDrafts.deleteOwner(owner.id);
  await fs.promises.mkdir(isolatedWorkspaceRoot, { recursive: true });
  return { ok: true };
});
app.post(`${apiPrefix}/projects`, async (request) => db.createProject(ownerFor(request).id, createProjectRequestSchema.parse(request.body)));
app.patch(`${apiPrefix}/projects/:projectId`, async (request) => { const owner = ownerFor(request); const params = z.object({ projectId: z.string() }).parse(request.params); return db.updateProject(owner.id, params.projectId, updateProjectRequestSchema.parse(request.body)); });
app.delete(`${apiPrefix}/projects/:projectId`, async (request) => { const owner = ownerFor(request); const params = z.object({ projectId: z.string() }).parse(request.params); db.deleteProject(owner.id, params.projectId); return { ok: true }; });
app.get(`${apiPrefix}/projects/:projectId/search`, async (request) => { const owner = ownerFor(request); const params = z.object({ projectId: z.string() }).parse(request.params); const query = z.object({ q: z.string().default("") }).parse(request.query); return db.searchProjectMessages(owner.id, params.projectId, query.q); });
app.post(`${apiPrefix}/project-references`, async (request) => { const owner = ownerFor(request); return db.createProjectReference(owner.id, createProjectReferenceRequestSchema.parse(request.body)); });
app.patch(`${apiPrefix}/project-references/:referenceId`, async (request) => { const owner = ownerFor(request); const params = z.object({ referenceId: z.string() }).parse(request.params); return db.updateProjectReference(owner.id, params.referenceId, updateProjectReferenceRequestSchema.parse(request.body)); });
app.delete(`${apiPrefix}/project-references/:referenceId`, async (request) => { const owner = ownerFor(request); const params = z.object({ referenceId: z.string() }).parse(request.params); db.deleteProjectReference(owner.id, params.referenceId); return { ok: true }; });
app.post(`${apiPrefix}/project-chat-references`, async (request) => { const owner = ownerFor(request); return db.createProjectChatReference(owner.id, createProjectChatReferenceRequestSchema.parse(request.body)); });
app.delete(`${apiPrefix}/project-chat-references/:referenceId`, async (request) => { const owner = ownerFor(request); const params = z.object({ referenceId: z.string() }).parse(request.params); db.deleteProjectChatReference(owner.id, params.referenceId); return { ok: true }; });
app.post(`${apiPrefix}/chats`, async (request) => db.createChat(ownerFor(request).id, createChatRequestSchema.parse(request.body)));
app.delete(`${apiPrefix}/chats/empty`, async (request) => { const owner = ownerFor(request); const query = z.object({ except: z.string().optional() }).parse(request.query); return { deletedChatIds: db.deleteEmptyChats(owner.id, query.except ?? null) }; });
app.patch(`${apiPrefix}/chats/:chatId`, async (request) => { const owner = ownerFor(request); const params = z.object({ chatId: z.string() }).parse(request.params); return db.updateChat(owner.id, params.chatId, updateChatRequestSchema.parse(request.body)); });
app.delete(`${apiPrefix}/chats/:chatId`, async (request) => { const owner = ownerFor(request); const params = z.object({ chatId: z.string() }).parse(request.params); db.deleteChat(owner.id, params.chatId); return { ok: true }; });
app.get(`${apiPrefix}/chats/:chatId/messages`, async (request) => { const owner = ownerFor(request); const params = z.object({ chatId: z.string() }).parse(request.params); db.getChat(owner.id, params.chatId); return db.listMessages(params.chatId); });
app.get(`${apiPrefix}/chats/:chatId/active-response`, async (request, reply) => { const owner = ownerFor(request); const params = z.object({ chatId: z.string() }).parse(request.params); db.getChat(owner.id, params.chatId); activeResponses.attach(params.chatId, reply); });
app.patch(`${apiPrefix}/chats/:chatId/active-response`, async (request) => { const owner = ownerFor(request); const params = z.object({ chatId: z.string() }).parse(request.params); db.getChat(owner.id, params.chatId); const body = z.object({ permissionMode: permissionModeSchema }).parse(request.body); return { active: activeResponses.setPermissionMode(params.chatId, body.permissionMode) }; });
app.delete(`${apiPrefix}/chats/:chatId/active-response`, async (request) => { const owner = ownerFor(request); const params = z.object({ chatId: z.string() }).parse(request.params); db.getChat(owner.id, params.chatId); return { cancelled: activeResponses.cancel(params.chatId) }; });
app.post(`${apiPrefix}/chats/:chatId/interactions/:interactionId`, async (request) => {
  const owner = ownerFor(request);
  const params = z.object({ chatId: z.string(), interactionId: z.string() }).parse(request.params);
  db.getChat(owner.id, params.chatId);
  const body = z.object({ action: z.string(), answer: z.string().optional(), wasFreeform: z.boolean().optional(), content: z.unknown().optional() }).parse(request.body);
  if (!activeResponses.resolveInteraction(params.chatId, params.interactionId, body)) throw new Error("Interaction is no longer pending.");
  return { ok: true };
});
app.post(`${apiPrefix}/chats/:chatId/active-response/input`, async (request) => {
  const owner = ownerFor(request);
  const params = z.object({ chatId: z.string() }).parse(request.params);
  db.getChat(owner.id, params.chatId);
  const input = activeResponseInputRequestSchema.parse(request.body);
  const pending = input.mode === "queue" ? activeResponses.enqueue(params.chatId, input) : await activeResponses.steer(params.chatId, input);
  if (!pending) throw new Error("No active response is available for this chat.");
  return pending;
});
app.post(`${apiPrefix}/chats/:chatId/messages`, async (request, reply) => {
  const owner = ownerFor(request);
  const params = z.object({ chatId: z.string() }).parse(request.params);
  const input = sendMessageRequestSchema.parse(request.body);
  const existing = db.getChat(owner.id, params.chatId);
  if (activeResponses.has(existing.id)) { activeResponses.attach(existing.id, reply); return; }
  const turn = await prepareChatTurn(owner.id, params.chatId, input);
  activeResponses.start({ db, provider, ownerId: owner.id, ...turn, prepareTurn: (queued) => prepareChatTurn(owner.id, params.chatId, queued) });
  activeResponses.attach(turn.chat.id, reply);
});
app.post(`${apiPrefix}/chats/:chatId/messages/:messageId/edit`, async (request, reply) => {
  const owner = ownerFor(request);
  const params = z.object({ chatId: z.string(), messageId: z.string() }).parse(request.params);
  const input = editMessageRequestSchema.parse(request.body);
  db.getChat(owner.id, params.chatId);
  activeResponses.cancel(params.chatId);
  const userMessage = db.editUserMessageAndTruncate(owner.id, params.chatId, params.messageId, input.content);
  const turn = await prepareChatTurn(owner.id, params.chatId, input, userMessage);
  activeResponses.start({ db, provider, ownerId: owner.id, ...turn, prepareTurn: (queued) => prepareChatTurn(owner.id, params.chatId, queued) });
  activeResponses.attach(turn.chat.id, reply);
});
app.post(`${apiPrefix}/chats/:chatId/messages/:messageId/retry`, async (request, reply) => {
  const owner = ownerFor(request);
  const params = z.object({ chatId: z.string(), messageId: z.string() }).parse(request.params);
  const input = sendMessageRequestSchema.omit({ content: true, projectId: true, workspaceId: true }).parse(request.body);
  db.getChat(owner.id, params.chatId);
  activeResponses.cancel(params.chatId);
  const userMessage = db.retryAssistantMessage(owner.id, params.chatId, params.messageId);
  const turn = await prepareChatTurn(owner.id, params.chatId, { ...input, content: userMessage.content }, userMessage);
  activeResponses.start({ db, provider, ownerId: owner.id, ...turn, prepareTurn: (queued) => prepareChatTurn(owner.id, params.chatId, queued) });
  activeResponses.attach(turn.chat.id, reply);
});
app.get(`${apiPrefix}/artifacts/:artifactId`, async (request) => { const owner = ownerFor(request); const params = z.object({ artifactId: z.string() }).parse(request.params); return db.getArtifact(owner.id, params.artifactId); });
app.post(`${apiPrefix}/artifacts`, async (request) => { const owner = ownerFor(request); const input = createArtifactRequestSchema.parse(request.body); if (input.chatId) { const chat = db.getChat(owner.id, input.chatId); const providerRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "", model: chat.model ?? undefined, reasoningEffort: chat.reasoningEffort ?? undefined }, defaultModel: config.copilotModel, gitHubToken: null, context: { isolatedWorkspaceRoot, allowStdioMcp: config.authMode !== "github" } }); const workspaceDir = providerRequest.workingDirectory ?? isolatedWorkspaceRoot; return (await writeFileArtifact({ db, ownerId: owner.id, chat, messageId: input.messageId ?? null, workspaceDir, artifact: { title: input.title, kind: input.kind, language: input.language ?? null, content: input.content } })).artifact; } return db.createArtifact(owner.id, input); });
app.patch(`${apiPrefix}/artifacts/:artifactId`, async (request) => { const owner = ownerFor(request); const params = z.object({ artifactId: z.string() }).parse(request.params); const input = updateArtifactRequestSchema.parse(request.body); const current = db.getArtifact(owner.id, params.artifactId); const artifact = db.updateArtifact(owner.id, params.artifactId, input); if (artifact.filePath && input.content !== undefined) { if (!artifact.chatId) throw new Error("File artifact is not attached to a chat."); const chat = db.getChat(owner.id, artifact.chatId); const providerRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "", model: chat.model ?? undefined, reasoningEffort: chat.reasoningEffort ?? undefined }, defaultModel: config.copilotModel, gitHubToken: null, context: { isolatedWorkspaceRoot, allowStdioMcp: config.authMode !== "github" } }); await writeExistingArtifactFile({ workspaceDir: providerRequest.workingDirectory ?? isolatedWorkspaceRoot, filePath: current.filePath ?? artifact.filePath, content: artifact.content }); } return artifact; });
app.delete(`${apiPrefix}/artifacts/:artifactId`, async (request) => { const owner = ownerFor(request); const params = z.object({ artifactId: z.string() }).parse(request.params); db.deleteArtifact(owner.id, params.artifactId); return { ok: true }; });
app.post(`${apiPrefix}/skills`, async (request) => { const owner = ownerFor(request); const body = z.object({ manifest: skillManifestSchema, projectId: z.string().nullable().optional() }).parse(request.body); return db.upsertSkill(owner.id, body.manifest, false, body.projectId ?? null); });
app.patch(`${apiPrefix}/skills/:skillId`, async (request) => { const owner = ownerFor(request); const params = z.object({ skillId: z.string() }).parse(request.params); return db.updateSkill(owner.id, params.skillId, updateSkillRequestSchema.parse(request.body)); });
app.delete(`${apiPrefix}/skills/:skillId`, async (request) => { const owner = ownerFor(request); const params = z.object({ skillId: z.string() }).parse(request.params); db.deleteSkill(owner.id, params.skillId); return { ok: true }; });
app.post(`${apiPrefix}/mcp-servers`, async (request) => { const owner = ownerFor(request); const body = z.object({ id: z.string().default(() => randomUUID()), name: z.string().min(1), transport: z.enum(["stdio", "http", "sse"]), command: z.string().nullable().optional(), args: z.array(z.string()).default([]), url: z.string().nullable().optional(), tools: z.array(z.string()).default([]), enabled: z.boolean().default(true), projectId: z.string().nullable().optional() }).parse(request.body); validateMcpTransportForMode(body.transport); return db.saveMcpServer(owner.id, { id: body.id, name: body.name, transport: body.transport, command: body.command ?? null, args: body.args, url: body.url ?? null, tools: body.tools, enabled: body.enabled, projectId: body.projectId ?? null }); });
app.patch(`${apiPrefix}/mcp-servers/:serverId`, async (request) => { const owner = ownerFor(request); const params = z.object({ serverId: z.string() }).parse(request.params); const input = updateMcpServerRequestSchema.parse(request.body); const current = db.getMcpServer(owner.id, params.serverId); validateMcpTransportForMode(input.transport ?? current.transport); return db.updateMcpServer(owner.id, params.serverId, input); });
app.delete(`${apiPrefix}/mcp-servers/:serverId`, async (request) => { const owner = ownerFor(request); const params = z.object({ serverId: z.string() }).parse(request.params); db.deleteMcpServer(owner.id, params.serverId); return { ok: true }; });
app.post(`${apiPrefix}/workspaces`, async (request) => { const owner = ownerFor(request); const input = registerWorkspaceRequestSchema.parse(request.body); const rootPath = await validateRegisteredWorkspaceRoot({ authMode: config.authMode, ownerId: owner.id, rootPath: input.rootPath, workspaceRoot: config.workspaceRoot }); return db.registerWorkspace(owner.id, { ...input, rootPath }); });
app.patch(`${apiPrefix}/workspaces/:workspaceId`, async (request) => { const owner = ownerFor(request); const params = z.object({ workspaceId: z.string() }).parse(request.params); return db.updateWorkspace(owner.id, params.workspaceId, updateWorkspaceRequestSchema.parse(request.body)); });
app.delete(`${apiPrefix}/workspaces/:workspaceId`, async (request) => { const owner = ownerFor(request); const params = z.object({ workspaceId: z.string() }).parse(request.params); db.deleteWorkspace(owner.id, params.workspaceId); return { ok: true }; });
app.post(`${apiPrefix}/workspaces/:workspaceId/commands`, async (request) => { const owner = ownerFor(request); const params = z.object({ workspaceId: z.string() }).parse(request.params); const input = runWorkspaceCommandRequestSchema.parse(request.body); const workspace = db.getWorkspace(owner.id, params.workspaceId); const toolRun = db.createToolRun(owner.id, { chatId: null, workspaceId: workspace.id, toolName: "workspace.command", input }); try { const output = await runWorkspaceCommand({ workspace, command: input.command, cwd: input.cwd, timeoutMs: input.timeoutMs }); return db.finishToolRun(toolRun.id, output.exitCode === 0 ? "succeeded" : "failed", output, null); } catch (error) { return db.finishToolRun(toolRun.id, "failed", {}, (error as Error).message); } });
app.post(`${apiPrefix}/imports/drafts`, async (request) => { const owner = ownerFor(request); return importDrafts.create(owner.id, importPreviewRequestSchema.parse(request.body)); });
app.post(`${apiPrefix}/imports/preview`, async (request) => { const input = importPreviewRequestSchema.parse(request.body); return slimImportPreview(await previewImportPayload(input.source, input.fileName, input.content, input.encoding)); });
app.post(`${apiPrefix}/imports/apply`, async (request) => { const owner = ownerFor(request); const input = importPreviewRequestSchema.parse(request.body); return applyImportPreview(db, owner.id, await previewImportPayload(input.source, input.fileName, input.content, input.encoding)); });
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(webDist)) { await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: false }); app.setNotFoundHandler((request, reply) => { if (request.raw.url?.startsWith(apiPrefix)) { reply.code(404).send({ error: "Not found" }); return; } reply.sendFile("index.html"); }); }
await app.listen({ host: config.host, port: config.port });
function isMutatingMethod(method: string): boolean { return method === "POST" || method === "PATCH" || method === "DELETE"; }
function isAuthExemptPath(rawUrl: string): boolean {
  const pathname = rawUrl.split("?")[0] ?? rawUrl;
  return pathname === `${apiPrefix}/health` || pathname === `${apiPrefix}/auth/status` || pathname === `${apiPrefix}/auth/logout` || pathname.startsWith(`${apiPrefix}/auth/github/`);
}
function ownerFor(request: FastifyRequest): Owner { return requestOwners.get(request) ?? db.getOwner(); }
function ownerForOptional(request: FastifyRequest): Owner | null {
  if (config.authMode !== "github") return db.getOwner();
  return readSessionOwner(request);
}
function readSessionOwner(request: FastifyRequest): Owner | null {
  const signed = readCookie(request, sessionCookieName);
  if (!signed) return null;
  const payload = verifySignedJson<{ ownerId: string; exp: number }>(signed);
  if (!payload || payload.exp < Date.now()) return null;
  try { return db.getOwnerById(payload.ownerId); } catch { return null; }
}
function signSession(owner: Owner): string { return signJson({ ownerId: owner.id, login: owner.login, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }); }
function signState(state: string): string { return signJson({ state, exp: Date.now() + 10 * 60 * 1000 }); }
function verifyState(value: string): string | null {
  const payload = verifySignedJson<{ state: string; exp: number }>(value);
  if (!payload || payload.exp < Date.now()) return null;
  return payload.state;
}
function signJson(value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}
function verifySignedJson<T>(value: string): T | null {
  const [payload, sig] = value.split(".");
  if (!payload || !sig || !safeEqual(sig, signature(payload))) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T; } catch { return null; }
}
function signature(payload: string): string { return createHmac("sha256", config.sessionSecret ?? "local-dev-session-secret").update(payload).digest("base64url"); }
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${cookieSecureSuffix()}`;
}
function clearCookie(name: string): string { return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureSuffix()}`; }
function cookieSecureSuffix(): string { return config.publicUrl?.startsWith("https://") ? "; Secure" : ""; }
function publicOrigin(request: FastifyRequest): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, "");
  if (config.authMode === "github" && config.githubClientSecret) throw new Error("COPILOTCHAT_PUBLIC_URL is required for GitHub OAuth web login.");
  const host = request.headers.host ?? `127.0.0.1:${config.port}`;
  return `http://${Array.isArray(host) ? host[0] : host}`;
}
function validateMcpTransportForMode(transport: "stdio" | "http" | "sse"): void {
  if (config.authMode === "github" && transport === "stdio") throw new Error("stdio MCP servers are disabled in GitHub auth mode.");
}
async function cachedProviderStatus(): Promise<ProviderStatus> {
  const now = Date.now();
  if (providerStatusCache && providerStatusCache.expiresAt > now) return providerStatusCache.status;
  refreshProviderStatus();
  return providerStatusCache?.status ?? loadingProviderStatus();
}
function refreshProviderStatus(): void {
  providerStatusInFlight ??= provider.status().then((status) => {
    providerStatusCache = { status, expiresAt: Date.now() + providerStatusTtlMs };
    return status;
  }).finally(() => { providerStatusInFlight = null; });
}
function loadingProviderStatus(): ProviderStatus { return { id: "unknown", label: "Loading", available: false, details: "Checking Copilot provider status.", capabilities: [], models: [], defaultModel: config.copilotModel }; }
function validateMessageAttachments(input: SendMessageRequest): MessageAttachment[] {
  const attachments = input.attachments ?? [];
  if (!input.content.trim() && attachments.length === 0) throw new Error("Message requires text or an attachment.");
  for (const attachment of attachments) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data)) throw new Error(`Attachment ${attachment.name} is not valid base64.`);
    const decodedBytes = Buffer.byteLength(Buffer.from(attachment.data, "base64"));
    if (decodedBytes !== attachment.size) throw new Error(`Attachment ${attachment.name} size does not match its content.`);
  }
  return attachments;
}
function attachImportGuidance(ownerId: string, input: SendMessageRequest, providerRequest: ProviderChatRequest): void {
  const hasImportDraft = providerRequest.messages.some((message) => /Import draft ID:/i.test(message.content));
  const hasImportSkill = providerRequest.skills?.some((skill) => skill.id === "import-assistant") || input.skillIds?.some((id) => id.endsWith(":import-assistant") || id === "import-assistant");
  if (!hasImportDraft && !hasImportSkill) return;
  const importSkill = db.listSkills(ownerId).find((skill) => skill.manifest.id === "import-assistant" && skill.enabled);
  if (hasImportDraft && importSkill && !providerRequest.skills?.some((skill) => skill.id === importSkill.manifest.id)) providerRequest.skills = [...(providerRequest.skills ?? []), importSkill.manifest];
  const existingToolNames = new Set((providerRequest.tools ?? []).map((tool) => tool.name));
  providerRequest.tools = [...(providerRequest.tools ?? []), ...buildImportTools({ db, ownerId, drafts: importDrafts }).filter((tool) => !existingToolNames.has(tool.name))];
}
function slimImportPreview(preview: ImportPreview): ImportPreview {
  return {
    ...preview,
    conversations: preview.conversations.map((conversation) => ({ ...conversation, messages: [], artifacts: [], reusableHelpers: [] })),
    projects: preview.projects.map((project) => ({ ...project, references: project.references.map((reference) => ({ ...reference, content: previewText(reference.content) })) })),
  };
}
function previewText(value: string): string {
  return value.length > 800 ? `${value.slice(0, 800)}\n\n[preview truncated ${value.length - 800} characters]` : value;
}
