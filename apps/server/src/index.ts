import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { previewImportPayload } from "@copilotchat/importers";
import { createCopilotProvider } from "@copilotchat/provider";
import type { ProviderChatRequest } from "@copilotchat/provider";
import { activeResponseInputRequestSchema, apiPrefix, createArtifactRequestSchema, createChatRequestSchema, createProjectChatReferenceRequestSchema, createProjectReferenceRequestSchema, createProjectRequestSchema, editMessageRequestSchema, importPreviewRequestSchema, permissionModeSchema, registerWorkspaceRequestSchema, runWorkspaceCommandRequestSchema, sendMessageRequestSchema, skillManifestSchema, titleFromContent, updateArtifactRequestSchema, updateChatRequestSchema, updateMcpServerRequestSchema, updateProjectReferenceRequestSchema, updateProjectRequestSchema, updateSkillRequestSchema, updateWorkspaceRequestSchema } from "@copilotchat/shared";
import type { Chat, ChatMessage, ImportPreview, Owner, ProviderStatus, SendMessageRequest } from "@copilotchat/shared";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { artifactSystemContext, syncArtifactFiles, writeExistingArtifactFile, writeFileArtifact } from "./artifact-files.js";
import { chatAttachmentDirectory, forgetValidatedAttachmentFiles, forgetValidatedAttachmentTree, isChatAttachmentDirectory, materializeMessageAttachments, reconcileAttachmentFiles, relocateChatAttachments } from "./attachment-files.js";
import { applyChatTurnScope, buildProviderChatRequest, chatWorkingDirectory } from "./chat-context.js";
import { isGitHubLoginAllowed, loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { applyImportPreview } from "./import-apply.js";
import { assertImportPayloadSize, ImportDraftStore, ImportLimitError } from "./import-drafts.js";
import { buildImportTools } from "./import-tools.js";
import { ProviderStatusCache } from "./provider-status-cache.js";
import { ActiveChatResponses } from "./responses.js";
import type { InternalSendMessageRequest } from "./responses.js";
import { ownerWorkspaceDirectory, runWorkspaceCommand, validateRegisteredWorkspaceRoot } from "./workspace.js";
import { isAllowedCorsOrigin } from "./cors-origin.js";
import { UploadLimitError, UploadedFileStore, UploadValidationError } from "./uploaded-files.js";

class OwnerClearingError extends Error {}
class OwnerMutationBarrier {
  private readonly clearing = new Set<string>();
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();

  begin(ownerId: string): () => void {
    if (this.clearing.has(ownerId)) throw new OwnerClearingError("Owner data is currently being cleared.");
    this.active.set(ownerId, (this.active.get(ownerId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = Math.max(0, (this.active.get(ownerId) ?? 1) - 1);
      if (next > 0) { this.active.set(ownerId, next); return; }
      this.active.delete(ownerId);
      const ownerWaiters = this.waiters.get(ownerId);
      this.waiters.delete(ownerId);
      for (const resolve of ownerWaiters ?? []) resolve();
    };
  }

  async clear<T>(ownerId: string, action: () => Promise<T>): Promise<T> {
    if (this.clearing.has(ownerId)) throw new OwnerClearingError("Owner data is already being cleared.");
    this.clearing.add(ownerId);
    if (this.active.has(ownerId)) await new Promise<void>((resolve) => { const ownerWaiters = this.waiters.get(ownerId) ?? new Set<() => void>(); ownerWaiters.add(resolve); this.waiters.set(ownerId, ownerWaiters); });
    try {
      return await action();
    } finally {
      this.clearing.delete(ownerId);
    }
  }
}

const config = loadConfig();
if (config.authMode === "github" && !config.sessionSecret) throw new Error("COPILOTCHAT_SESSION_SECRET is required when COPILOTCHAT_AUTH_MODE=github.");
if (config.authMode === "github" && config.githubClientSecret && !config.publicUrl) throw new Error("COPILOTCHAT_PUBLIC_URL is required for GitHub OAuth web login.");
const db = new AppDatabase(config.dataDir);
const isolatedWorkspaceRoot = path.join(config.dataDir, "isolated-workspaces");
const importDrafts = new ImportDraftStore(path.join(config.dataDir, "import-drafts"), config.importLimitBytes, config.importDraftLimitBytes);
const uploadedFiles = new UploadedFileStore(path.join(config.dataDir, "uploads"), config.uploadLimitBytes, config.stagedUploadLimitBytes, config.stagedUploadLimitFiles);
fs.mkdirSync(isolatedWorkspaceRoot, { recursive: true });
await importDrafts.cleanupOrphans();
const provider = createConfiguredProvider(config.authMode === "local" ? config.copilotGitHubToken : undefined);
const activeResponses = new ActiveChatResponses();
const app = Fastify({ logger: true, bodyLimit: config.bodyLimitBytes });
await reconcileAttachmentFiles({ db, isolatedWorkspaceRoot, onError: (workspaceRoot, error) => app.log.warn({ err: error, workspaceRoot }, "Could not reconcile workspace attachments.") });
await uploadedFiles.cleanupExpired();
const uploadCleanupTimer = setInterval(() => { void uploadedFiles.cleanupExpired().catch((error) => app.log.error({ err: error }, "Could not clean expired uploads.")); }, 60 * 60 * 1000);
uploadCleanupTimer.unref();
const requestOwners = new WeakMap<FastifyRequest, Owner>();
const requestMutationReleases = new WeakMap<FastifyRequest, () => void>();
const ownerMutations = new OwnerMutationBarrier();
const sessionCookieName = "copilotchat_session";
const oauthStateCookieName = "copilotchat_oauth_state";
const providerStatusTtlMs = 5 * 60_000;
const providerStatuses = new ProviderStatusCache(providerStatusTtlMs);
const configuredPublicOrigin = config.publicUrl ? new URL(config.publicUrl).origin : null;
const allowedOrigins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, "http://127.0.0.1:5173", "http://localhost:5173", ...(configuredPublicOrigin ? [configuredPublicOrigin] : []), ...config.allowedOrigins]);
app.addContentTypeParser("application/x-copilotchat-upload", (_request, payload, done) => done(null, payload));
await app.register(cors, {
  delegator: (request, callback) => {
    const origin = request.headers.origin;
    if (isAllowedCorsOrigin(origin, request.headers.host, allowedOrigins)) {
      callback(null, { origin: Boolean(origin), credentials: false });
      return;
    }
    callback(new Error(`Origin not allowed: ${origin}`));
  },
});
app.addHook("preHandler", async (request, reply) => {
  if (!request.raw.url?.startsWith(apiPrefix)) return;
  if (config.authMode === "github" && isGitHubDevicePath(request.raw.url)) { reply.code(404).send({ error: "Not found" }); return; }
  const bearerOk = Boolean(config.apiToken && request.headers.authorization === `Bearer ${config.apiToken}`);
  if (config.authMode === "github" && !isAuthExemptPath(request.raw.url)) {
    const owner = readSessionOwner(request);
    if (!owner) { reply.code(401).send({ error: "Login required", loginUrl: `${apiPrefix}/auth/github/login` }); return; }
    requestOwners.set(request, owner);
  } else if (config.apiToken && !bearerOk && config.authMode !== "github") {
    reply.code(401).send({ error: "Unauthorized" }); return;
  }
  const mutating = isMutatingMethod(request.method);
  const authExempt = isAuthExemptPath(request.raw.url);
  if (config.requireCsrf && mutating && !authExempt && request.headers["x-copilotchat-csrf"] !== "1") { reply.code(403).send({ error: "Missing X-CopilotChat-CSRF header." }); return; }
  if (!mutating || authExempt || isDataClearPath(request.raw.url)) return;
  try {
    requestMutationReleases.set(request, ownerMutations.begin(ownerFor(request).id));
  } catch (error) {
    if (error instanceof OwnerClearingError) { reply.code(409).send({ error: error.message }); return; }
    throw error;
  }
});
app.addHook("onSend", async (request, _reply, payload) => { releaseRequestMutation(request); return payload; });
app.addHook("onError", async (request) => releaseRequestMutation(request));
const githubDeviceStartResponseSchema = z.object({ device_code: z.string(), user_code: z.string(), verification_uri: z.string(), expires_in: z.number(), interval: z.number() });
const githubDevicePollResponseSchema = z.union([z.object({ access_token: z.string(), token_type: z.string(), scope: z.string() }), z.object({ error: z.string(), error_description: z.string().optional() })]);
const githubUserSchema = z.object({ id: z.number().int().positive(), login: z.string(), name: z.string().nullable(), avatar_url: z.string().nullable() });
type GitHubUser = z.infer<typeof githubUserSchema>;
async function prepareChatTurn(ownerId: string, chatId: string, input: InternalSendMessageRequest, existingUserMessage?: ChatMessage): Promise<{ chat: Chat; userMessage: ChatMessage; providerRequest: ReturnType<typeof buildProviderChatRequest> }> {
  const gitHubToken = gitHubTokenForOwner(ownerId);
  if (config.authMode === "github" && !gitHubToken) throw new Error("GitHub authentication has expired. Sign in with GitHub again.");
  let chat = applyChatTurnScope(db, ownerId, chatId, input);
  if (input.model !== undefined || input.reasoningEffort !== undefined || input.contextTier !== undefined) chat = db.updateChat(ownerId, chat.id, { model: input.model ?? chat.model, reasoningEffort: input.reasoningEffort ?? chat.reasoningEffort, contextTier: input.contextTier ?? chat.contextTier });
  const workspaceDir = chatWorkingDirectory(db, ownerId, chat, isolatedWorkspaceRoot);
  await fs.promises.mkdir(workspaceDir, { recursive: true });
  await relocateChatAttachments({ db, ownerId, chatId: chat.id, workspaceDir, onMissing: (attachment) => app.log.warn({ chatId: chat.id, attachmentId: attachment.id }, "Attachment file is missing; removing its file reference.") });
  const materialized = await materializeMessageAttachments({ uploads: uploadedFiles, ownerId, chatId: chat.id, workspaceDir, maxBytes: config.uploadLimitBytes, uploadClaimId: input.uploadClaimId, attachments: input.attachments });
  const attachments = materialized.attachments;
  let filesPersisted = materialized.createdFilePaths.length === 0;
  let addedUserMessage: ChatMessage | null = null;
  try {
    if (!input.content.trim() && attachments.length === 0) throw new Error("Message requires text or an attachment.");
    const titleRequired = db.listMessages(chat.id).filter((message) => message.role === "user").length + (existingUserMessage ? 0 : 1) <= 1;
    const providerRequest = buildProviderChatRequest({ db, ownerId, chat, message: input, pendingUserMessage: existingUserMessage ? undefined : { content: input.content, attachments }, messageOverride: existingUserMessage && input.attachments !== undefined ? { id: existingUserMessage.id, content: input.content, attachments } : undefined, defaultModel: config.copilotModel, gitHubToken, context: { isolatedWorkspaceRoot, allowStdioMcp: config.authMode !== "github" }, titleTool: chat.titleManuallySet ? undefined : { currentTitle: chat.title, required: titleRequired, setTitle: async (title) => { const current = db.getChat(ownerId, chat.id); if (current.titleManuallySet) return current.title; return db.updateChatTitle(ownerId, chat.id, title, "auto").title; } } });
    attachImportGuidance(ownerId, input, providerRequest);
    providerRequest.artifactContext = artifactSystemContext(await syncArtifactFiles({ db, ownerId, chat, workspaceDir: providerRequest.workingDirectory ?? isolatedWorkspaceRoot }));
    const userMessage = existingUserMessage ?? db.addMessage({ chatId: chat.id, role: "user", content: input.content });
    if (!existingUserMessage) addedUserMessage = userMessage;
    if ((!existingUserMessage && attachments.length > 0) || (existingUserMessage && input.attachments !== undefined)) {
      db.replaceMessageAttachments(ownerId, chat.id, userMessage.id, attachments);
      filesPersisted = true;
    }
    if (!existingUserMessage && !chat.titleManuallySet && (chat.title === "New chat" || chat.title === "Untitled chat")) chat = db.updateChatTitle(ownerId, chat.id, input.content.trim() ? titleFromContent(input.content) : titleFromContent(attachments.map((attachment) => attachment.name).join(" ")), "auto");
    await completeUploadClaim(ownerId, input.uploadClaimId);
    return { chat, userMessage, providerRequest: { ...providerRequest, reasoningEffort: providerRequest.reasoningEffort ?? "default" } };
  } catch (error) {
    if (addedUserMessage) db.deleteMessage(ownerId, chat.id, addedUserMessage.id);
    if (addedUserMessage || !filesPersisted) await removeTemporaryAttachmentFiles(materialized.createdFilePaths);
    throw error;
  }
}
app.get(`${apiPrefix}/health`, async () => ({ ok: true, name: "CopilotChat", time: new Date().toISOString() }));
app.get(`${apiPrefix}/auth/status`, async (request) => { const owner = ownerForOptional(request); const storedOAuth = Boolean(owner && db.hasGitHubAuth(owner.id)); const configuredToken = config.authMode === "local" && Boolean(config.copilotGitHubToken); return { mode: config.authMode, owner, authenticated: Boolean(owner), githubOAuthConfigured: Boolean(config.githubClientId && config.githubClientSecret), githubAuthenticated: storedOAuth || configuredToken, workspaceDirectory: config.authMode === "github" && owner ? ownerWorkspaceDirectory(owner.id) : null, apiTokenRequired: config.authMode === "local" && Boolean(config.apiToken), copilotTokenSource: storedOAuth ? "github-oauth" : configuredToken ? config.copilotGitHubTokenSource ?? null : null, copilotCliPath: config.copilotSdkCliPath ?? null }; });
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
  const githubUser = await fetchGitHubUser(token.access_token);
  if (!isGitHubLoginAllowed(config.allowedGitHubLogins, githubUser.login)) {
    reply.header("Set-Cookie", clearCookie(oauthStateCookieName));
    reply.code(403).send({ error: "This GitHub account is not allowed to access this CopilotChat instance." });
    return;
  }
  const providerUserId = String(githubUser.id);
  const legacyOwnerId = db.getGitHubOwnerByProviderId(providerUserId) ? null : await verifiedLegacyGitHubOwnerId(request, githubUser);
  const owner = db.getOrCreateGitHubOwner({ providerUserId, login: githubUser.login, displayName: githubUser.name, avatarUrl: githubUser.avatar_url, legacyOwnerId });
  db.setGitHubAuth(owner.id, { accessToken: token.access_token, login: githubUser.login, displayName: githubUser.name, avatarUrl: githubUser.avatar_url });
  providerStatuses.invalidate(owner.id);
  reply.header("Set-Cookie", [cookie(sessionCookieName, signSession(owner), 60 * 60 * 24 * 30), clearCookie(oauthStateCookieName)]);
  reply.redirect("/");
});
app.post(`${apiPrefix}/auth/logout`, async (_request, reply) => { reply.header("Set-Cookie", clearCookie(sessionCookieName)); return { ok: true }; });
app.post(`${apiPrefix}/auth/github/device/start`, async () => { if (!config.githubClientId) throw new Error("GITHUB_CLIENT_ID is required for GitHub OAuth device flow."); const response = await fetch("https://github.com/login/device/code", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: config.githubClientId, scope: "read:user" }) }); if (!response.ok) throw new Error(`GitHub device flow failed: ${response.status} ${await response.text()}`); return githubDeviceStartResponseSchema.parse(await response.json()); });
app.post(`${apiPrefix}/auth/github/device/poll`, async (request) => { if (!config.githubClientId) throw new Error("GITHUB_CLIENT_ID is required for GitHub OAuth device flow."); const body = z.object({ deviceCode: z.string().min(1) }).parse(request.body); const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: config.githubClientId, device_code: body.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) }); if (!response.ok) throw new Error(`GitHub token exchange failed: ${response.status} ${await response.text()}`); const tokenResponse = githubDevicePollResponseSchema.parse(await response.json()); if ("error" in tokenResponse) { if (tokenResponse.error === "authorization_pending" || tokenResponse.error === "slow_down") return { status: tokenResponse.error }; throw new Error(tokenResponse.error_description ?? tokenResponse.error); } const userResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${tokenResponse.access_token}`, "X-GitHub-Api-Version": "2022-11-28" } }); if (!userResponse.ok) throw new Error(`GitHub user lookup failed: ${userResponse.status} ${await userResponse.text()}`); const githubUser = githubUserSchema.parse(await userResponse.json()); return { status: "authenticated", owner: db.setGitHubAuth({ accessToken: tokenResponse.access_token, login: githubUser.login, displayName: githubUser.name, avatarUrl: githubUser.avatar_url }) }; });
app.get(`${apiPrefix}/state`, async (request) => {
  const owner = ownerFor(request);
  const state = db.getState(await cachedProviderStatus(owner.id), [], owner.id, config.authMode);
  const chatIds = new Set([...state.chats, ...state.archivedChats].map((chat) => chat.id));
  return { ...state, activeChatIds: activeResponses.chatIds().filter((id) => chatIds.has(id)) };
});
app.post(`${apiPrefix}/provider/refresh`, async (request) => {
  const owner = ownerFor(request);
  const body = z.object({ force: z.boolean().optional().default(false) }).parse(request.body ?? {});
  return freshProviderStatus(owner.id, body.force);
});
app.delete(`${apiPrefix}/data`, async (request, reply) => {
  const owner = ownerFor(request);
  try {
    await ownerMutations.clear(owner.id, async () => {
      await activeResponses.cancelOwnerAndWait(owner.id);
      const chats = [...db.listChats(owner.id), ...db.listArchivedChats(owner.id)];
      const chatFileTargets = chats.flatMap((chat) => chatFiles(owner.id, chat));
      await uploadedFiles.clearOwner(owner.id, () => importDrafts.clearOwner(owner.id, async () => {
        db.clearAllData(owner.id);
        await Promise.all(chatFileTargets.map(async (target) => { forgetValidatedAttachmentTree(target); await fs.promises.rm(target, { recursive: true, force: true }); }));
        await fs.promises.mkdir(isolatedWorkspaceRoot, { recursive: true });
      }));
    });
  } catch (error) {
    if (error instanceof OwnerClearingError) { reply.code(409).send({ error: error.message }); return; }
    throw error;
  }
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
app.delete(`${apiPrefix}/chats/empty`, async (request) => { const owner = ownerFor(request); const query = z.object({ except: z.string().optional() }).parse(request.query); const chats = db.listChats(owner.id); const filesByChat = new Map(chats.map((chat) => [chat.id, chatFiles(owner.id, chat)])); const deletedChatIds = db.deleteEmptyChats(owner.id, query.except ?? null); await Promise.all(deletedChatIds.flatMap((chatId) => filesByChat.get(chatId) ?? []).map(async (target) => { forgetValidatedAttachmentTree(target); await fs.promises.rm(target, { recursive: true, force: true }); })); return { deletedChatIds }; });
app.patch(`${apiPrefix}/chats/:chatId`, async (request) => { const owner = ownerFor(request); const params = z.object({ chatId: z.string() }).parse(request.params); return db.updateChat(owner.id, params.chatId, updateChatRequestSchema.parse(request.body)); });
app.delete(`${apiPrefix}/chats/:chatId`, async (request, reply) => { const owner = ownerFor(request); const params = z.object({ chatId: z.string() }).parse(request.params); const chat = db.getChat(owner.id, params.chatId); if (!activeResponses.beginDeletion(chat.id)) { reply.code(409).send({ error: "The chat is currently being prepared or deleted." }); return; } try { await activeResponses.cancelAndWait(chat.id); await removeChatFiles(owner.id, chat); db.deleteChat(owner.id, params.chatId); return { ok: true }; } finally { activeResponses.endDeletion(chat.id); } });
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
  const chat = db.getChat(owner.id, params.chatId);
  if (!activeResponses.has(chat.id)) throw new Error("No active response is available for this chat.");
  const input = activeResponseInputRequestSchema.parse(request.body);
  if (input.mode === "queue") {
    const claimedInput = await claimRequestUploads(owner.id, input);
    const pending = activeResponses.enqueue(params.chatId, claimedInput, uploadClaimResources(owner.id, claimedInput.uploadClaimId));
    if (!pending) {
      abandonUploadClaim(owner.id, claimedInput.uploadClaimId);
      throw new Error("No active response is available for this chat.");
    }
    return pending;
  }
  const workspaceDir = chatWorkingDirectory(db, owner.id, chat, isolatedWorkspaceRoot);
  await relocateChatAttachments({ db, ownerId: owner.id, chatId: chat.id, workspaceDir, onMissing: (attachment) => app.log.warn({ chatId: chat.id, attachmentId: attachment.id }, "Attachment file is missing or invalid; removing its file reference.") });
  const claimedInput = await claimRequestUploads(owner.id, input);
  let materialized;
  try {
    materialized = await materializeMessageAttachments({ uploads: uploadedFiles, ownerId: owner.id, chatId: chat.id, workspaceDir, maxBytes: config.uploadLimitBytes, uploadClaimId: claimedInput.uploadClaimId, attachments: claimedInput.attachments });
  } catch (error) {
    abandonUploadClaim(owner.id, claimedInput.uploadClaimId);
    throw error;
  }
  const attachments = materialized.attachments;
  if (!claimedInput.content.trim() && attachments.length === 0) {
    abandonUploadClaim(owner.id, claimedInput.uploadClaimId);
    throw new Error("Message requires text or an attachment.");
  }
  const resolvedInput = { ...claimedInput, attachments };
  let steerResult: Awaited<ReturnType<typeof activeResponses.steer>>;
  try {
    steerResult = await activeResponses.steer(params.chatId, resolvedInput, { temporaryFiles: materialized.createdFilePaths, cleanup: uploadClaimCleanup(owner.id, claimedInput.uploadClaimId) });
  } catch (error) {
    await removeTemporaryAttachmentFiles(materialized.createdFilePaths);
    abandonUploadClaim(owner.id, claimedInput.uploadClaimId);
    throw error;
  }
  if (!steerResult) {
    await removeTemporaryAttachmentFiles(materialized.createdFilePaths);
    abandonUploadClaim(owner.id, claimedInput.uploadClaimId);
    throw new Error("No active response is available for this chat.");
  }
  if (!steerResult.delivered) {
    await removeTemporaryAttachmentFiles(materialized.createdFilePaths);
    const pending = activeResponses.enqueue(params.chatId, claimedInput, uploadClaimResources(owner.id, claimedInput.uploadClaimId));
    if (!pending) {
      abandonUploadClaim(owner.id, claimedInput.uploadClaimId);
      throw new Error("No active response is available for this chat.");
    }
    return pending;
  }
  await completeUploadClaim(owner.id, claimedInput.uploadClaimId);
  return steerResult.turn!;
});
app.post(`${apiPrefix}/chats/:chatId/messages`, async (request, reply) => {
  const owner = ownerFor(request);
  const params = z.object({ chatId: z.string() }).parse(request.params);
  const input = sendMessageRequestSchema.parse(request.body);
  const existing = db.getChat(owner.id, params.chatId);
  if (!activeResponses.reserve(existing.id)) { reply.code(409).send({ error: "A response is already active or being prepared. Use the active-response input endpoint to steer or queue another message." }); return; }
  let turn: Awaited<ReturnType<typeof prepareChatTurn>>;
  try {
    turn = await withUploadClaim(owner.id, input, (claimedInput) => prepareChatTurn(owner.id, params.chatId, claimedInput));
  } catch (error) {
    activeResponses.releaseReservation(existing.id);
    throw error;
  }
  activeResponses.start({ db, provider, ownerId: owner.id, ...turn, prepareTurn: (queued) => prepareChatTurn(owner.id, params.chatId, queued) });
  releaseRequestMutation(request);
  activeResponses.attach(turn.chat.id, reply);
});
app.post(`${apiPrefix}/chats/:chatId/messages/:messageId/edit`, async (request, reply) => {
  const owner = ownerFor(request);
  const params = z.object({ chatId: z.string(), messageId: z.string() }).parse(request.params);
  const input = editMessageRequestSchema.parse(request.body);
  db.getChat(owner.id, params.chatId);
  await activeResponses.cancelAndWait(params.chatId);
  if (!activeResponses.reserve(params.chatId)) { reply.code(409).send({ error: "A response is already being prepared for this chat." }); return; }
  let turn: Awaited<ReturnType<typeof prepareChatTurn>>;
  try {
    turn = await withAttachmentCleanup(owner.id, params.chatId, async () => {
      return withUploadClaim(owner.id, input, async (claimedInput) => {
        const userMessage = db.editUserMessageAndTruncate(owner.id, params.chatId, params.messageId, input.content);
        return prepareChatTurn(owner.id, params.chatId, claimedInput, userMessage);
      });
    });
  } catch (error) {
    activeResponses.releaseReservation(params.chatId);
    throw error;
  }
  activeResponses.start({ db, provider, ownerId: owner.id, ...turn, prepareTurn: (queued) => prepareChatTurn(owner.id, params.chatId, queued) });
  releaseRequestMutation(request);
  activeResponses.attach(turn.chat.id, reply);
});
app.post(`${apiPrefix}/chats/:chatId/messages/:messageId/retry`, async (request, reply) => {
  const owner = ownerFor(request);
  const params = z.object({ chatId: z.string(), messageId: z.string() }).parse(request.params);
  const input = sendMessageRequestSchema.omit({ content: true, projectId: true, workspaceId: true }).parse(request.body);
  db.getChat(owner.id, params.chatId);
  await activeResponses.cancelAndWait(params.chatId);
  if (!activeResponses.reserve(params.chatId)) { reply.code(409).send({ error: "A response is already being prepared for this chat." }); return; }
  let turn: Awaited<ReturnType<typeof prepareChatTurn>>;
  try {
    turn = await withAttachmentCleanup(owner.id, params.chatId, async () => {
      return withUploadClaim(owner.id, { ...input, content: "" }, async (claimedInput) => {
        const userMessage = db.retryAssistantMessage(owner.id, params.chatId, params.messageId);
        return prepareChatTurn(owner.id, params.chatId, { ...claimedInput, content: userMessage.content }, userMessage);
      });
    });
  } catch (error) {
    activeResponses.releaseReservation(params.chatId);
    throw error;
  }
  activeResponses.start({ db, provider, ownerId: owner.id, ...turn, prepareTurn: (queued) => prepareChatTurn(owner.id, params.chatId, queued) });
  releaseRequestMutation(request);
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
app.post(`${apiPrefix}/uploads`, { bodyLimit: config.uploadLimitBytes }, async (request, reply) => {
  const owner = ownerFor(request);
  const parsed = z.object({ fileName: z.string().min(1).max(1024), mimeType: z.string().min(1).max(255).default("application/octet-stream"), size: z.coerce.number().int().nonnegative().max(config.uploadLimitBytes) }).safeParse(request.query);
  if (!parsed.success) {
    const tooLarge = parsed.error.issues.some((issue) => issue.path[0] === "size" && issue.code === "too_big");
    reply.code(tooLarge ? 413 : 400).send({ error: parsed.error.issues[0]?.message ?? "Invalid upload metadata." });
    return;
  }
  if (!(request.body instanceof Readable)) { reply.code(400).send({ error: "Upload body must be a binary stream." }); return; }
  try {
    return await uploadedFiles.create(owner.id, parsed.data, request.body);
  } catch (error) {
    if (error instanceof UploadLimitError) { reply.code(413).send({ error: error.message }); return; }
    if (error instanceof UploadValidationError) { reply.code(400).send({ error: error.message }); return; }
    throw error;
  }
});
app.delete(`${apiPrefix}/uploads/:uploadId`, async (request) => { const owner = ownerFor(request); const params = z.object({ uploadId: z.string().min(1) }).parse(request.params); await uploadedFiles.delete(owner.id, params.uploadId); return { ok: true }; });
app.post(`${apiPrefix}/imports/drafts`, async (request, reply) => {
  const owner = ownerFor(request);
  let claimId: string | null = null;
  try {
    const uploaded = z.object({ source: z.enum(["chatgpt", "claude", "gemini", "auto"]).default("auto"), uploadId: z.string().min(1) }).safeParse(request.body);
    if (!uploaded.success) return await importDrafts.create(owner.id, importPreviewRequestSchema.parse(request.body));
    claimId = await uploadedFiles.claim(owner.id, [uploaded.data.uploadId]);
    const draft = await importDrafts.createFromUpload(owner.id, uploaded.data.source, uploadedFiles, uploaded.data.uploadId, claimId!);
    await completeUploadClaim(owner.id, claimId);
    return draft;
  } catch (error) {
    abandonUploadClaim(owner.id, claimId);
    if (error instanceof ImportLimitError) { reply.code(413).send({ error: error.message }); return; }
    throw error;
  }
});
app.post(`${apiPrefix}/imports/preview`, async (request, reply) => { try { const input = importPreviewRequestSchema.parse(request.body); assertImportPayloadSize(input, config.importLimitBytes); return slimImportPreview(await previewImportPayload(input.source, input.fileName, input.content, input.encoding)); } catch (error) { if (error instanceof ImportLimitError) { reply.code(413).send({ error: error.message }); return; } throw error; } });
app.post(`${apiPrefix}/imports/apply`, async (request, reply) => { const owner = ownerFor(request); try { const input = importPreviewRequestSchema.parse(request.body); assertImportPayloadSize(input, config.importLimitBytes); return applyImportPreview(db, owner.id, await previewImportPayload(input.source, input.fileName, input.content, input.encoding)); } catch (error) { if (error instanceof ImportLimitError) { reply.code(413).send({ error: error.message }); return; } throw error; } });
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(webDist)) { await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: false }); app.setNotFoundHandler((request, reply) => { if (request.raw.url?.startsWith(apiPrefix)) { reply.code(404).send({ error: "Not found" }); return; } reply.sendFile("index.html"); }); }
await app.listen({ host: config.host, port: config.port });
function isMutatingMethod(method: string): boolean { return method === "POST" || method === "PATCH" || method === "DELETE"; }
function isDataClearPath(rawUrl: string): boolean { return (rawUrl.split("?")[0] ?? rawUrl) === `${apiPrefix}/data`; }
function releaseRequestMutation(request: FastifyRequest): void { const release = requestMutationReleases.get(request); if (!release) return; requestMutationReleases.delete(request); release(); }
function isAuthExemptPath(rawUrl: string): boolean {
  const pathname = rawUrl.split("?")[0] ?? rawUrl;
  return pathname === `${apiPrefix}/health` || pathname === `${apiPrefix}/auth/status` || pathname === `${apiPrefix}/auth/logout` || pathname.startsWith(`${apiPrefix}/auth/github/`);
}
function isGitHubDevicePath(rawUrl: string): boolean { return (rawUrl.split("?")[0] ?? rawUrl).startsWith(`${apiPrefix}/auth/github/device/`); }
function ownerFor(request: FastifyRequest): Owner { return requestOwners.get(request) ?? db.getOwner(); }
function ownerForOptional(request: FastifyRequest): Owner | null {
  if (config.authMode !== "github") return db.getOwner();
  return readSessionOwner(request);
}
function readSessionOwner(request: FastifyRequest): Owner | null {
  const owner = readSignedSessionOwner(request);
  return owner && isGitHubLoginAllowed(config.allowedGitHubLogins, owner.login) ? owner : null;
}
function readSignedSessionOwner(request: FastifyRequest): Owner | null {
  const signed = readCookie(request, sessionCookieName);
  if (!signed) return null;
  const payload = verifySignedJson<{ ownerId: string; exp: number }>(signed);
  if (!payload || payload.exp < Date.now()) return null;
  try { return db.getOwnerById(payload.ownerId); } catch { return null; }
}
async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}`, "X-GitHub-Api-Version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub user lookup failed: ${response.status} ${await response.text()}`);
  return githubUserSchema.parse(await response.json());
}
async function verifiedLegacyGitHubOwnerId(request: FastifyRequest, githubUser: GitHubUser): Promise<string | null> {
  const signedOwner = readSignedSessionOwner(request);
  const sessionLegacy = signedOwner ? db.getLegacyGitHubOwnerById(signedOwner.id) : null;
  const loginLegacy = db.getLegacyGitHubOwnerByLogin(githubUser.login);
  const candidates = Array.from(new Map([sessionLegacy, loginLegacy].filter((owner): owner is Owner => Boolean(owner)).map((owner) => [owner.id, owner])).values());
  for (const legacyOwner of candidates) {
    if (sessionLegacy?.id === legacyOwner.id && legacyOwner.login.toLowerCase() === githubUser.login.toLowerCase()) return legacyOwner.id;
    const legacyToken = db.getGitHubToken(legacyOwner.id);
    if (!legacyToken) continue;
    try {
      const legacyUser = await fetchGitHubUser(legacyToken);
      if (legacyUser.id === githubUser.id) return legacyOwner.id;
      app.log.warn({ legacyOwnerId: legacyOwner.id }, "Refused to migrate a legacy GitHub owner because its stored token belongs to another account.");
    } catch (error) {
      app.log.warn({ err: error, legacyOwnerId: legacyOwner.id }, "Could not verify a legacy GitHub owner; creating an isolated owner instead.");
    }
  }
  return null;
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
function createConfiguredProvider(gitHubToken?: string) {
  return createCopilotProvider({ provider: config.copilotProvider, apiBaseUrl: config.copilotApiBaseUrl, apiToken: config.copilotApiToken, model: config.copilotModel, cliCommand: config.copilotCliCommand, sdkCliPath: config.copilotSdkCliPath, gitHubToken });
}
function gitHubTokenForOwner(ownerId: string): string | null { return db.getGitHubToken(ownerId) ?? (config.authMode === "local" ? config.copilotGitHubToken ?? null : null); }
function providerCredentialKey(token: string | null): string { return createHmac("sha256", config.sessionSecret ?? "local-provider-cache").update(token ?? "").digest("base64url"); }
async function cachedProviderStatus(ownerId: string): Promise<ProviderStatus> {
  const token = gitHubTokenForOwner(ownerId);
  const credentialKey = providerCredentialKey(token);
  if (config.authMode === "github" && !token) return missingGitHubOAuthStatus();
  return providerStatuses.getStaleWhileRefreshing(
    ownerId,
    credentialKey,
    () => createConfiguredProvider(token ?? undefined).status(),
    loadingProviderStatus,
    (error) => app.log.error({ err: error, ownerId }, "Provider status refresh failed"),
  );
}
async function freshProviderStatus(ownerId: string, force: boolean): Promise<ProviderStatus> {
  const token = gitHubTokenForOwner(ownerId);
  if (config.authMode === "github" && !token) return missingGitHubOAuthStatus();
  const credentialKey = providerCredentialKey(token);
  const status = await providerStatuses.getFresh(ownerId, credentialKey, () => createConfiguredProvider(token ?? undefined).status(), force);
  if (providerCredentialKey(gitHubTokenForOwner(ownerId)) !== credentialKey) return freshProviderStatus(ownerId, force);
  return status;
}
function loadingProviderStatus(): ProviderStatus { return { id: "unknown", label: "Loading", available: false, details: "Checking Copilot provider status.", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: config.copilotModel }; }
function missingGitHubOAuthStatus(): ProviderStatus { return { id: "sdk", label: "GitHub Copilot SDK", available: false, details: "The GitHub OAuth token for this account is missing or expired. Sign in with GitHub again.", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: config.copilotModel }; }
async function removeChatFiles(ownerId: string, chat: Chat): Promise<void> {
  await Promise.all(chatFiles(ownerId, chat).map(async (target) => { forgetValidatedAttachmentTree(target); await fs.promises.rm(target, { recursive: true, force: true }); }));
}
function chatFiles(ownerId: string, chat: Chat): string[] {
  const workspaceDir = chat.workspaceId ? db.getWorkspaceRecord(ownerId, chat.workspaceId).rootPath : path.join(isolatedWorkspaceRoot, chat.id.replace(/[^a-zA-Z0-9_.-]/g, "-"));
  const targets = new Set([chat.workspaceId ? chatAttachmentDirectory(workspaceDir, chat.id) : workspaceDir]);
  for (const attachment of db.listChatAttachmentFiles(ownerId, chat.id)) {
    const directory = path.dirname(attachment.filePath!);
    if (isChatAttachmentDirectory(directory, chat.id)) targets.add(directory);
  }
  return [...targets];
}
async function claimRequestUploads<T extends SendMessageRequest>(ownerId: string, input: T): Promise<T & { uploadClaimId?: string }> {
  const claimId = await uploadedFiles.claim(ownerId, input.attachments?.flatMap((attachment) => attachment.uploadId ? [attachment.uploadId] : []) ?? []);
  return claimId ? { ...input, uploadClaimId: claimId } : input;
}
async function withUploadClaim<TInput extends SendMessageRequest, TResult>(ownerId: string, input: TInput, action: (claimedInput: TInput & { uploadClaimId?: string }) => Promise<TResult>): Promise<TResult> {
  const claimedInput = await claimRequestUploads(ownerId, input);
  try {
    return await action(claimedInput);
  } catch (error) {
    abandonUploadClaim(ownerId, claimedInput.uploadClaimId);
    throw error;
  }
}
function uploadClaimCleanup(ownerId: string, claimId?: string): { id: string; run: () => Promise<void> } | undefined {
  return claimId ? { id: `upload-claim:${claimId}`, run: () => uploadedFiles.completeClaim(ownerId, claimId) } : undefined;
}
function uploadClaimResources(ownerId: string, claimId?: string): { cleanup: { id: string; run: () => Promise<void> } } | undefined {
  const cleanup = uploadClaimCleanup(ownerId, claimId);
  return cleanup ? { cleanup } : undefined;
}
async function completeUploadClaim(ownerId: string, claimId?: string | null): Promise<void> {
  if (!claimId) return;
  try {
    await uploadedFiles.completeClaim(ownerId, claimId);
  } catch (error) {
    app.log.warn({ err: error, claimId }, "Could not remove staged uploads after they were persisted.");
  }
}
function abandonUploadClaim(ownerId: string, claimId?: string | null): void {
  if (claimId) uploadedFiles.abandonClaim(ownerId, claimId);
}
async function withAttachmentCleanup<T>(ownerId: string, chatId: string, action: () => Promise<T>): Promise<T> {
  const before = db.listChatAttachmentFiles(ownerId, chatId);
  try {
    return await action();
  } finally {
    const retained = new Set(db.listChatAttachmentFiles(ownerId, chatId).map((attachment) => attachment.filePath));
    await Promise.all(before.filter((attachment) => !retained.has(attachment.filePath)).map(async (attachment) => {
      const filePath = attachment.filePath!;
      const directory = path.dirname(filePath);
      if (!isChatAttachmentDirectory(directory, chatId)) return;
      forgetValidatedAttachmentFiles([filePath]);
      await fs.promises.rm(filePath, { force: true });
      await fs.promises.rmdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
    }));
  }
}
async function removeTemporaryAttachmentFiles(filePaths: string[]): Promise<void> {
  forgetValidatedAttachmentFiles(filePaths);
  await Promise.all(filePaths.map(async (filePath) => {
    await fs.promises.rm(filePath, { force: true });
    await fs.promises.rmdir(path.dirname(filePath)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
  }));
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
