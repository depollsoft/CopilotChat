import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { CopilotProvider } from "@copilotchat/provider";
import type { ImportPreview, MessageAttachment } from "@copilotchat/shared";
import Database from "better-sqlite3";
import type { FastifyReply } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeMessageAttachments, reconcileAttachmentFiles, relocateChatAttachments } from "./attachment-files.js";
import { syncArtifactFiles, writeFileArtifact } from "./artifact-files.js";
import { applyChatTurnScope, buildProviderChatRequest } from "./chat-context.js";
import { bufferEtag, ChatFileAccessError, ChatFileNotFoundError, chatFileSystemContext, contentDispositionHeader, isInlineContentType, resolveChatFile, safeContentType } from "./chat-files.js";
import { isGitHubLoginAllowed, loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { applyImportPreview } from "./import-apply.js";
import { assertImportPayloadSize, ImportDraftStore, ImportLimitError } from "./import-drafts.js";
import { buildImportTools } from "./import-tools.js";
import { buildConversationTools } from "./conversation-tools.js";
import { isAllowedCorsOrigin } from "./cors-origin.js";
import { ActiveChatResponse, ActiveChatResponses, sseHeartbeatIntervalMs } from "./responses.js";
import { UploadedFileStore, UploadOffsetError } from "./uploaded-files.js";
import { ownerWorkspaceDirectory, ownerWorkspaceRoot, runWorkspaceCommand, validateRegisteredWorkspaceRoot } from "./workspace.js";

const tempDbs: Array<{ db: AppDatabase; dir: string }> = [];
function createTestDb(): AppDatabase { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-db-")); const db = new AppDatabase(dir); tempDbs.push({ db, dir }); return db; }
afterEach(() => { while (tempDbs.length > 0) { const entry = tempDbs.pop(); entry?.db.close(); if (entry) fs.rmSync(entry.dir, { recursive: true, force: true }); } });
async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}
function createFakeSseReply(): { reply: FastifyReply; writes: string[]; close: () => void } {
  const writes: string[] = [];
  const closeHandlers: Array<() => void> = [];
  const raw = {
    writableNeedDrain: false,
    writableLength: 0,
    writableEnded: false,
    destroyed: false,
    socket: { setNoDelay: () => undefined },
    writeHead: () => raw,
    flushHeaders: () => undefined,
    write: (chunk: string) => { writes.push(chunk); return true; },
    end: () => { raw.writableEnded = true; },
    on: (event: string, handler: () => void) => { if (event === "close") closeHandlers.push(handler); return raw; },
    once: () => raw,
  };
  const reply = { hijack: () => undefined, raw } as unknown as FastifyReply;
  return { reply, writes, close: () => { for (const handler of closeHandlers) handler(); } };
}

describe("loadConfig", () => {
  it("loads defaults", () => { expect(loadConfig().port).toBeGreaterThan(0); });
  it("parses false boolean environment values", () => {
    const previous = process.env.COPILOTCHAT_REQUIRE_CSRF;
    try {
      process.env.COPILOTCHAT_REQUIRE_CSRF = "false";
      expect(loadConfig().requireCsrf).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.COPILOTCHAT_REQUIRE_CSRF;
      else process.env.COPILOTCHAT_REQUIRE_CSRF = previous;
    }
  });
  it("treats empty optional deployment values as unset", () => {
    const previousPublicUrl = process.env.COPILOTCHAT_PUBLIC_URL;
    const tokenVariables = ["COPILOT_GITHUB_TOKEN", "GITHUB_COPILOT_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
    const previousTokens = tokenVariables.map((name) => [name, process.env[name]] as const);
    try {
      process.env.COPILOTCHAT_PUBLIC_URL = "";
      for (const name of tokenVariables) process.env[name] = "";
      expect(loadConfig().publicUrl).toBeUndefined();
      expect(loadConfig().copilotGitHubToken).toBeUndefined();
    } finally {
      if (previousPublicUrl === undefined) delete process.env.COPILOTCHAT_PUBLIC_URL;
      else process.env.COPILOTCHAT_PUBLIC_URL = previousPublicUrl;
      for (const [name, value] of previousTokens) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
  it("normalizes and enforces allowed GitHub logins", () => {
    const previous = process.env.COPILOTCHAT_ALLOWED_GITHUB_LOGINS;
    try {
      process.env.COPILOTCHAT_ALLOWED_GITHUB_LOGINS = "@Alice, bob, ALICE";
      const allowed = loadConfig().allowedGitHubLogins;
      expect(allowed).toEqual(["alice", "bob"]);
      expect(isGitHubLoginAllowed(allowed, "ALICE")).toBe(true);
      expect(isGitHubLoginAllowed(allowed, "@bob")).toBe(true);
      expect(isGitHubLoginAllowed(["@Alice"], "alice")).toBe(true);
      expect(isGitHubLoginAllowed(allowed, "mallory")).toBe(false);
      expect(isGitHubLoginAllowed([], "any-user")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.COPILOTCHAT_ALLOWED_GITHUB_LOGINS;
      else process.env.COPILOTCHAT_ALLOWED_GITHUB_LOGINS = previous;
    }
  });

  describe("CORS origins", () => {
    const configuredOrigins = new Set(["https://configured.example"]);

    it("allows same-origin requests through forwarded hosts", () => {
      expect(isAllowedCorsOrigin("http://ovh-copilotc.localhost:35151", "ovh-copilotc.localhost:35151", configuredOrigins)).toBe(true);
    });

    it("allows explicitly configured cross-origin clients", () => {
      expect(isAllowedCorsOrigin("https://configured.example", "127.0.0.1:4328", configuredOrigins)).toBe(true);
    });

    it("blocks matching non-localhost origins to prevent DNS rebinding", () => {
      expect(isAllowedCorsOrigin("http://attacker.example:4328", "attacker.example:4328", configuredOrigins)).toBe(false);
    });

    it("blocks localhost tunnel origins when the forwarded host or scheme differs", () => {
      expect(isAllowedCorsOrigin("http://preview.localhost:35151", "other.localhost:35151", configuredOrigins)).toBe(false);
      expect(isAllowedCorsOrigin("ftp://preview.localhost:35151", "preview.localhost:35151", configuredOrigins)).toBe(false);
    });

    it("blocks unrelated browser origins", () => {
      expect(isAllowedCorsOrigin("https://malicious.example", "127.0.0.1:4328", configuredOrigins)).toBe(false);
    });
  });
});

describe("chat provider context", () => {
  it("builds provider requests with project context and full conversation history", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Launch", description: null, instructions: "Use launch project rules." });
    const chat = db.createChat(owner.id, { title: "Project chat", projectId: project.id, workspaceId: null });
    db.addMessage({ chatId: chat.id, role: "user", content: "First question" });
    db.addMessage({ chatId: chat.id, role: "assistant", content: "First answer", provider: "echo" });
    db.addMessage({ chatId: chat.id, role: "user", content: "Second question" });

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Second question", model: "gpt-test", reasoningEffort: "high", contextTier: "long_context", skillIds: [] }, defaultModel: "fallback", gitHubToken: "gh-token", context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.projectContext).toContain("Use launch project rules.");
    expect(request.model).toBe("gpt-test");
    expect(request.reasoningEffort).toBe("high");
    expect(request.contextTier).toBe("long_context");
    expect(request.gitHubToken).toBe("gh-token");
    expect(request.sessionId).toMatch(new RegExp(`^copilotchat-${owner.id}-${chat.id}-[0-9a-f-]{36}$`));
    expect(request.resumeSession).toBe(false);
    expect(request.workingDirectory).toBe(`/tmp/isolated/${chat.id}`);
    expect(request.messages.map((message) => `${message.role}:${message.content}`)).toEqual(["user:First question", "assistant:First answer", "user:Second question"]);
  });

  it("includes a pending user message before it is persisted", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Pending message", projectId: null, workspaceId: null });

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Pending question" }, pendingUserMessage: { content: "Pending question", attachments: [{ id: "pending-file", name: "notes.txt", mimeType: "text/plain", size: 4, filePath: `/tmp/isolated/${chat.id}/.copilotchat/uploads/${chat.id}/notes.txt` }] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.messages).toEqual([{ role: "user", content: "Pending question", attachments: [{ type: "file", path: `/tmp/isolated/${chat.id}/.copilotchat/uploads/${chat.id}/notes.txt`, displayName: "notes.txt", size: 4 }] }]);
    expect(db.listMessages(chat.id)).toEqual([]);
  });

  it("overrides existing message attachments in provider context", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Override attachments", projectId: null, workspaceId: null });
    const message = db.addMessage({ chatId: chat.id, role: "user", content: "Updated question" });
    db.replaceMessageAttachments(owner.id, chat.id, message.id, [{ id: "old", name: "old.txt", mimeType: "text/plain", size: 3, filePath: "/tmp/old.txt" }]);

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Updated question" }, messageOverride: { id: message.id, content: "Updated question", attachments: [{ id: "new", name: "new.txt", mimeType: "text/plain", size: 3, filePath: "/tmp/new.txt" }] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.messages).toEqual([{ role: "user", content: "Updated question", attachments: [{ type: "file", path: "/tmp/new.txt", displayName: "new.txt", size: 3 }] }]);
  });

  it("builds retry context through the prior user message with a fresh session", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    let chat = db.createChat(owner.id, { title: "Retry context", projectId: null, workspaceId: null });
    const user = db.addMessage({ chatId: chat.id, role: "user", content: "Retry me" });
    db.addMessage({ chatId: chat.id, role: "assistant", content: "Old answer" });
    db.addMessage({ chatId: chat.id, role: "user", content: "Later message" });
    chat = db.setChatProviderSession(owner.id, chat.id, { providerSessionId: "old-session" });

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: user.content }, messageCutoffId: user.id, resetProviderSession: true, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.messages.map((message) => message.content)).toEqual(["Retry me"]);
    expect(request.resumeSession).toBe(false);
    expect(request.sessionId).not.toBe("old-session");
  });

  it("injects profile, consented location, and scoped memories into chat context", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Context project", description: null, instructions: "Use project rules." });
    db.updateUserContext(owner.id, {
      profile: "I am a staff engineer who prefers concise TypeScript examples.",
      locationLevel: "coarse",
      location: { latitude: 47.60621, longitude: -122.33207, accuracy: 25, capturedAt: "2026-07-24T08:00:00.000Z", precision: "coarse" },
    });
    db.createMemory(owner.id, { projectId: null, title: "Response style", content: "Lead with the recommendation.", enabled: true });
    db.createMemory(owner.id, { projectId: project.id, title: "Deployment target", content: "Deploy to the edge runtime.", enabled: true });
    db.createMemory(owner.id, { projectId: project.id, title: "Old decision", content: "Use the retired runtime.", enabled: false });
    const chat = db.createChat(owner.id, { title: "Context chat", projectId: project.id, workspaceId: null });
    db.addMessage({ chatId: chat.id, role: "user", content: "What should we do?" });

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "What should we do?", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.userContext).toContain("staff engineer");
    expect(request.userContext).toContain("47.6, -122.3");
    expect(request.userContext).toContain("Response style");
    expect(request.projectContext).toContain("Deployment target");
    expect(request.projectContext).not.toContain("Old decision");
    expect(db.getUserContext(owner.id).location).toMatchObject({ latitude: 47.6, longitude: -122.3, accuracy: 10_000, precision: "coarse" });
  });

  it("does not invalidate provider sessions for no-op user context updates", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "No-op context", projectId: null, workspaceId: null });
    db.setChatProviderSession(owner.id, chat.id, { providerSessionId: "active-session", providerSessionWorkspacePath: "/tmp/active" });
    const contextBefore = db.getUserContext(owner.id);
    const input = { locationLevel: "off" as const, location: null };

    expect(db.userContextWouldChange(owner.id, input)).toBe(false);
    const contextAfter = db.updateUserContext(owner.id, input);

    expect(contextAfter.updatedAt).toBe(contextBefore.updatedAt);
    expect(db.getChat(owner.id, chat.id)).toMatchObject({ providerSessionId: "active-session", providerSessionWorkspacePath: "/tmp/active" });
    expect(db.userContextWouldChange(owner.id, { profile: "Changed" })).toBe(true);
  });

  it("bounds enabled memory context and reports omitted content", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    db.createMemory(owner.id, { projectId: null, title: "Paused oversized memory", content: "paused-marker".repeat(2_000), enabled: false });
    for (let index = 0; index < 105; index += 1) db.createMemory(owner.id, { projectId: null, title: `Memory ${index}`, content: `${index}`.repeat(200), enabled: true });
    const chat = db.createChat(owner.id, { title: "Bounded context", projectId: null, workspaceId: null });
    db.addMessage({ chatId: chat.id, role: "user", content: "Use bounded context" });

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Use bounded context", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.userContext?.length).toBeLessThanOrEqual(16_000);
    expect(request.userContext).toContain("Memory context limited to 16000 characters");
    expect(request.userContext).toContain("memories omitted");
    expect(request.userContext).not.toContain("paused-marker");
  });

  it("invalidates provider sessions when user or scoped memory context changes", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Scoped context", description: null, instructions: "" });
    const generalChat = db.createChat(owner.id, { title: "General", projectId: null, workspaceId: null });
    const projectChat = db.createChat(owner.id, { title: "Project", projectId: project.id, workspaceId: null });
    db.setChatProviderSession(owner.id, generalChat.id, { providerSessionId: "general-session" });
    db.setChatProviderSession(owner.id, projectChat.id, { providerSessionId: "project-session" });
    const generalBeforeProjectMemory = db.getChat(owner.id, generalChat.id).updatedAt;
    const projectBeforeProjectMemory = db.getChat(owner.id, projectChat.id).updatedAt;

    db.createMemory(owner.id, { projectId: project.id, title: "Project fact", content: "Use durable storage.", enabled: true });

    expect(db.getChat(owner.id, generalChat.id)).toMatchObject({ providerSessionId: "general-session", updatedAt: generalBeforeProjectMemory });
    expect(db.getChat(owner.id, projectChat.id)).toMatchObject({ providerSessionId: null, updatedAt: projectBeforeProjectMemory });

    db.setChatProviderSession(owner.id, projectChat.id, { providerSessionId: "project-session-2" });
    const generalBeforeProfile = db.getChat(owner.id, generalChat.id).updatedAt;
    const projectBeforeProfile = db.getChat(owner.id, projectChat.id).updatedAt;
    db.updateUserContext(owner.id, { profile: "Prefer concise answers." });

    expect(db.getChat(owner.id, generalChat.id)).toMatchObject({ providerSessionId: null, updatedAt: generalBeforeProfile });
    expect(db.getChat(owner.id, projectChat.id)).toMatchObject({ providerSessionId: null, updatedAt: projectBeforeProfile });
    expect(db.getState({ id: "echo", label: "Echo", available: true, details: "", capabilities: [], models: [], modelsAuthoritative: false }).memoryStats.projects[project.id]).toMatchObject({ total: 1, enabled: 1 });
  });

  it("invalidates surviving chat sessions before deleting their project memories", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Deleted context", description: null, instructions: "" });
    db.createMemory(owner.id, { projectId: project.id, title: "Temporary decision", content: "Only valid in this project.", enabled: true });
    const chat = db.createChat(owner.id, { title: "Surviving chat", projectId: project.id, workspaceId: null });
    db.setChatProviderSession(owner.id, chat.id, { providerSessionId: "project-session", providerSessionWorkspacePath: "/tmp/project-session" });
    const updatedAt = db.getChat(owner.id, chat.id).updatedAt;

    db.deleteProject(owner.id, project.id);

    expect(db.getChat(owner.id, chat.id)).toMatchObject({ projectId: null, providerSessionId: null, providerSessionWorkspacePath: null, updatedAt });
    expect(db.listMemories(owner.id)).toHaveLength(0);
  });

  it("uses saved chat model choices when a request does not override them", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Model chat", projectId: null, workspaceId: null, model: "gpt-5-mini", reasoningEffort: "high", contextTier: "long_context" });
    db.addMessage({ chatId: chat.id, role: "user", content: "Use saved model" });

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Use saved model", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.model).toBe("gpt-5-mini");
    expect(request.reasoningEffort).toBe("high");
    expect(request.contextTier).toBe("long_context");
  });

  it("filters stdio MCP servers when stdio is not allowed", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "MCP chat", projectId: null, workspaceId: null });
    db.saveMcpServer(owner.id, { id: "stdio-mcp", name: "Stdio MCP", transport: "stdio", command: "node", args: [], url: null, tools: ["search"], enabled: true, projectId: null });
    db.saveMcpServer(owner.id, { id: "http-mcp", name: "HTTP MCP", transport: "http", command: null, args: [], url: "https://example.test/mcp", tools: ["search"], enabled: true, projectId: null });

    const githubRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Use tools", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated", allowStdioMcp: false } });
    const localRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Use tools", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated", allowStdioMcp: true } });

    expect(githubRequest.mcpServers?.map((server) => server.name)).toEqual(["HTTP MCP"]);
    expect(localRequest.mcpServers?.map((server) => server.name)).toEqual(["HTTP MCP", "Stdio MCP"]);
  });

  it("passes user file and image attachments into provider requests", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Attachment chat", projectId: null, workspaceId: null });
    const attachment: MessageAttachment = { id: "att-1", name: "project-list.png", mimeType: "image/png", size: 5, data: Buffer.from("image").toString("base64") };
    const message = db.addMessage({ chatId: chat.id, role: "user", content: "Use this screenshot." });
    db.replaceMessageAttachments(owner.id, chat.id, message.id, [attachment]);

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: message.content, skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });
    db.editUserMessageAndTruncate(owner.id, chat.id, message.id, "Use this updated screenshot.");

    expect(request.messages.at(-1)?.attachments).toEqual([{ type: "blob", data: attachment.data, mimeType: "image/png", displayName: "project-list.png", size: 5 }]);
    expect(db.listMessages(chat.id)[0]?.metadata.attachments).toEqual([{ id: "att-1", name: "project-list.png", mimeType: "image/png", size: 5 }]);
    expect(db.listMessages(chat.id, { includeAttachmentData: true })[0]?.metadata.attachments).toEqual([attachment]);
  });

  it("streams uploads into file-backed provider attachments", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Large attachment", projectId: null, workspaceId: null });
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-workspace-"));
    const nextWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-workspace-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 10 * 1024 * 1024);
      const content = Buffer.alloc(2 * 1024 * 1024, "a");
      const uploaded = await uploads.create(owner.id, { fileName: "large-notes.txt", mimeType: "text/plain", size: content.length }, Readable.from([content]));
      const claimId = await uploads.claim(owner.id, [uploaded.uploadId!]);
      const workspaceDir = path.join(workspaceRoot, chat.id);
      fs.mkdirSync(workspaceDir, { recursive: true });
      const materialized = await materializeMessageAttachments({ uploads, ownerId: owner.id, chatId: chat.id, workspaceDir, maxBytes: 10 * 1024 * 1024, uploadClaimId: claimId, attachments: [uploaded] });
      const [attachment] = materialized.attachments;
      await expect(uploads.get(owner.id, uploaded.uploadId!)).resolves.toMatchObject({ id: uploaded.uploadId });
      const message = db.addMessage({ chatId: chat.id, role: "user", content: "Inspect the uploaded file." });
      db.replaceMessageAttachments(owner.id, chat.id, message.id, [attachment!]);
      await uploads.completeClaim(owner.id, claimId!);
      const nextWorkspaceDir = path.join(nextWorkspaceRoot, chat.id);
      fs.mkdirSync(nextWorkspaceDir, { recursive: true });
      await relocateChatAttachments({ db, ownerId: owner.id, chatId: chat.id, workspaceDir: nextWorkspaceDir });
      const relocated = db.listChatAttachmentFiles(owner.id, chat.id)[0]!;

      const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: message.content, skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: nextWorkspaceRoot } });

      expect(request.messages.at(-1)?.attachments).toEqual([{ type: "file", path: relocated.filePath, displayName: "large-notes.txt", size: content.length }]);
      expect(fs.statSync(relocated.filePath!).size).toBe(content.length);
      expect(fs.readFileSync(relocated.filePath!, "utf8").slice(0, 16)).toBe("a".repeat(16));
      expect(fs.existsSync(attachment!.filePath!)).toBe(false);
      expect(db.listMessages(chat.id)[0]?.metadata.attachments).toEqual([{ id: uploaded.id, name: "large-notes.txt", mimeType: "text/plain", size: content.length }]);
      expect(db.listMessages(chat.id, { includeAttachmentFilePaths: true })[0]?.metadata.attachments).toEqual([relocated]);
      await expect(uploads.get(owner.id, uploaded.uploadId!)).rejects.toThrow();
      fs.writeFileSync(relocated.filePath!, Buffer.alloc(content.length, "b"));
      const missing: string[] = [];
      await relocateChatAttachments({ db, ownerId: owner.id, chatId: chat.id, workspaceDir: nextWorkspaceDir, onMissing: (item) => missing.push(item.name) });
      expect(missing).toEqual(["large-notes.txt"]);
      expect(db.listChatAttachmentFiles(owner.id, chat.id)).toEqual([]);
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(nextWorkspaceRoot, { recursive: true, force: true });
    }
  });

  it("removes unreferenced workspace attachment files on reconciliation", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Reconcile attachments", projectId: null, workspaceId: null });
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-isolated-"));
    try {
      const unavailableRoot = path.join(isolatedRoot, "unavailable-root");
      fs.writeFileSync(unavailableRoot, "not a directory");
      db.registerWorkspace(owner.id, { name: "Unavailable", rootPath: unavailableRoot });
      const directory = path.join(isolatedRoot, chat.id, ".copilotchat", "uploads", chat.id);
      fs.mkdirSync(directory, { recursive: true });
      const referencedPath = path.join(directory, "referenced.txt");
      const orphanPath = path.join(directory, "orphan.txt");
      fs.writeFileSync(referencedPath, "keep");
      fs.writeFileSync(orphanPath, "remove");
      const message = db.addMessage({ chatId: chat.id, role: "user", content: "Keep attachment" });
      db.replaceMessageAttachments(owner.id, chat.id, message.id, [{ id: "referenced", name: "referenced.txt", mimeType: "text/plain", size: 4, filePath: referencedPath }]);
      const errors: string[] = [];

      await expect(reconcileAttachmentFiles({ db, isolatedWorkspaceRoot: isolatedRoot, onError: (rootPath) => errors.push(rootPath) })).resolves.toBe(1);

      expect(fs.existsSync(referencedPath)).toBe(true);
      expect(fs.existsSync(orphanPath)).toBe(false);
      expect(errors).toEqual([unavailableRoot]);
    } finally {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("tracks manual chat titles and disables the provider title tool", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "New chat", projectId: null, workspaceId: null });
    db.addMessage({ chatId: chat.id, role: "user", content: "Discuss durable titles" });

    const auto = db.updateChatTitle(owner.id, chat.id, "Durable Titles", "auto");
    const autoRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat: auto, message: { content: "Discuss durable titles", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" }, titleTool: { currentTitle: auto.title, setTitle: async (title) => title } });
    const manual = db.updateChat(owner.id, chat.id, { title: "My Hand Named Chat" });
    const manualRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat: manual, message: { content: "Discuss a new topic", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" }, titleTool: { currentTitle: manual.title, setTitle: async (title) => title } });

    expect(auto.titleManuallySet).toBe(false);
    expect(autoRequest.titleTool).toBeDefined();
    expect(manual.titleManuallySet).toBe(true);
    expect(manualRequest.titleTool).toBeUndefined();
  });

  it("deletes only abandoned empty chats", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const keepEmpty = db.createChat(owner.id, { title: "Keep empty", projectId: null, workspaceId: null });
    const deleteEmpty = db.createChat(owner.id, { title: "Delete empty", projectId: null, workspaceId: null });
    const nonEmpty = db.createChat(owner.id, { title: "Keep messages", projectId: null, workspaceId: null });
    db.addMessage({ chatId: nonEmpty.id, role: "user", content: "Do not delete" });

    const deleted = db.deleteEmptyChats(owner.id, keepEmpty.id);

    expect(deleted).toEqual([deleteEmpty.id]);
    expect(db.listChats(owner.id).map((chat) => chat.id)).toEqual(expect.arrayContaining([keepEmpty.id, nonEmpty.id]));
    expect(() => db.getChat(owner.id, deleteEmpty.id)).toThrow("Chat not found.");
  });

  it("clears local app data while preserving owner and built-in skills", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Imported project", description: null, instructions: "Use imported context." });
    db.createProjectReference(owner.id, { projectId: project.id, title: "Reference", content: "Reference content" });
    const chat = db.createChat(owner.id, { title: "Imported chat", projectId: project.id, workspaceId: null });
    const message = db.addMessage({ chatId: chat.id, role: "assistant", content: "Hello", provider: "echo", metadata: { activities: [] } });
    db.createProjectChatReference(owner.id, { projectId: project.id, messageId: message.id });
    db.createArtifact(owner.id, { chatId: chat.id, projectId: project.id, messageId: message.id, title: "Artifact", kind: "markdown", content: "Artifact content" });
    const workspace = db.registerWorkspace(owner.id, { name: "Workspace", rootPath: process.cwd() });
    db.createToolRun(owner.id, { chatId: chat.id, workspaceId: workspace.id, toolName: "test.tool", input: {} });
    db.saveMcpServer(owner.id, { id: "test-mcp", name: "Test MCP", transport: "stdio", command: "node", args: [], url: null, tools: ["tool"], enabled: true, projectId: project.id });
    db.upsertSkill(owner.id, { id: "custom-skill", name: "Custom", description: "Custom skill", version: "1", instructions: "Use it.", prompts: [], workflow: [], artifactTemplates: [], mcpDependencies: [], toolDependencies: [], activationRules: [], permissions: [] }, false, null);
    db.updateUserContext(owner.id, { profile: "Sensitive profile", locationLevel: "fine", location: { latitude: 47.60621, longitude: -122.33207, accuracy: 15, capturedAt: "2026-07-25T00:00:00.000Z", precision: "fine" } });
    db.createMemory(owner.id, { projectId: null, title: "User memory", content: "Sensitive user context", enabled: true });
    db.createMemory(owner.id, { projectId: project.id, title: "Project memory", content: "Sensitive project context", enabled: true });

    db.clearAllData(owner.id);

    expect(db.getOwner().id).toBe(owner.id);
    expect(db.listChats(owner.id)).toEqual([]);
    expect(db.listArchivedChats(owner.id)).toEqual([]);
    expect(db.listProjects(owner.id)).toEqual([]);
    expect(db.listProjectReferences(owner.id)).toEqual([]);
    expect(db.listProjectChatReferences(owner.id)).toEqual([]);
    expect(db.listArtifacts(owner.id)).toEqual([]);
    expect(db.listMcpServers(owner.id)).toEqual([]);
    expect(db.listWorkspaces(owner.id)).toEqual([]);
    expect(db.getUserContext(owner.id)).toMatchObject({ profile: "", locationLevel: "off", location: null });
    expect(db.listMemories(owner.id)).toEqual([]);
    const skills = db.listSkills(owner.id);
    expect(skills.some((skill) => skill.id === "custom-skill")).toBe(false);
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((skill) => skill.builtIn)).toBe(true);
  });

  it("isolates data by GitHub owner login", () => {
    const db = createTestDb();
    const alice = db.getOrCreateGitHubOwner({ providerUserId: "1001", login: "alice", displayName: "Alice", avatarUrl: null });
    const bob = db.getOrCreateGitHubOwner({ providerUserId: "1002", login: "bob", displayName: "Bob", avatarUrl: null });

    db.createChat(alice.id, { title: "Alice chat", projectId: null, workspaceId: null });
    db.createChat(bob.id, { title: "Bob chat", projectId: null, workspaceId: null });

    expect(db.listChats(alice.id).map((chat) => chat.title)).toEqual(["Alice chat"]);
    expect(db.listChats(bob.id).map((chat) => chat.title)).toEqual(["Bob chat"]);
    expect(db.listSkills(alice.id).length).toBeGreaterThan(0);
    expect(db.listSkills(bob.id).length).toBeGreaterThan(0);
  });

  it("stores GitHub OAuth tokens per owner", () => {
    const db = createTestDb();
    const alice = db.getOrCreateGitHubOwner({ providerUserId: "1001", login: "alice", displayName: "Alice", avatarUrl: null });
    const bob = db.getOrCreateGitHubOwner({ providerUserId: "1002", login: "bob", displayName: "Bob", avatarUrl: null });

    db.setGitHubAuth(alice.id, { accessToken: "alice-token", login: "alice", displayName: "Alice", avatarUrl: null });
    db.setGitHubAuth(bob.id, { accessToken: "bob-token", login: "bob", displayName: "Bob", avatarUrl: null });

    expect(db.hasGitHubAuth(alice.id)).toBe(true);
    expect(db.hasGitHubAuth(bob.id)).toBe(true);
    expect(db.getGitHubToken(alice.id)).toBe("alice-token");
    expect(db.getGitHubToken(bob.id)).toBe("bob-token");
  });

  it("keys GitHub owners by immutable provider ID instead of login", () => {
    const db = createTestDb();
    const original = db.getOrCreateGitHubOwner({ providerUserId: "1001", login: "alice", displayName: "Alice", avatarUrl: null });
    db.createChat(original.id, { title: "Alice chat", projectId: null, workspaceId: null });

    const renamed = db.getOrCreateGitHubOwner({ providerUserId: "1001", login: "alice-renamed", displayName: "Alice", avatarUrl: null });
    const reclaimer = db.getOrCreateGitHubOwner({ providerUserId: "2002", login: "alice", displayName: "Another Alice", avatarUrl: null });

    expect(renamed.id).toBe(original.id);
    expect(renamed.login).toBe("alice-renamed");
    expect(db.listChats(renamed.id).map((chat) => chat.title)).toEqual(["Alice chat"]);
    expect(reclaimer.id).not.toBe(original.id);
    expect(db.listChats(reclaimer.id)).toEqual([]);
  });

  it("only migrates a legacy login-keyed owner when explicitly verified", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-legacy-owner-"));
    const legacy = new Database(path.join(dir, "copilotchat.sqlite"));
    legacy.exec(`
      CREATE TABLE owners (id TEXT PRIMARY KEY, login TEXT NOT NULL, display_name TEXT, avatar_url TEXT, auth_provider TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE auth_tokens (provider TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE, access_token TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO owners (id, login, display_name, avatar_url, auth_provider, created_at) VALUES ('github:alice', 'alice', 'Alice', NULL, 'github', '2026-01-01T00:00:00.000Z');
      INSERT INTO auth_tokens (provider, owner_id, access_token, created_at, updated_at) VALUES ('github', 'github:alice', 'legacy-token', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();
    const db = new AppDatabase(dir);
    tempDbs.push({ db, dir });
    const legacyOwner = db.getLegacyGitHubOwnerByLogin("alice");

    const reclaimer = db.getOrCreateGitHubOwner({ providerUserId: "2002", login: "alice", displayName: "Another Alice", avatarUrl: null });
    const migrated = db.getOrCreateGitHubOwner({ providerUserId: "1001", login: "alice-renamed", displayName: "Alice", avatarUrl: null, legacyOwnerId: legacyOwner?.id });

    expect(legacyOwner?.id).toBe("github:alice");
    expect(reclaimer.id).not.toBe(legacyOwner?.id);
    expect(migrated.id).toBe(legacyOwner?.id);
    expect(migrated.login).toBe("alice-renamed");
    expect(db.getGitHubOwnerByProviderId("1001")?.id).toBe(legacyOwner?.id);
  });

  it("migrates a persistent legacy GitHub token to owner-scoped storage", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-legacy-db-"));
    const legacy = new Database(path.join(dir, "copilotchat.sqlite"));
    legacy.exec(`
      CREATE TABLE owners (id TEXT PRIMARY KEY, login TEXT NOT NULL, display_name TEXT, avatar_url TEXT, auth_provider TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE auth_tokens (provider TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE, access_token TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO owners (id, login, display_name, avatar_url, auth_provider, created_at) VALUES ('local', 'local', 'Local user', NULL, 'local', '2026-01-01T00:00:00.000Z');
      INSERT INTO auth_tokens (provider, owner_id, access_token, created_at, updated_at) VALUES ('github', 'local', 'legacy-token', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();
    const db = new AppDatabase(dir);
    tempDbs.push({ db, dir });
    const alice = db.getOrCreateGitHubOwner({ providerUserId: "1001", login: "alice", displayName: "Alice", avatarUrl: null });

    db.setGitHubAuth(alice.id, { accessToken: "alice-token", login: "alice", displayName: "Alice", avatarUrl: null });

    expect(db.getGitHubToken("local")).toBe("legacy-token");
    expect(db.getGitHubToken(alice.id)).toBe("alice-token");
  });

  it("keeps large artifact content out of app state", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const content = "large artifact\n".repeat(1000);
    const artifact = db.createArtifact(owner.id, { title: "Large notes", kind: "markdown", content });

    const state = db.getState({ id: "echo", label: "Echo", available: true, details: "", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: "gpt-test" }, [], owner.id, "github");

    expect(state.authMode).toBe("github");
    expect(state.artifacts[0]).toMatchObject({ id: artifact.id, title: "Large notes", contentLength: content.length });
    expect(state.artifacts[0]?.contentPreview.length).toBeLessThan(content.length);
    expect(JSON.stringify(state)).not.toContain(content);
    expect(db.getArtifact(owner.id, artifact.id).content).toBe(content);
  });

  it("keeps memory content out of app state and pages it on demand", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const content = "sensitive memory ".repeat(1000);
    const created = Array.from({ length: 3 }, (_, index) => db.createMemory(owner.id, { projectId: null, title: `Memory ${index}`, content: `${index}:${content}`, enabled: index !== 1 }));

    let state = db.getState({ id: "echo", label: "Echo", available: true, details: "", capabilities: [], models: [], modelsAuthoritative: false });
    const firstPage = db.listMemoriesPage(owner.id, null, 0, 2);
    const secondPage = db.listMemoriesPage(owner.id, null, firstPage.nextOffset ?? 0, 2);

    expect(state.memoryStats.user).toMatchObject({ total: 3, enabled: 2 });
    expect(state.memoryStats.user.contextLength).toBeGreaterThan(0);
    expect(JSON.stringify(state)).not.toContain("sensitive memory");
    expect(firstPage).toMatchObject({ total: 3, nextOffset: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.items[0]?.content).toContain("sensitive memory");
    expect(secondPage).toMatchObject({ total: 3, nextOffset: null });
    expect(secondPage.items).toHaveLength(1);

    db.updateMemory(owner.id, created[0]!.id, { enabled: false });
    state = db.getState({ id: "echo", label: "Echo", available: true, details: "", capabilities: [], models: [], modelsAuthoritative: false });
    expect(state.memoryStats.user).toMatchObject({ total: 3, enabled: 1 });
    db.deleteMemory(owner.id, created[1]!.id);
    state = db.getState({ id: "echo", label: "Echo", available: true, details: "", capabilities: [], models: [], modelsAuthoritative: false });
    expect(state.memoryStats.user).toMatchObject({ total: 2, enabled: 1 });
  });

  it("persists favorite project and chat flags", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const regularProject = db.createProject(owner.id, { name: "Regular project", description: null, instructions: "" });
    const favoriteProject = db.createProject(owner.id, { name: "Favorite project", description: null, instructions: "" });
    db.updateProject(owner.id, favoriteProject.id, { favorite: true });
    db.createChat(owner.id, { title: "Regular chat", projectId: regularProject.id, workspaceId: null });
    const favoriteChat = db.createChat(owner.id, { title: "Favorite chat", projectId: null, workspaceId: null });
    db.updateChat(owner.id, favoriteChat.id, { favorite: true });

    expect(db.listProjects(owner.id).map((project) => [project.name, project.favorite])).toEqual([
      ["Favorite project", true],
      ["Regular project", false],
    ]);
    expect(db.listChats(owner.id).map((chat) => [chat.title, chat.favorite])).toEqual([
      ["Favorite chat", true],
      ["Regular chat", false],
    ]);
  });

  it("seeds the built-in import assistant skill", () => {
    const db = createTestDb();
    const owner = db.getOwner();

    const skill = db.listSkills(owner.id).find((item) => item.id === "import-assistant");

    expect(skill?.enabled).toBe(true);
    expect(skill?.manifest.toolDependencies).toEqual(["preview_import_draft", "set_import_project_assignments", "apply_import_draft"]);
    expect(skill?.manifest.instructions).toContain("screenshots or copied text");
  });

  it("applies import previews with project assignment overrides", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const preview: ImportPreview = { source: "chatgpt", projects: [], warnings: [], conversations: [{ source: "chatgpt", sourceId: "chat-1", projectSourceId: null, title: "Migration plan", createdAt: null, updatedAt: null, messages: [{ role: "user", content: "Plan the migration", createdAt: null, metadata: {} }], artifacts: [], reusableHelpers: [], metadata: {} }] };

    const result = applyImportPreview(db, owner.id, preview, [{ conversationSourceId: "chat-1", projectName: "Migration Project" }]);

    expect(result.imported).toHaveLength(1);
    const project = db.listProjects(owner.id).find((item) => item.name === "Migration Project");
    expect(project).toBeDefined();
    expect(db.getChat(owner.id, result.imported[0]!.id).projectId).toBe(project?.id);
  });

  it("previews, assigns, and applies import drafts through chat tools", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-import-drafts-"));
    try {
      const draftStore = new ImportDraftStore(draftDir);
      const draft = await draftStore.create(owner.id, { source: "auto", fileName: "chatgpt.json", encoding: "text", content: JSON.stringify([{ id: "chatgpt-1", title: "Imported strategy chat", current_node: "m1", mapping: { m1: { id: "m1", parent: null, children: [], message: { author: { role: "user" }, content: { content_type: "text", parts: ["Hello import"] }, create_time: 1, metadata: {} } } } }]) });
      const tools = buildImportTools({ db, ownerId: owner.id, drafts: draftStore });

      const preview = await tools.find((tool) => tool.name === "preview_import_draft")!.handler({ draftId: draft.id }) as Record<string, unknown>;
      expect(preview.conversations).toBe(1);
      await tools.find((tool) => tool.name === "set_import_project_assignments")!.handler({ draftId: draft.id, assignments: [{ conversationSourceId: "chatgpt-1", projectName: "Imported Project" }] });
      const applied = await tools.find((tool) => tool.name === "apply_import_draft")!.handler({ draftId: draft.id, confirmed: true }) as Record<string, unknown>;

      expect(applied.importedConversations).toBe(1);
      expect(db.listProjects(owner.id).map((project) => project.name)).toContain("Imported Project");
      expect(db.listChats(owner.id).map((chat) => chat.title)).toContain("Imported strategy chat");
      await expect(draftStore.get(owner.id, draft.id)).rejects.toThrow();
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent apply for an import draft", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-import-drafts-"));
    try {
      const draftStore = new ImportDraftStore(draftDir);
      const draft = await draftStore.create(owner.id, { source: "auto", fileName: "chatgpt.json", encoding: "text", content: JSON.stringify([{ id: "chatgpt-once", title: "Import once", current_node: "m1", mapping: { m1: { id: "m1", parent: null, children: [], message: { author: { role: "user" }, content: { content_type: "text", parts: ["Only once"] }, create_time: 1, metadata: {} } } } }]) });
      const applyTool = buildImportTools({ db, ownerId: owner.id, drafts: draftStore }).find((tool) => tool.name === "apply_import_draft")!;

      const results = await Promise.allSettled([
        applyTool.handler({ draftId: draft.id, confirmed: true }),
        applyTool.handler({ draftId: draft.id, confirmed: true }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(db.listChats(owner.id).filter((chat) => chat.title === "Import once")).toHaveLength(1);
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it("holds the import owner clear barrier until draft consumption finishes", async () => {
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-import-drafts-"));
    let releaseConsume!: () => void;
    let markConsumeStarted!: () => void;
    const consumeBlocked = new Promise<void>((resolve) => { releaseConsume = resolve; });
    const consumeStarted = new Promise<void>((resolve) => { markConsumeStarted = resolve; });
    try {
      const draftStore = new ImportDraftStore(draftDir);
      const draft = await draftStore.create("github:alice", { source: "auto", fileName: "draft.json", encoding: "text", content: "{}" });
      const consuming = draftStore.consume("github:alice", draft.id, async () => { markConsumeStarted(); await consumeBlocked; });
      await consumeStarted;
      let clearActionRan = false;
      const clearing = draftStore.clearOwner("github:alice", async () => { clearActionRan = true; });

      expect(clearActionRan).toBe(false);
      releaseConsume();
      await consuming;
      await clearing;

      expect(clearActionRan).toBe(true);
      await expect(draftStore.get("github:alice", draft.id)).rejects.toThrow();
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it("deletes only the current owner's import drafts", async () => {
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-import-drafts-"));
    try {
      const draftStore = new ImportDraftStore(draftDir);
      const alice = await draftStore.create("github:alice", { source: "auto", fileName: "alice.json", encoding: "text", content: "{}" });
      const bob = await draftStore.create("github:bob", { source: "auto", fileName: "bob.json", encoding: "text", content: "{}" });

      await expect(draftStore.deleteOwner("github:alice")).resolves.toBe(1);

      await expect(draftStore.get("github:alice", alice.id)).rejects.toThrow();
      await expect(draftStore.get("github:bob", bob.id)).resolves.toMatchObject({ id: bob.id, ownerId: "github:bob" });
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it("serializes import assignment updates with owner deletion", async () => {
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-import-drafts-"));
    try {
      const draftStore = new ImportDraftStore(draftDir);
      const draft = await draftStore.create("github:alice", { source: "auto", fileName: "alice.json", encoding: "text", content: "{}" });

      const updated = draftStore.setAssignments("github:alice", draft.id, [{ conversationTitle: "Chat", projectName: "Project" }]);
      const deleted = draftStore.deleteOwner("github:alice");

      await expect(updated).resolves.toMatchObject({ assignments: [{ conversationTitle: "Chat", projectName: "Project" }] });
      await expect(deleted).resolves.toBe(1);
      await expect(draftStore.get("github:alice", draft.id)).rejects.toThrow();
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it("keeps import draft metadata when content deletion fails", async () => {
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-import-drafts-"));
    try {
      const draftStore = new ImportDraftStore(draftDir);
      const draft = await draftStore.create("github:alice", { source: "auto", fileName: "alice.json", encoding: "text", content: "{}" });
      const contentPath = path.join(draftDir, `${draft.id}.data`);
      fs.rmSync(contentPath);
      fs.mkdirSync(contentPath);
      fs.writeFileSync(path.join(contentPath, "blocker"), "x");

      await expect(draftStore.deleteOwner("github:alice")).rejects.toThrow();

      expect(fs.existsSync(path.join(draftDir, `${draft.id}.json`))).toBe(true);
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it("cleans orphaned import draft content files", async () => {
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-import-drafts-"));
    try {
      const draftStore = new ImportDraftStore(draftDir);
      const draft = await draftStore.create("github:alice", { source: "auto", fileName: "alice.json", encoding: "text", content: "{}" });
      fs.writeFileSync(path.join(draftDir, "orphan.data"), "orphan");
      fs.writeFileSync(path.join(draftDir, "corrupt.json"), "{");
      fs.writeFileSync(path.join(draftDir, "corrupt.data"), "recoverable");

      await expect(draftStore.cleanupOrphans()).resolves.toBe(1);

      expect(fs.existsSync(path.join(draftDir, `${draft.id}.data`))).toBe(true);
      expect(fs.existsSync(path.join(draftDir, "orphan.data"))).toBe(false);
      expect(fs.existsSync(path.join(draftDir, "corrupt.data"))).toBe(true);
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it("serializes import draft creation with orphan cleanup", async () => {
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-import-drafts-"));
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    let releaseCopy!: () => void;
    let markCopyStarted!: () => void;
    const copyBlocked = new Promise<void>((resolve) => { releaseCopy = resolve; });
    const copyStarted = new Promise<void>((resolve) => { markCopyStarted = resolve; });
    class BlockingUploadStore extends UploadedFileStore {
      override async copyTo(ownerId: string, id: string, targetPath: string, claimId: string) {
        markCopyStarted();
        await copyBlocked;
        return super.copyTo(ownerId, id, targetPath, claimId);
      }
    }
    try {
      const uploads = new BlockingUploadStore(uploadDir, 1024);
      const uploaded = await uploads.create("github:alice", { fileName: "draft.json", mimeType: "application/json", size: 2 }, Readable.from(["{}"]));
      const claimId = await uploads.claim("github:alice", [uploaded.uploadId!]);
      const draftStore = new ImportDraftStore(draftDir);
      const creating = draftStore.createFromUpload("github:alice", "auto", uploads, uploaded.uploadId!, claimId!);
      await copyStarted;
      const cleaning = draftStore.cleanupOrphans();
      releaseCopy();
      const draft = await creating;

      await expect(cleaning).resolves.toBe(0);
      expect(fs.existsSync(path.join(draftDir, `${draft.id}.data`))).toBe(true);
      await uploads.completeClaim("github:alice", claimId!);
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it("stores uploaded import contents outside draft metadata", async () => {
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-import-drafts-"));
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 10 * 1024 * 1024);
      const content = JSON.stringify([{ id: "chat-1", title: "Large import", padding: "x".repeat(2 * 1024 * 1024) }]);
      const uploaded = await uploads.create("github:alice", { fileName: "claude.json", mimeType: "application/json", size: Buffer.byteLength(content) }, Readable.from([content]));
      const claimId = await uploads.claim("github:alice", [uploaded.uploadId!]);
      const draftStore = new ImportDraftStore(draftDir);

      const draft = await draftStore.createFromUpload("github:alice", "auto", uploads, uploaded.uploadId!, claimId!);
      const stored = await draftStore.get("github:alice", draft.id);
      await uploads.completeClaim("github:alice", claimId!);

      expect(stored.content).toBeUndefined();
      expect(await draftStore.readContent(stored)).toBe(content);
      expect(fs.readFileSync(path.join(draftDir, `${draft.id}.json`), "utf8")).not.toContain("x".repeat(100));
      await expect(uploads.get("github:alice", uploaded.uploadId!)).rejects.toThrow();
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it("rejects uploads without a usable basename", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 1024);
      await expect(uploads.create("github:alice", { fileName: "/", mimeType: "application/octet-stream", size: 1 }, Readable.from([Buffer.from("x")]))).rejects.toThrow("valid file name");
      fs.writeFileSync(path.join(uploadDir, "corrupt.json"), "{");
      fs.writeFileSync(path.join(uploadDir, "corrupt.upload"), "x");
      await expect(uploads.deleteOwner("github:alice")).resolves.toBe(0);
      expect(fs.readdirSync(uploadDir)).toEqual([]);
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it("rejects repeated staged uploads before copying attachment data", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-workspace-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 1024);
      const uploaded = await uploads.create("github:alice", { fileName: "notes.txt", mimeType: "text/plain", size: 5 }, Readable.from(["notes"]));
      const claimId = await uploads.claim("github:alice", [uploaded.uploadId!]);
      await expect(uploads.claim("github:alice", [uploaded.uploadId!])).rejects.toThrow("already in use");

      await expect(materializeMessageAttachments({ uploads, ownerId: "github:alice", chatId: "chat-1", workspaceDir, maxBytes: 1024, uploadClaimId: claimId, attachments: [uploaded, { ...uploaded, id: "duplicate" }] })).rejects.toThrow("only be attached once");
      await expect(materializeMessageAttachments({ uploads, ownerId: "github:alice", chatId: "chat-1", workspaceDir, maxBytes: 4, uploadClaimId: claimId, attachments: [{ ...uploaded, size: 0 }] })).rejects.toThrow("Combined attachment size");
      await expect(materializeMessageAttachments({ uploads, ownerId: "github:alice", chatId: "chat-1", workspaceDir, maxBytes: 1024, uploadClaimId: claimId, attachments: [uploaded, { id: "bad", name: "bad.txt", mimeType: "text/plain", size: 2, data: "!" }] })).rejects.toThrow("valid base64");
      expect(fs.readdirSync(path.join(workspaceDir, ".copilotchat", "uploads", "chat-1"))).toEqual([]);
      uploads.abandonClaim("github:alice", claimId!);
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses content-addressed paths for same-size attachment replacements", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-workspace-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 1024);
      const firstUpload = await uploads.create("github:alice", { fileName: "notes.txt", mimeType: "text/plain", size: 5 }, Readable.from(["first"]));
      const firstClaim = await uploads.claim("github:alice", [firstUpload.uploadId!]);
      const first = await materializeMessageAttachments({ uploads, ownerId: "github:alice", chatId: "chat-1", workspaceDir, maxBytes: 1024, uploadClaimId: firstClaim, attachments: [{ ...firstUpload, id: "same-id" }] });
      await uploads.completeClaim("github:alice", firstClaim!);
      const secondUpload = await uploads.create("github:alice", { fileName: "notes.txt", mimeType: "text/plain", size: 5 }, Readable.from(["other"]));
      const secondClaim = await uploads.claim("github:alice", [secondUpload.uploadId!]);
      const second = await materializeMessageAttachments({ uploads, ownerId: "github:alice", chatId: "chat-1", workspaceDir, maxBytes: 1024, uploadClaimId: secondClaim, attachments: [{ ...secondUpload, id: "same-id" }] });

      expect(second.attachments[0]?.filePath).not.toBe(first.attachments[0]?.filePath);
      expect(fs.readFileSync(second.attachments[0]!.filePath!, "utf8")).toBe("other");
      const legacy: MessageAttachment = { id: "legacy-id", name: "legacy.txt", mimeType: "text/plain", size: 5, data: Buffer.from("first").toString("base64") };
      const legacyFirst = await materializeMessageAttachments({ uploads, ownerId: "github:alice", chatId: "chat-1", workspaceDir, maxBytes: 1024, attachments: [legacy] });
      const legacyAgain = await materializeMessageAttachments({ uploads, ownerId: "github:alice", chatId: "chat-1", workspaceDir, maxBytes: 1024, attachments: [legacy] });
      expect(legacyFirst.createdFilePaths).toHaveLength(1);
      expect(legacyAgain.createdFilePaths).toEqual([]);
      const longName = `${"a".repeat(1000)}.txt`;
      const longUpload = await uploads.create("github:alice", { fileName: longName, mimeType: "text/plain", size: 4 }, Readable.from(["long"]));
      const longClaim = await uploads.claim("github:alice", [longUpload.uploadId!]);
      const longAttachment = await materializeMessageAttachments({ uploads, ownerId: "github:alice", chatId: "chat-1", workspaceDir, maxBytes: 1024, uploadClaimId: longClaim, attachments: [longUpload] });
      expect(Buffer.byteLength(path.basename(longAttachment.attachments[0]!.filePath!))).toBeLessThanOrEqual(255);
      expect(longAttachment.attachments[0]?.name).toBe(longName);
      await uploads.completeClaim("github:alice", secondClaim!);
      await uploads.completeClaim("github:alice", longClaim!);
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("cleans temporary steering attachment files", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-steer-files-"));
    const filePath = path.join(directory, "steer.txt");
    fs.writeFileSync(filePath, "temporary");
    const response = new ActiveChatResponse("chat-1");
    response.trackTemporaryFiles([filePath]);

    await response.cleanupTemporaryFiles();

    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("marks a response inactive before awaiting terminal cleanup", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Cleanup ordering", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Finish" });
    const provider: CopilotProvider = { id: "test", label: "Test", status: async () => ({ id: "test", label: "Test", available: true, details: "", capabilities: [], models: [], modelsAuthoritative: false }), async *streamChat() { yield { type: "done" }; } };
    const responses = new ActiveChatResponses();
    let releaseCleanup!: () => void;
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    const cleanupBlocked = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const response = responses.start({ db, provider, ownerId: owner.id, chat, userMessage, providerRequest: { messages: [{ role: "user", content: "Finish" }], model: "gpt-test" }, prepareTurn: async () => { throw new Error("No queued turns expected."); } });
    response.trackResources({ cleanup: { id: "slow-cleanup", run: async () => { markCleanupStarted(); await cleanupBlocked; } } });

    await cleanupStarted;

    expect(responses.has(chat.id)).toBe(false);
    releaseCleanup();
  });

  it("reserves chat preparation before an active response starts", () => {
    const responses = new ActiveChatResponses();

    expect(responses.reserve("chat-1")).toBe(true);
    expect(responses.reserve("chat-1")).toBe(false);
    responses.releaseReservation("chat-1");
    expect(responses.reserve("chat-1")).toBe(true);
    responses.releaseReservation("chat-1");
    expect(responses.beginDeletion("chat-1")).toBe(true);
    expect(responses.reserve("chat-1")).toBe(false);
    responses.endDeletion("chat-1");
    expect(responses.reserve("chat-1")).toBe(true);
  });

  it("queues original upload references when steering is unavailable", async () => {
    const response = new ActiveChatResponse("chat-1");
    const uploaded: MessageAttachment = { id: "upload-1", uploadId: "upload-1", name: "notes.txt", mimeType: "text/plain", size: 5 };
    const resolved: MessageAttachment = { id: "upload-1", filePath: "/tmp/notes.txt", name: "notes.txt", mimeType: "text/plain", size: 5 };
    let cleaned = false;

    const result = await response.steer({ mode: "steer", content: "Use this", attachments: [resolved] }, { cleanup: { id: "steer-resources", run: async () => { throw new Error("Live-only resources should not be tracked."); } } });

    expect(result?.delivered).toBe(false);
    expect(result?.turn).toBeNull();
    response.trackResources({ cleanup: { id: "upload-claim", run: async () => { cleaned = true; } } });
    response.enqueue({ mode: "queue", content: "Use this", attachments: [uploaded] });
    expect(response.nextQueued()?.request.attachments).toEqual([uploaded]);
    await response.cleanupResources();
    expect(cleaned).toBe(true);
    expect(response.trackTemporaryFiles(["/tmp/late.txt"])).toBe(false);
  });

  it("rolls back pending resources when immediate steering fails", async () => {
    const response = new ActiveChatResponse("chat-1");
    const unregister = response.decorateProviderRequest({ messages: [], model: "gpt-test" }).controls!.onSteer(async () => { throw new Error("session closed"); });
    let cleaned = false;

    await expect(response.steer({ mode: "steer", content: "Use this" }, { cleanup: { id: "claim", run: async () => { cleaned = true; } }, temporaryFiles: ["/tmp/steer.txt"] })).rejects.toThrow("session closed");

    expect(response.pendingTurns).toEqual([]);
    await response.cleanupResources();
    expect(cleaned).toBe(false);
    unregister();
  });

  it("waits for failed in-flight steering before final resource cleanup", async () => {
    const response = new ActiveChatResponse("chat-1");
    let rejectSteer!: (error: Error) => void;
    let markSteerStarted!: () => void;
    const steerStarted = new Promise<void>((resolve) => { markSteerStarted = resolve; });
    const steerBlocked = new Promise<void>((_resolve, reject) => { rejectSteer = reject; });
    const unregister = response.decorateProviderRequest({ messages: [], model: "gpt-test" }).controls!.onSteer(async () => { markSteerStarted(); await steerBlocked; });
    let cleaned = false;
    const steering = response.steer({ mode: "steer", content: "Use this" }, { cleanup: { id: "claim", run: async () => { cleaned = true; } } }).catch((error: unknown) => error);
    await steerStarted;
    const cleaning = response.cleanupResources();

    rejectSteer(new Error("session closed"));
    await expect(steering).resolves.toBeInstanceOf(Error);
    await cleaning;

    expect(cleaned).toBe(false);
    unregister();
  });

  it("removes staged bytes when an accepted queued upload is abandoned", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 1024);
      const uploaded = await uploads.create("github:alice", { fileName: "queued.txt", mimeType: "text/plain", size: 6 }, Readable.from(["queued"]));
      const claimId = await uploads.claim("github:alice", [uploaded.uploadId!]);
      const response = new ActiveChatResponse("chat-1");
      response.trackResources({ cleanup: { id: "upload-claim", run: () => uploads.completeClaim("github:alice", claimId!) } });
      response.enqueue({ mode: "queue", content: "Use this", attachments: [uploaded], uploadClaimId: claimId! });

      await response.cleanupResources();

      await expect(uploads.get("github:alice", uploaded.uploadId!)).rejects.toThrow();
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it("assembles chunked uploads into one staged file the agent can open", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-workspace-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 10 * 1024 * 1024);
      const content = Buffer.from("a".repeat(2048) + "b".repeat(2048));
      const session = await uploads.beginChunked("github:alice", { fileName: "IMG_1234.jpg", mimeType: "image/jpeg", size: content.length });

      expect(await uploads.appendChunk("github:alice", session.uploadId, 0, content.subarray(0, 2048))).toEqual({ received: 2048, size: content.length });
      await expect(uploads.appendChunk("github:alice", session.uploadId, 4096, content.subarray(0, 10))).rejects.toThrow(UploadOffsetError);
      expect(await uploads.appendChunk("github:alice", session.uploadId, 0, content.subarray(0, 2048))).toEqual({ received: 2048, size: content.length });
      await expect(uploads.appendChunk("github:alice", session.uploadId, 2048, Buffer.alloc(4096))).rejects.toThrow("more bytes than declared");
      await uploads.appendChunk("github:alice", session.uploadId, 2048, content.subarray(2048));
      const uploaded = await uploads.finishChunked("github:alice", session.uploadId);

      expect(uploaded).toMatchObject({ name: "IMG_1234.jpg", mimeType: "image/jpeg", size: content.length });
      const stored = await uploads.get("github:alice", uploaded.uploadId!);
      expect(stored.sha256).toBe(createHash("sha256").update(content).digest("hex"));

      const claimId = await uploads.claim("github:alice", [uploaded.uploadId!]);
      const materialized = await materializeMessageAttachments({ uploads, ownerId: "github:alice", chatId: "chat-1", workspaceDir, maxBytes: 10 * 1024 * 1024, uploadClaimId: claimId, attachments: [uploaded] });
      const filePath = materialized.attachments[0]?.filePath;

      expect(filePath).toMatch(new RegExp(`${path.join(workspaceDir, ".copilotchat", "uploads", "chat-1")}/.*IMG_1234\\.jpg$`));
      expect(fs.readFileSync(filePath!).equals(content)).toBe(true);
      await uploads.completeClaim("github:alice", claimId!);
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("releases chunked upload reservations when a session fails or expires", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 1024, 8, 4, 0);
      const abandoned = await uploads.beginChunked("github:alice", { fileName: "abandoned.bin", mimeType: "application/octet-stream", size: 8 });
      await uploads.appendChunk("github:alice", abandoned.uploadId, 0, Buffer.alloc(4));
      await expect(uploads.beginChunked("github:alice", { fileName: "blocked.bin", mimeType: "application/octet-stream", size: 8 })).rejects.toThrow("per-owner limit");

      await uploads.cleanupExpired();

      expect(fs.readdirSync(uploadDir)).toEqual([]);
      const incomplete = await uploads.beginChunked("github:alice", { fileName: "incomplete.bin", mimeType: "application/octet-stream", size: 8 });
      await uploads.appendChunk("github:alice", incomplete.uploadId, 0, Buffer.alloc(4));
      await expect(uploads.finishChunked("github:alice", incomplete.uploadId)).rejects.toThrow("size mismatch");
      await expect(uploads.appendChunk("github:alice", incomplete.uploadId, 4, Buffer.alloc(4))).rejects.toThrow("session not found");

      expect(fs.readdirSync(uploadDir)).toEqual([]);
      const reusable = await uploads.beginChunked("github:alice", { fileName: "reusable.bin", mimeType: "application/octet-stream", size: 8 });
      await uploads.appendChunk("github:alice", reusable.uploadId, 0, Buffer.alloc(8));
      await expect(uploads.finishChunked("github:alice", reusable.uploadId)).resolves.toMatchObject({ size: 8 });
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it("tears down chunked uploads when owner data is cleared", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 1024, 64, 4);
      const session = await uploads.beginChunked("github:alice", { fileName: "half.bin", mimeType: "application/octet-stream", size: 8 });
      await uploads.appendChunk("github:alice", session.uploadId, 0, Buffer.alloc(4));

      await uploads.clearOwner("github:alice", async () => undefined);

      expect(fs.readdirSync(uploadDir)).toEqual([]);
      await expect(uploads.appendChunk("github:alice", session.uploadId, 4, Buffer.alloc(4))).rejects.toThrow("session not found");
      const replacement = await uploads.beginChunked("github:alice", { fileName: "again.bin", mimeType: "application/octet-stream", size: 64 });
      await uploads.appendChunk("github:alice", replacement.uploadId, 0, Buffer.alloc(64));
      await expect(uploads.finishChunked("github:alice", replacement.uploadId)).resolves.toMatchObject({ size: 64 });
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it("discards a finalized upload when its completion response was lost", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 1024, 8, 1);
      const session = await uploads.beginChunked("github:alice", { fileName: "done.bin", mimeType: "application/octet-stream", size: 8 });
      await uploads.appendChunk("github:alice", session.uploadId, 0, Buffer.alloc(8));
      const finishing = uploads.finishChunked("github:alice", session.uploadId);
      // An abort that races finalization must not slip between publishing the data and publishing the metadata.
      await expect(uploads.abortChunked("github:alice", session.uploadId)).rejects.toThrow("still being written");
      await finishing;

      await uploads.abortChunked("github:alice", session.uploadId);

      expect(fs.readdirSync(uploadDir)).toEqual([]);
      const reopened = await uploads.beginChunked("github:alice", { fileName: "next.bin", mimeType: "application/octet-stream", size: 8 });
      await uploads.abortChunked("github:alice", reopened.uploadId);
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it("removes untracked partial uploads instead of holding disk outside the quota", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 1024);
      const live = await uploads.beginChunked("github:alice", { fileName: "live.bin", mimeType: "application/octet-stream", size: 8 });
      await uploads.appendChunk("github:alice", live.uploadId, 0, Buffer.alloc(4));
      fs.writeFileSync(path.join(uploadDir, "restarted.upload.part"), "orphan from a previous process");

      await uploads.cleanupExpired();

      expect(fs.existsSync(path.join(uploadDir, "restarted.upload.part"))).toBe(false);
      expect(fs.existsSync(path.join(uploadDir, `${live.uploadId}.upload.part`))).toBe(true);
      await uploads.appendChunk("github:alice", live.uploadId, 4, Buffer.alloc(4));
      await expect(uploads.finishChunked("github:alice", live.uploadId)).resolves.toMatchObject({ size: 8 });
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it("enforces staged upload quotas and cleans orphaned files", async () => {    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 1024, 6, 2);
      await uploads.create("github:alice", { fileName: "first.bin", mimeType: "application/octet-stream", size: 4 }, Readable.from(["1234"]));
      await expect(uploads.create("github:alice", { fileName: "second.bin", mimeType: "application/octet-stream", size: 3 }, Readable.from(["123"]))).rejects.toThrow("per-owner limit");
      const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const orphanPath = path.join(uploadDir, "orphan.upload");
      const partialPath = path.join(uploadDir, "partial.upload.part");
      const metadataPartialPath = path.join(uploadDir, "metadata.json.part");
      fs.writeFileSync(orphanPath, "orphan");
      fs.writeFileSync(partialPath, "partial");
      fs.writeFileSync(metadataPartialPath, "partial");
      fs.utimesSync(orphanPath, staleTime, staleTime);
      fs.utimesSync(partialPath, staleTime, staleTime);
      fs.utimesSync(metadataPartialPath, staleTime, staleTime);

      await uploads.cleanupExpired();

      expect(fs.existsSync(orphanPath)).toBe(false);
      expect(fs.existsSync(partialPath)).toBe(false);
      expect(fs.existsSync(metadataPartialPath)).toBe(false);
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it("coordinates owner deletion with active upload streams", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    let releaseStream!: () => void;
    let markStreamStarted!: () => void;
    const streamBlocked = new Promise<void>((resolve) => { releaseStream = resolve; });
    const streamStarted = new Promise<void>((resolve) => { markStreamStarted = resolve; });
    try {
      const uploads = new UploadedFileStore(uploadDir, 1024);
      const source = Readable.from((async function* () { markStreamStarted(); await streamBlocked; yield "data"; })());
      const creating = uploads.create("github:alice", { fileName: "active.bin", mimeType: "application/octet-stream", size: 4 }, source);
      await streamStarted;
      let deletionSettled = false;
      let clearActionRan = false;
      const deleting = uploads.clearOwner("github:alice", async () => { clearActionRan = true; }).finally(() => { deletionSettled = true; });

      await expect(uploads.create("github:alice", { fileName: "late.bin", mimeType: "application/octet-stream", size: 1 }, Readable.from(["x"]))).rejects.toThrow("being cleared");
      expect(deletionSettled).toBe(false);
      expect(clearActionRan).toBe(false);
      releaseStream();
      const uploaded = await creating;

      await expect(deleting).resolves.toBeUndefined();
      expect(clearActionRan).toBe(true);
      await expect(uploads.get("github:alice", uploaded.uploadId!)).rejects.toThrow();
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it("keeps legacy base64 ZIP draft content as text", async () => {
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-import-drafts-"));
    try {
      const draftStore = new ImportDraftStore(draftDir);
      const content = Buffer.from("legacy zip bytes").toString("base64");
      const draft = await draftStore.create("github:alice", { source: "auto", fileName: "export.zip", encoding: "base64", content });

      await expect(draftStore.readContent(await draftStore.get("github:alice", draft.id))).resolves.toBe(content);
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it("enforces a separate import size limit", async () => {
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-import-drafts-"));
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    try {
      const draftStore = new ImportDraftStore(draftDir, 4);
      await expect(draftStore.create("github:alice", { source: "auto", fileName: "large.json", encoding: "text", content: "12345" })).rejects.toBeInstanceOf(ImportLimitError);
      expect(() => assertImportPayloadSize({ fileName: "export.zip", encoding: "base64", content: Buffer.from("12345").toString("base64") }, 4)).toThrow("limit");
      expect(() => assertImportPayloadSize({ fileName: "export.zip", encoding: "base64", content: Buffer.from("1234").toString("base64") }, 4)).not.toThrow();
      expect(() => assertImportPayloadSize({ fileName: "large.json", encoding: "base64", content: " \n[]".repeat(100) }, 4)).toThrow("text encoding");
      expect(() => assertImportPayloadSize({ fileName: "export.zip", encoding: "base64", content: "!!!!" }, 4)).toThrow("valid base64");
      const uploads = new UploadedFileStore(uploadDir, 1024);
      const uploaded = await uploads.create("github:alice", { fileName: "large.json", mimeType: "application/json", size: 5 }, Readable.from(["12345"]));
      const claimId = await uploads.claim("github:alice", [uploaded.uploadId!]);
      await expect(draftStore.createFromUpload("github:alice", "auto", uploads, uploaded.uploadId!, claimId!)).rejects.toThrow("limit");
      uploads.abandonClaim("github:alice", claimId!);
      await expect(uploads.get("github:alice", uploaded.uploadId!)).resolves.toBeDefined();
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it("enforces aggregate import draft storage per owner", async () => {
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-import-drafts-"));
    try {
      const seedStore = new ImportDraftStore(draftDir, 10, 10_000);
      const first = await seedStore.create("github:alice", { source: "auto", fileName: "draft.json", encoding: "text", content: "1234" });
      const firstBytes = fs.statSync(path.join(draftDir, `${first.id}.json`)).size + fs.statSync(path.join(draftDir, `${first.id}.data`)).size;
      const draftStore = new ImportDraftStore(draftDir, 10, firstBytes + 1);

      await expect(draftStore.create("github:alice", { source: "auto", fileName: "draft.json", encoding: "text", content: "5678" })).rejects.toThrow("per-owner limit");

      await draftStore.delete("github:alice", first.id);
      await expect(draftStore.create("github:alice", { source: "auto", fileName: "draft.json", encoding: "text", content: "5678" })).resolves.toBeDefined();

      const encodedDir = path.join(draftDir, "encoded");
      const encodedSeed = new ImportDraftStore(encodedDir, 10, 10_000);
      const encoded = await encodedSeed.create("github:alice", { source: "auto", fileName: "encoded.zip", encoding: "base64", content: Buffer.from("1234").toString("base64") });
      const encodedBytes = fs.statSync(path.join(encodedDir, `${encoded.id}.json`)).size + fs.statSync(path.join(encodedDir, `${encoded.id}.data`)).size;
      await encodedSeed.delete("github:alice", encoded.id);
      const encodedLimited = new ImportDraftStore(encodedDir, 10, encodedBytes - 1);
      await expect(encodedLimited.create("github:alice", { source: "auto", fileName: "encoded.zip", encoding: "base64", content: Buffer.from("1234").toString("base64") })).rejects.toThrow("per-owner limit");
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it("drops oversized legacy message metadata when listing messages", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Metadata chat", projectId: null, workspaceId: null });
    db.addMessage({ chatId: chat.id, role: "assistant", content: "Large metadata", provider: "echo", metadata: { activities: [{ output: "x".repeat(26_000_000) }] } });

    const [message] = db.listMessages(chat.id);

    expect(message?.metadata).toEqual({});
  });

  it("uses project default models unless a chat has its own model", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Model project", description: null, instructions: "", defaultModel: "gpt-5-mini" });
    const projectChat = db.createChat(owner.id, { title: "Project default", projectId: project.id, workspaceId: null });
    const chatOverride = db.createChat(owner.id, { title: "Chat override", projectId: project.id, workspaceId: null, model: "gpt-5.2-codex" });
    db.addMessage({ chatId: projectChat.id, role: "user", content: "Use project model" });
    db.addMessage({ chatId: chatOverride.id, role: "user", content: "Use chat model" });

    const projectRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat: projectChat, message: { content: "Use project model", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });
    const overrideRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat: chatOverride, message: { content: "Use chat model", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(projectRequest.model).toBe("gpt-5-mini");
    expect(overrideRequest.model).toBe("gpt-5.2-codex");
  });

  it("passes the requested permission mode into provider requests", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Permission chat", projectId: null, workspaceId: null });
    db.addMessage({ chatId: chat.id, role: "user", content: "Use yolo permissions" });

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Use yolo permissions", skillIds: [], permissionMode: "yolo" }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.permissionMode).toBe("yolo");
  });

  it("does not restore a stale provider session after a context mutation cancels the active response", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Context race", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Start with old context" });
    let markStarted!: () => void;
    let releaseSession!: () => void;
    let markClosed!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const provider: CopilotProvider = {
      id: "sdk",
      label: "SDK",
      status: async () => ({ id: "sdk", label: "SDK", available: true, details: "test", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: "gpt-test" }),
      async *streamChat() {
        markStarted();
        try {
          await sessionGate;
          yield { type: "session", sessionId: "stale-session", workspacePath: "/tmp/stale", resumed: false, infinite: true };
          yield { type: "done" };
        } finally {
          markClosed();
        }
      },
    };
    const responses = new ActiveChatResponses();
    responses.start({ db, provider, ownerId: owner.id, chat, userMessage, providerRequest: { messages: [{ role: "user", content: "Start with old context" }], model: "gpt-test" }, prepareTurn: async () => { throw new Error("No queued turns expected."); } });
    await started;

    expect(responses.cancel(chat.id)).toBe(true);
    db.updateUserContext(owner.id, { profile: "New context" });
    releaseSession();
    await closed;

    expect(db.getChat(owner.id, chat.id)).toMatchObject({ providerSessionId: null, providerSessionWorkspacePath: null });
    expect(db.listMessages(chat.id).some((message) => message.role === "assistant")).toBe(false);
  });

  it("accumulates AI credit usage per chat and persists it on the assistant message", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Usage chat", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Spend some credits" });
    const provider: CopilotProvider = {
      id: "echo",
      label: "Echo",
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: "gpt-test" }),
      async *streamChat() {
        yield { type: "usage", nanoAiu: 120_000_000, model: "gpt-test" };
        yield { type: "delta", text: "Done." };
        yield { type: "usage", nanoAiu: 30_000_000, model: "gpt-test" };
        yield { type: "done" };
      },
    };
    const responses = new ActiveChatResponses();

    responses.start({ db, provider, ownerId: owner.id, chat, userMessage, providerRequest: { messages: [{ role: "user", content: "Spend some credits" }], model: "gpt-test" }, prepareTurn: async () => { throw new Error("No queued turns expected."); } });
    await waitForCondition(() => db.listMessages(chat.id).some((message) => message.role === "assistant"));

    const assistant = db.listMessages(chat.id).find((message) => message.role === "assistant");
    expect(assistant?.metadata.usage).toEqual({ nanoAiu: 150_000_000 });
    expect(db.getChat(owner.id, chat.id).totalNanoAiu).toBe(150_000_000);
  });

  it("attributes subagent AI credit usage to its activity card and the chat total", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Subagent usage chat", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Delegate and spend" });
    const provider: CopilotProvider = {
      id: "echo",
      label: "Echo",
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: "gpt-test" }),
      async *streamChat() {
        yield { type: "usage", nanoAiu: 100_000_000, model: "gpt-test" };
        yield { type: "subagent-start", id: "research-agent", name: "research", displayName: "Research agent" };
        yield { type: "usage", nanoAiu: 40_000_000, model: "gpt-test", agentId: "research-agent" };
        yield { type: "usage", nanoAiu: 35_000_000, model: "gpt-test", agentId: "research-agent" };
        yield { type: "usage", nanoAiu: 25_000_000, model: "gpt-test", agentId: "unknown-agent" };
        yield { type: "subagent-complete", id: "research-agent", name: "research", displayName: "Research agent", durationMs: 10 };
        yield { type: "delta", text: "Done." };
        yield { type: "done" };
      },
    };
    const responses = new ActiveChatResponses();

    responses.start({ db, provider, ownerId: owner.id, chat, userMessage, providerRequest: { messages: [{ role: "user", content: "Delegate and spend" }], model: "gpt-test" }, prepareTurn: async () => { throw new Error("No queued turns expected."); } });
    await waitForCondition(() => db.listMessages(chat.id).some((message) => message.role === "assistant"));

    const assistant = db.listMessages(chat.id).find((message) => message.role === "assistant");
    const activities = assistant?.metadata.activities as Array<{ type?: string; details?: { nanoAiu?: number; name?: string } }> | undefined;
    const subagent = activities?.find((activity) => activity.type === "subagent");
    expect(subagent?.details?.nanoAiu).toBe(75_000_000);
    expect(subagent?.details?.name).toBe("research");
    expect(assistant?.metadata.usage).toEqual({ nanoAiu: 200_000_000 });
    expect(db.getChat(owner.id, chat.id).totalNanoAiu).toBe(200_000_000);
  });

  it("keeps chat AI credit totals across turns and ignores non-positive usage", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Running total chat", projectId: null, workspaceId: null });

    expect(db.addChatUsage(owner.id, chat.id, 40_000_000).totalNanoAiu).toBe(40_000_000);
    expect(db.addChatUsage(owner.id, chat.id, 60_000_000).totalNanoAiu).toBe(100_000_000);
    expect(db.addChatUsage(owner.id, chat.id, 0).totalNanoAiu).toBe(100_000_000);
    expect(db.addChatUsage(owner.id, chat.id, Number.NaN).totalNanoAiu).toBe(100_000_000);
  });

  it("hides title-tool activity when the SDK reports it as a generic tool", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Title chat", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Name this chat" });
    const provider: CopilotProvider = {
      id: "sdk",
      label: "SDK",
      status: async () => ({ id: "sdk", label: "SDK", available: true, details: "test", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: "gpt-test" }),
      async *streamChat() {
        yield { type: "tool-call", id: "title-call", toolName: "Tool", input: null };
        yield { type: "tool-result", id: "title-call", toolName: "Tool", status: "succeeded", output: { content: "{\"title\":\"Multiple Choice Question\"}", detailedContent: "{\"title\":\"Multiple Choice Question\"}" } };
        yield { type: "delta", text: "Done." };
        yield { type: "done" };
      },
    };
    const responses = new ActiveChatResponses();

    responses.start({ db, provider, ownerId: owner.id, chat, userMessage, providerRequest: { messages: [{ role: "user", content: "Name this chat" }], model: "gpt-test" }, prepareTurn: async () => { throw new Error("No queued turns expected."); } });
    await waitForCondition(() => db.listMessages(chat.id).some((message) => message.role === "assistant"));

    const assistant = db.listMessages(chat.id).find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Done.");
    expect(assistant?.metadata).toEqual({});
  });

  it("truncates oversized tool activity payloads before persistence", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Payload chat", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Run a large tool" });
    const payload = "x".repeat(60_000);
    const provider: CopilotProvider = {
      id: "echo",
      label: "Echo",
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: "gpt-test" }),
      async *streamChat() {
        yield { type: "tool-call", id: "large-tool", toolName: "big.search", input: { query: payload } };
        yield { type: "tool-result", id: "large-tool", toolName: "big.search", status: "failed", output: { content: payload }, error: payload };
        yield { type: "delta", text: "Done." };
        yield { type: "done" };
      },
    };
    const responses = new ActiveChatResponses();

    responses.start({ db, provider, ownerId: owner.id, chat, userMessage, providerRequest: { messages: [{ role: "user", content: "Run a large tool" }], model: "gpt-test" }, prepareTurn: async () => { throw new Error("No queued turns expected."); } });
    await waitForCondition(() => db.listMessages(chat.id).some((message) => message.role === "assistant"));

    const assistant = db.listMessages(chat.id).find((message) => message.role === "assistant");
    const activities = assistant?.metadata.activities;
    expect(Array.isArray(activities)).toBe(true);
    const activity = (activities as Array<{ input?: { query?: string }; output?: { content?: string }; error?: string }>)[0];
    expect(activity?.input?.query?.length).toBeLessThan(payload.length);
    expect(activity?.output?.content).toContain("[truncated");
    expect(activity?.error).toContain("[truncated");
    expect(JSON.stringify(assistant?.metadata).length).toBeLessThan(80_000);
  });

  it("deduplicates cumulative assistant deltas", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Delta chat", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Stream cumulatively" });
    const provider: CopilotProvider = {
      id: "echo",
      label: "Echo",
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: "gpt-test" }),
      async *streamChat() {
        yield { type: "delta", text: "Hello" };
        yield { type: "delta", text: "Hello world" };
        yield { type: "delta", text: "Hello world!" };
        yield { type: "done" };
      },
    };
    const responses = new ActiveChatResponses();

    responses.start({ db, provider, ownerId: owner.id, chat, userMessage, providerRequest: { messages: [{ role: "user", content: "Stream cumulatively" }], model: "gpt-test" }, prepareTurn: async () => { throw new Error("No queued turns expected."); } });
    await waitForCondition(() => db.listMessages(chat.id).some((message) => message.role === "assistant"));

    expect(db.listMessages(chat.id).find((message) => message.role === "assistant")?.content).toBe("Hello world!");
  });

  it("preserves repeated non-cumulative assistant deltas", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Repeated delta chat", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Repeat words" });
    const provider: CopilotProvider = {
      id: "echo",
      label: "Echo",
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: "gpt-test" }),
      async *streamChat() {
        yield { type: "delta", text: "very" };
        yield { type: "delta", text: " very" };
        yield { type: "delta", text: " very" };
        yield { type: "done" };
      },
    };
    const responses = new ActiveChatResponses();

    responses.start({ db, provider, ownerId: owner.id, chat, userMessage, providerRequest: { messages: [{ role: "user", content: "Repeat words" }], model: "gpt-test" }, prepareTurn: async () => { throw new Error("No queued turns expected."); } });
    await waitForCondition(() => db.listMessages(chat.id).some((message) => message.role === "assistant"));

    expect(db.listMessages(chat.id).find((message) => message.role === "assistant")?.content).toBe("very very very");
  });

  it("persists expanded subagent content and thinking", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Subagent chat", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Delegate the work" });
    const provider: CopilotProvider = {
      id: "echo",
      label: "Echo",
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: "gpt-test" }),
      async *streamChat() {
        yield { type: "subagent-start", id: "research-agent", name: "research", displayName: "Research agent", description: "Inspect context." };
        yield { type: "subagent-reasoning-delta", id: "research-agent", text: "Thinking about sources." };
        yield { type: "subagent-delta", id: "research-agent", text: "Found the relevant context." };
        yield { type: "subagent-complete", id: "research-agent", name: "research", displayName: "Research agent" };
        yield { type: "delta", text: "Done." };
        yield { type: "done" };
      },
    };
    const responses = new ActiveChatResponses();

    responses.start({ db, provider, ownerId: owner.id, chat, userMessage, providerRequest: { messages: [{ role: "user", content: "Delegate the work" }], model: "gpt-test" }, prepareTurn: async () => { throw new Error("No queued turns expected."); } });
    await waitForCondition(() => db.listMessages(chat.id).some((message) => message.role === "assistant"));

    const assistant = db.listMessages(chat.id).find((message) => message.role === "assistant");
    const activities = assistant?.metadata.activities as Array<{ type?: string; content?: string; steps?: Array<{ type?: string; content?: string }> }> | undefined;
    const subagent = activities?.find((activity) => activity.type === "subagent");
    expect(subagent?.content).toContain("Found the relevant context.");
    expect(subagent?.steps?.find((step) => step.type === "reasoning")?.content).toContain("Thinking about sources.");
  });

  it("compacts persisted activity metadata so refresh keeps tool and subagent cards", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Long activity chat", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Run a large delegated search" });
    const large = "x".repeat(20_000);
    const provider: CopilotProvider = {
      id: "echo",
      label: "Echo",
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: "gpt-test" }),
      async *streamChat() {
        yield { type: "subagent-start", id: "research-agent", name: "research", displayName: "Research agent", description: "Inspect context." };
        yield { type: "subagent-delta", id: "research-agent", text: large };
        for (let index = 0; index < 80; index += 1) {
          yield { type: "subagent-tool-call", id: "research-agent", toolCallId: `tool-${index}`, toolName: "search", input: { query: `${index}-${large}` } };
          yield { type: "subagent-tool-result", id: "research-agent", toolCallId: `tool-${index}`, toolName: "search", status: "succeeded", output: { result: large } };
        }
        yield { type: "subagent-complete", id: "research-agent", name: "research", displayName: "Research agent" };
        yield { type: "delta", text: "Done." };
        yield { type: "done" };
      },
    };
    const responses = new ActiveChatResponses();

    responses.start({ db, provider, ownerId: owner.id, chat, userMessage, providerRequest: { messages: [{ role: "user", content: "Run a large delegated search" }], model: "gpt-test" }, prepareTurn: async () => { throw new Error("No queued turns expected."); } });
    await waitForCondition(() => db.listMessages(chat.id).some((message) => message.role === "assistant"));

    const assistant = db.listMessages(chat.id).find((message) => message.role === "assistant");
    const metadataJson = JSON.stringify(assistant?.metadata ?? {});
    const activities = assistant?.metadata.activities as Array<{ type?: string; steps?: unknown[]; content?: string }> | undefined;
    const subagent = activities?.find((activity) => activity.type === "subagent");
    expect(metadataJson.length).toBeLessThan(1_000_000);
    expect(subagent?.content).toContain("[truncated");
    expect(subagent?.steps?.length).toBeLessThanOrEqual(24);
    expect(subagent?.steps?.some((step) => JSON.stringify(step).includes("intermediate steps omitted"))).toBe(true);
  });

  it("caps runaway assistant output before persistence", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Long output chat", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Stream a huge response" });
    const chunk = "x".repeat(250_000);
    const provider: CopilotProvider = {
      id: "echo",
      label: "Echo",
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: "gpt-test" }),
      async *streamChat() {
        for (let index = 0; index < 8; index += 1) yield { type: "delta", text: `${index}${chunk}` };
        yield { type: "done" };
      },
    };
    const responses = new ActiveChatResponses();

    responses.start({ db, provider, ownerId: owner.id, chat, userMessage, providerRequest: { messages: [{ role: "user", content: "Stream a huge response" }], model: "gpt-test" }, prepareTurn: async () => { throw new Error("No queued turns expected."); } });
    await waitForCondition(() => db.listMessages(chat.id).some((message) => message.role === "assistant"));

    const content = db.listMessages(chat.id).find((message) => message.role === "assistant")?.content ?? "";
    expect(content.length).toBeLessThan(1_020_000);
    expect(content).toContain("Response truncated");
  });

  it("replays a snapshot and sends heartbeats when a client reattaches mid-response", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Reconnect chat", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Keep streaming" });
    let finishTurn = (): void => {};
    const turnFinished = new Promise<void>((resolve) => { finishTurn = resolve; });
    const provider: CopilotProvider = {
      id: "echo",
      label: "Echo",
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], modelsAuthoritative: false, defaultModel: "gpt-test" }),
      async *streamChat() {
        yield { type: "delta", text: "Partial answer" };
        await turnFinished;
        yield { type: "done" };
      },
    };
    const responses = new ActiveChatResponses();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      responses.start({ db, provider, ownerId: owner.id, chat, userMessage, providerRequest: { messages: [{ role: "user", content: "Keep streaming" }], model: "gpt-test" }, prepareTurn: async () => { throw new Error("No queued turns expected."); } });
      const first = createFakeSseReply();
      responses.attach(chat.id, first.reply);
      // The snapshot goes out even before any content exists so a reconnecting client knows the turn is live.
      expect(first.writes[0]).toBe(": connected\n\n");
      expect(first.writes[1]?.startsWith("event: snapshot")).toBe(true);
      await waitForCondition(() => first.writes.some((chunk) => chunk.includes("Partial answer")));

      // A client that lost its connection must be able to pick the running turn back up.
      const reconnected = createFakeSseReply();
      responses.attach(chat.id, reconnected.reply);
      const snapshot = reconnected.writes.find((chunk) => chunk.startsWith("event: snapshot"));
      expect(snapshot).toContain("Partial answer");

      vi.advanceTimersByTime(sseHeartbeatIntervalMs + 10);
      expect(reconnected.writes.filter((chunk) => chunk.startsWith(": ping"))).toHaveLength(1);

      reconnected.close();
      vi.advanceTimersByTime(sseHeartbeatIntervalMs * 3);
      expect(reconnected.writes.filter((chunk) => chunk.startsWith(": ping"))).toHaveLength(1);
    } finally {
      finishTurn();
      vi.useRealTimers();
    }
    await waitForCondition(() => db.listMessages(chat.id).some((message) => message.role === "assistant"));
  });

  it("tells a client that no response is active when there is nothing to reattach to", () => {
    const responses = new ActiveChatResponses();
    const { reply, writes } = createFakeSseReply();

    responses.attach("missing-chat", reply);

    expect(writes.some((chunk) => chunk.startsWith("event: done") && chunk.includes("\"active\":false"))).toBe(true);
  });

  it("auto-activates installed skills by activation rule or explicit name mention", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Skill chat", projectId: null, workspaceId: null });
    db.upsertSkill(owner.id, { id: "release-notes", name: "Release notes", description: "Draft release notes.", version: "1.0.0", instructions: "Write crisp release notes.", prompts: [], workflow: [], artifactTemplates: [], mcpDependencies: [], toolDependencies: [], activationRules: ["User asks for changelog"], permissions: [] }, false, null);
    db.addMessage({ chatId: chat.id, role: "user", content: "Please write a changelog." });

    const ruleRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Please write a changelog.", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });
    const nameRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Use Release notes for this.", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(ruleRequest.skills?.map((skill) => skill.name)).toContain("Release notes");
    expect(nameRequest.skills?.map((skill) => skill.name)).toContain("Release notes");
  });

  it("keeps explicitly selected skills active even when the prompt does not match rules", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Explicit skill", projectId: null, workspaceId: null });
    db.upsertSkill(owner.id, { id: "shipper", name: "Shipper", description: "Ship things.", version: "1.0.0", instructions: "Ship the thing.", prompts: [], workflow: [], artifactTemplates: [], mcpDependencies: [], toolDependencies: [], activationRules: ["User asks to ship"], permissions: [] }, false, null);
    db.addMessage({ chatId: chat.id, role: "user", content: "Hello." });

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Hello.", skillIds: ["shipper"] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.skills?.map((skill) => skill.name)).toEqual(["Shipper"]);
  });

  it("persists chat model choices and clears stale provider sessions when they change", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Model chat", projectId: null, workspaceId: null, model: "gpt-4.1", reasoningEffort: "medium", contextTier: "default" });
    db.setChatProviderSession(owner.id, chat.id, { providerSessionId: "old-session", providerSessionWorkspacePath: "/tmp/old" });

    const updated = db.updateChat(owner.id, chat.id, { model: "gpt-5-mini", reasoningEffort: "high", contextTier: "long_context" });

    expect(updated.model).toBe("gpt-5-mini");
    expect(updated.reasoningEffort).toBe("high");
    expect(updated.contextTier).toBe("long_context");
    expect(updated.providerSessionId).toBeNull();
    expect(updated.providerSessionWorkspacePath).toBeNull();
    db.addMessage({ chatId: updated.id, role: "user", content: "Use the new settings" });
    const nextRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat: updated, message: { content: "Use the new settings", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });
    expect(nextRequest.sessionId).not.toBe("old-session");
    expect(nextRequest.resumeSession).toBe(false);
  });

  it("applies project scope from a message request before provider context is built", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Scoped project", description: null, instructions: "Scoped instructions." });
    const chat = db.createChat(owner.id, { title: "New chat", projectId: null, workspaceId: null });

    const scopedChat = applyChatTurnScope(db, owner.id, chat.id, { projectId: project.id, workspaceId: undefined });
    db.addMessage({ chatId: scopedChat.id, role: "user", content: "Start in project context" });
    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat: scopedChat, message: { content: "Start in project context", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(scopedChat.projectId).toBe(project.id);
    expect(request.projectContext).toContain("Scoped instructions.");
    expect(request.messages).toEqual([{ role: "user", content: "Start in project context" }]);
  });

  it("injects project memory, reference materials, and pinned chat references", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Context project", description: null, instructions: "Use project instructions.", memory: "Decision: prefer durable files." });
    db.createProjectReference(owner.id, { projectId: project.id, title: "API notes", content: "Use the SDK session APIs." });
    const sourceChat = db.createChat(owner.id, { title: "Prior chat", projectId: project.id, workspaceId: null });
    db.addMessage({ chatId: sourceChat.id, role: "user", content: "The upload flow should keep source filenames." });
    const sourceMessage = db.addMessage({ chatId: sourceChat.id, role: "assistant", content: "Remember filenames in upload metadata.", provider: "echo" });
    db.createProjectChatReference(owner.id, { projectId: project.id, messageId: sourceMessage.id });
    const chat = db.createChat(owner.id, { title: "Next chat", projectId: project.id, workspaceId: null });
    db.addMessage({ chatId: chat.id, role: "user", content: "What context do you have?" });

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "What context do you have?", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.projectContext).toContain("Use project instructions.");
    expect(request.projectContext).toContain("Decision: prefer durable files.");
    expect(request.projectContext).toContain("API notes");
    expect(request.projectContext).toContain("Use the SDK session APIs.");
    expect(request.projectContext).toContain("Remember filenames in upload metadata.");
  });

  it("searches messages within a project for cross-chat references", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Searchable", description: null, instructions: "" });
    const chat = db.createChat(owner.id, { title: "Search source", projectId: project.id, workspaceId: null });
    const message = db.addMessage({ chatId: chat.id, role: "assistant", content: "Needle content from an earlier answer.", provider: "echo" });

    const results = db.searchProjectMessages(owner.id, project.id, "Needle");

    expect(results[0]).toMatchObject({ chatId: chat.id, messageId: message.id, title: "Search source", excerpt: "Needle content from an earlier answer." });
  });

  it("clears project chat provider sessions when shared project context changes", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Shared context", description: null, instructions: "Old instructions." });
    const chat = db.createChat(owner.id, { title: "Project chat", projectId: project.id, workspaceId: null });
    db.setChatProviderSession(owner.id, chat.id, { providerSessionId: "old-session", providerSessionWorkspacePath: "/tmp/session" });

    db.updateProject(owner.id, project.id, { memory: "New shared memory." });

    const updated = db.getChat(owner.id, chat.id);
    expect(updated.providerSessionId).toBeNull();
    expect(updated.providerSessionWorkspacePath).toBeNull();
  });

  it("keeps pinned chat references unique and clears project sessions for new pins", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "References", description: null, instructions: "" });
    const chat = db.createChat(owner.id, { title: "Project chat", projectId: project.id, workspaceId: null });
    const message = db.addMessage({ chatId: chat.id, role: "assistant", content: "Reusable detail.", provider: "echo" });
    db.setChatProviderSession(owner.id, chat.id, { providerSessionId: "old-session", providerSessionWorkspacePath: "/tmp/session" });

    const first = db.createProjectChatReference(owner.id, { projectId: project.id, messageId: message.id });
    const second = db.createProjectChatReference(owner.id, { projectId: project.id, messageId: message.id });

    expect(second.id).toBe(first.id);
    expect(db.listProjectChatReferences(owner.id, project.id)).toHaveLength(1);
    expect(db.getChat(owner.id, chat.id).providerSessionId).toBeNull();
  });

  it("resumes the persisted SDK session for follow-up turns", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Persistent chat", projectId: null, workspaceId: null });
    const persisted = db.setChatProviderSession(owner.id, chat.id, { providerSessionId: "copilotchat-local-existing", providerSessionWorkspacePath: "/tmp/copilot-session" });
    db.addMessage({ chatId: persisted.id, role: "user", content: "Continue this" });

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat: persisted, message: { content: "Continue this", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.sessionId).toBe("copilotchat-local-existing");
    expect(request.resumeSession).toBe(true);
    expect(persisted.providerSessionWorkspacePath).toBe("/tmp/copilot-session");
  });

  it("uses registered workspace roots only for cowork chats", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-workspace-"));
    const workspace = db.registerWorkspace(owner.id, { name: "Repo", rootPath: workspaceRoot });
    const generalChat = db.createChat(owner.id, { title: "General", projectId: null, workspaceId: null });
    const coworkChat = db.createChat(owner.id, { title: "Cowork", projectId: null, workspaceId: workspace.id });

    const generalRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat: generalChat, message: { content: "No repo context", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });
    const coworkRequest = buildProviderChatRequest({ db, ownerId: owner.id, chat: coworkChat, message: { content: "Use repo context", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(generalRequest.workingDirectory).toBe(`/tmp/isolated/${generalChat.id}`);
    expect(coworkRequest.workingDirectory).toBe(path.resolve(workspaceRoot));
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("runs cowork commands inside the workspace and rejects outside paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-workspace-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-outside-"));
    try {
      fs.writeFileSync(path.join(root, "note.txt"), "inside\n");
      fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");
      const workspace = { id: "workspace", ownerId: "owner", name: "Repo", rootPath: root, enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

      await expect(runWorkspaceCommand({ workspace, command: "cat note.txt", cwd: ".", timeoutMs: 1000 })).resolves.toMatchObject({ stdout: "inside\n" });
      await expect(runWorkspaceCommand({ workspace, command: "node -e process.exit(0)", cwd: ".", timeoutMs: 1000 })).rejects.toThrow(/not in the workspace allowlist/);
      await expect(runWorkspaceCommand({ workspace, command: "python -c print(1)", cwd: ".", timeoutMs: 1000 })).rejects.toThrow(/not in the workspace allowlist/);
      await expect(runWorkspaceCommand({ workspace, command: "find . -exec echo {} +", cwd: ".", timeoutMs: 1000 })).rejects.toThrow(/not in the workspace allowlist/);
      await expect(runWorkspaceCommand({ workspace, command: "git status", cwd: ".", timeoutMs: 1000 })).rejects.toThrow(/not in the workspace allowlist/);
      await expect(runWorkspaceCommand({ workspace, command: `cat ${path.join(outside, "secret.txt")}`, cwd: ".", timeoutMs: 1000 })).rejects.toThrow(/must stay inside/);
      await expect(runWorkspaceCommand({ workspace, command: "cat ../secret.txt", cwd: ".", timeoutMs: 1000 })).rejects.toThrow(/must stay inside/);
      await expect(runWorkspaceCommand({ workspace, command: "pwd", cwd: "..", timeoutMs: 1000 })).rejects.toThrow(/must stay inside/);
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "secret-link.txt"));
      await expect(runWorkspaceCommand({ workspace, command: "cat secret-link.txt", cwd: ".", timeoutMs: 1000 })).rejects.toThrow(/must stay inside/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("limits GitHub workspace registrations to the owner's configured workspace root", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-workspace-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-outside-"));
    try {
      const aliceOwnerId = "github-id:1001";
      const aliceRoot = ownerWorkspaceRoot(workspaceRoot, aliceOwnerId);
      const aliceRepo = path.join(aliceRoot, "repo");
      fs.mkdirSync(aliceRepo, { recursive: true });

      expect(ownerWorkspaceDirectory(aliceOwnerId)).toBe("github-id-1001");
      expect(ownerWorkspaceDirectory("github:legacy-login")).toBe("legacy-login");
      await expect(validateRegisteredWorkspaceRoot({ authMode: "github", ownerId: aliceOwnerId, rootPath: aliceRepo, workspaceRoot })).resolves.toBe(fs.realpathSync(aliceRepo));
      await expect(validateRegisteredWorkspaceRoot({ authMode: "github", ownerId: aliceOwnerId, rootPath: outside, workspaceRoot })).rejects.toThrow(/configured workspace root/);
      await expect(validateRegisteredWorkspaceRoot({ authMode: "local", ownerId: "local", rootPath: outside, workspaceRoot })).resolves.toBe(fs.realpathSync(outside));
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("clears persisted provider sessions when chat scope changes", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Scoped", description: null, instructions: "" });
    const chat = db.createChat(owner.id, { title: "Scoped", projectId: null, workspaceId: null });
    const persisted = db.setChatProviderSession(owner.id, chat.id, { providerSessionId: "old-session", providerSessionWorkspacePath: "/tmp/old" });

    const updated = db.updateChat(owner.id, persisted.id, { projectId: project.id });

    expect(updated.providerSessionId).toBeNull();
    expect(updated.providerSessionWorkspacePath).toBeNull();
  });

  it("editing a user message truncates later turns and resets provider session state", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Editable", projectId: null, workspaceId: null });
    const first = db.addMessage({ chatId: chat.id, role: "user", content: "Original first" });
    db.addMessage({ chatId: chat.id, role: "assistant", content: "First answer", provider: "echo" });
    db.addMessage({ chatId: chat.id, role: "user", content: "Second turn" });
    db.setChatProviderSession(owner.id, chat.id, { providerSessionId: "old-session", providerSessionWorkspacePath: "/tmp/old" });

    const edited = db.editUserMessageAndTruncate(owner.id, chat.id, first.id, "Edited first");
    const updatedChat = db.getChat(owner.id, chat.id);
    const messages = db.listMessages(chat.id);

    expect(edited.content).toBe("Edited first");
    expect(messages.map((message) => `${message.role}:${message.content}`)).toEqual(["user:Edited first"]);
    expect(updatedChat.providerSessionId).toBeNull();
    expect(updatedChat.providerSessionWorkspacePath).toBeNull();
  });

  it("retrying an assistant message truncates from that response and returns the previous user message", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Retry", projectId: null, workspaceId: null });
    const first = db.addMessage({ chatId: chat.id, role: "user", content: "Try this" });
    const assistant = db.addMessage({ chatId: chat.id, role: "assistant", content: "Old answer", provider: "echo" });
    db.addMessage({ chatId: chat.id, role: "user", content: "Later turn" });
    db.setChatProviderSession(owner.id, chat.id, { providerSessionId: "old-session", providerSessionWorkspacePath: "/tmp/old" });

    const retryFrom = db.retryAssistantMessage(owner.id, chat.id, assistant.id);
    const updatedChat = db.getChat(owner.id, chat.id);
    const messages = db.listMessages(chat.id);

    expect(retryFrom.id).toBe(first.id);
    expect(messages.map((message) => `${message.role}:${message.content}`)).toEqual(["user:Try this"]);
    expect(updatedChat.providerSessionId).toBeNull();
    expect(updatedChat.providerSessionWorkspacePath).toBeNull();
  });

  it("keeps edit and retry mutations scoped to the chat owner", () => {
    const db = createTestDb();
    const alice = db.getOrCreateGitHubOwner({ providerUserId: "1001", login: "alice", displayName: "Alice", avatarUrl: null });
    const bob = db.getOrCreateGitHubOwner({ providerUserId: "1002", login: "bob", displayName: "Bob", avatarUrl: null });
    const bobChat = db.createChat(bob.id, { title: "Bob chat", projectId: null, workspaceId: null });
    const bobUser = db.addMessage({ chatId: bobChat.id, role: "user", content: "Bob secret" });
    const bobAssistant = db.addMessage({ chatId: bobChat.id, role: "assistant", content: "Bob answer", provider: "echo" });

    expect(() => db.editUserMessageAndTruncate(alice.id, bobChat.id, bobUser.id, "Alice edit")).toThrow("Chat not found.");
    expect(() => db.retryAssistantMessage(alice.id, bobChat.id, bobAssistant.id)).toThrow("Chat not found.");
    expect(db.listMessages(bobChat.id).map((message) => `${message.role}:${message.content}`)).toEqual(["user:Bob secret", "assistant:Bob answer"]);
  });

  it("writes artifacts to workspace files and syncs file edits back into the app", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Artifacts", projectId: null, workspaceId: null });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-artifacts-"));

    const result = await writeFileArtifact({ db, ownerId: owner.id, chat, messageId: null, workspaceDir: workspace, artifact: { title: "Design Doc", kind: "markdown", language: null, content: "# Draft" } });
    const filePath = path.join(fs.realpathSync(workspace), result.relativePath);
    expect(fs.readFileSync(filePath, "utf8")).toBe("# Draft");
    expect(result.artifact.filePath).toBe(filePath);

    fs.writeFileSync(filePath, "# Updated");
    await syncArtifactFiles({ db, ownerId: owner.id, chat, workspaceDir: workspace });
    const synced = db.listArtifacts(owner.id).find((artifact) => artifact.filePath === filePath);

    expect(synced?.content).toBe("# Updated");
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("keeps artifact file writes inside the workspace artifacts directory", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Artifacts", projectId: null, workspaceId: null });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-artifacts-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-outside-"));
    const outsideTarget = path.join(outside, "pwned");
    try {
      const result = await writeFileArtifact({ db, ownerId: owner.id, chat, messageId: null, workspaceDir: workspace, artifact: { title: "Exploit", kind: "code", language: path.relative(path.join(workspace, "artifacts"), outsideTarget), content: "owned" } });
      if (!result.artifact.filePath) throw new Error("Expected file-backed artifact.");

      expect(result.artifact.filePath.startsWith(path.join(fs.realpathSync(workspace), "artifacts") + path.sep)).toBe(true);
      expect(fs.existsSync(outsideTarget)).toBe(false);
      expect(fs.readFileSync(result.artifact.filePath, "utf8")).toBe("owned");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not sync symlinked artifact files outside the workspace", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Artifacts", projectId: null, workspaceId: null });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-artifacts-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-outside-"));
    try {
      const artifactDir = path.join(workspace, "artifacts");
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(outside, "secret.md"), "outside");
      fs.symlinkSync(path.join(outside, "secret.md"), path.join(artifactDir, "secret.md"));

      await expect(syncArtifactFiles({ db, ownerId: owner.id, chat, workspaceDir: workspace })).resolves.toEqual([]);
      expect(db.listArtifacts(owner.id)).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects artifact writes through a symlinked artifact directory", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Artifacts", projectId: null, workspaceId: null });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-artifacts-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-outside-"));
    try {
      fs.symlinkSync(outside, path.join(workspace, "artifacts"));

      await expect(writeFileArtifact({ db, ownerId: owner.id, chat, messageId: null, workspaceDir: workspace, artifact: { title: "Secret", kind: "markdown", language: null, content: "# Secret" } })).rejects.toThrow(/Artifact directory/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("conversation query tools", () => {
  it("searches conversations across, within, and outside the current project", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const projectA = db.createProject(owner.id, { name: "Alpha", description: null, instructions: "" });
    const projectB = db.createProject(owner.id, { name: "Beta", description: null, instructions: "" });
    const chatA = db.createChat(owner.id, { title: "Alpha chat", projectId: projectA.id, workspaceId: null });
    const chatB = db.createChat(owner.id, { title: "Beta chat", projectId: projectB.id, workspaceId: null });
    const general = db.createChat(owner.id, { title: "General chat", projectId: null, workspaceId: null });
    db.addMessage({ chatId: chatA.id, role: "assistant", content: "Alpha decided to use SQLite for storage.", provider: "echo" });
    db.addMessage({ chatId: chatB.id, role: "assistant", content: "Beta decided to use SQLite for storage.", provider: "echo" });
    db.addMessage({ chatId: general.id, role: "assistant", content: "General notes about SQLite storage.", provider: "echo" });

    const all = db.searchConversations(owner.id, "SQLite", { scope: "all", currentProjectId: projectA.id });
    expect(all.map((result) => result.chatId).sort()).toEqual([chatA.id, chatB.id, general.id].sort());
    expect(all.find((result) => result.chatId === chatB.id)?.projectName).toBe("Beta");
    expect(all.find((result) => result.chatId === general.id)?.projectId).toBeNull();

    const current = db.searchConversations(owner.id, "SQLite", { scope: "current_project", currentProjectId: projectA.id });
    expect(current.map((result) => result.chatId)).toEqual([chatA.id]);

    const others = db.searchConversations(owner.id, "SQLite", { scope: "other_projects", currentProjectId: projectA.id });
    expect(others.map((result) => result.chatId).sort()).toEqual([chatB.id, general.id].sort());

    expect(db.searchConversations(owner.id, "   ", { scope: "all", currentProjectId: null })).toEqual([]);
  });

  it("excludes the current chat and lists recent conversations with message counts", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Widgets", description: null, instructions: "" });
    const current = db.createChat(owner.id, { title: "Current chat", projectId: project.id, workspaceId: null });
    const past = db.createChat(owner.id, { title: "Past chat", projectId: project.id, workspaceId: null });
    db.addMessage({ chatId: current.id, role: "user", content: "Talk about Widgets" });
    db.addMessage({ chatId: past.id, role: "assistant", content: "Earlier Widgets discussion." });

    const search = db.searchConversations(owner.id, "widgets", { scope: "all", currentProjectId: project.id, excludeChatId: current.id });
    expect(search.map((result) => result.chatId)).toEqual([past.id]);

    const recent = db.listRecentConversations(owner.id, { scope: "all", currentProjectId: project.id, excludeChatId: current.id });
    expect(recent.map((conversation) => conversation.chatId)).toContain(past.id);
    expect(recent.map((conversation) => conversation.chatId)).not.toContain(current.id);
    expect(recent.find((conversation) => conversation.chatId === past.id)?.messageCount).toBe(1);
    expect(recent.find((conversation) => conversation.chatId === past.id)?.projectName).toBe("Widgets");
  });

  it("reads a conversation transcript scoped to the owner", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Source", projectId: null, workspaceId: null });
    db.addMessage({ chatId: chat.id, role: "user", content: "Question one" });
    db.addMessage({ chatId: chat.id, role: "assistant", content: "Answer one" });

    const transcript = db.getConversationTranscript(owner.id, chat.id);
    expect(transcript.messageCount).toBe(2);
    expect(transcript.truncated).toBe(false);
    expect(transcript.messages.map((message) => message.content)).toEqual(["Question one", "Answer one"]);
    expect(() => db.getConversationTranscript(owner.id, "missing-chat")).toThrow();
  });

  it("exposes conversation query tools to the model and resolves their handlers", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const project = db.createProject(owner.id, { name: "Alpha", description: null, instructions: "" });
    const sourceChat = db.createChat(owner.id, { title: "Source chat", projectId: project.id, workspaceId: null });
    db.addMessage({ chatId: sourceChat.id, role: "assistant", content: "Remember the migration plan details." });
    const activeChat = db.createChat(owner.id, { title: "Active chat", projectId: project.id, workspaceId: null });

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat: activeChat, message: { content: "What did we say?", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });
    expect((request.tools ?? []).map((tool) => tool.name)).toEqual(["search_past_conversations", "list_recent_conversations", "get_conversation"]);

    const tools = buildConversationTools({ db, ownerId: owner.id, chat: activeChat });
    const search = tools.find((tool) => tool.name === "search_past_conversations")!.handler({ query: "migration" }) as { count: number; results: Array<{ chatId: string }> };
    expect(search.count).toBe(1);
    expect(search.results[0]?.chatId).toBe(sourceChat.id);

    const list = tools.find((tool) => tool.name === "list_recent_conversations")!.handler({}) as { conversations: Array<{ chatId: string }> };
    expect(list.conversations.map((conversation) => conversation.chatId)).toContain(sourceChat.id);

    const transcript = tools.find((tool) => tool.name === "get_conversation")!.handler({ chatId: sourceChat.id }) as { messages: Array<{ content: string }> };
    expect(transcript.messages[0]?.content).toContain("migration plan");
  });
});

describe("chat file previews", () => {
  it("resolves workspace files the agent references and rejects paths that escape the workspace", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-files-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-outside-"));
    try {
      const workspaceDir = fs.realpathSync(workspaceRoot);
      fs.mkdirSync(path.join(workspaceDir, "artifacts"), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, "artifacts", "chart.png"), Buffer.from("png-bytes"));
      fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "secret");
      fs.symlinkSync(path.join(outsideRoot, "secret.txt"), path.join(workspaceDir, "escape.txt"));

      const open = async (requestedPath: string) => { const file = await resolveChatFile({ workspaceDir, requestedPath }); await file.handle.close(); return file; };
      const relative = await open("artifacts/chart.png");
      expect(relative.relativePath).toBe("artifacts/chart.png");
      expect(relative.mimeType).toBe("image/png");
      expect(relative.size).toBe(9);
      expect((await open("./artifacts/chart.png")).absolutePath).toBe(relative.absolutePath);
      expect((await open(relative.absolutePath)).absolutePath).toBe(relative.absolutePath);
      expect((await open(`file://${relative.absolutePath}`)).absolutePath).toBe(relative.absolutePath);

      // The descriptor must be the file the checks ran against, so bytes cannot be swapped after validation.
      const validated = await resolveChatFile({ workspaceDir, requestedPath: "artifacts/chart.png" });
      try {
        fs.rmSync(path.join(workspaceDir, "artifacts", "chart.png"));
        fs.symlinkSync(path.join(outsideRoot, "secret.txt"), path.join(workspaceDir, "artifacts", "chart.png"));
        expect((await validated.handle.readFile()).toString()).toBe("png-bytes");
        await expect(resolveChatFile({ workspaceDir, requestedPath: "artifacts/chart.png" })).rejects.toBeInstanceOf(ChatFileAccessError);
      } finally {
        await validated.handle.close();
        fs.rmSync(path.join(workspaceDir, "artifacts", "chart.png"));
        fs.writeFileSync(path.join(workspaceDir, "artifacts", "chart.png"), Buffer.from("png-bytes"));
      }

      await expect(resolveChatFile({ workspaceDir, requestedPath: "../outside.txt" })).rejects.toBeInstanceOf(ChatFileAccessError);
      await expect(resolveChatFile({ workspaceDir, requestedPath: path.join(outsideRoot, "secret.txt") })).rejects.toBeInstanceOf(ChatFileAccessError);
      await expect(resolveChatFile({ workspaceDir, requestedPath: "escape.txt" })).rejects.toBeInstanceOf(ChatFileAccessError);
      await expect(resolveChatFile({ workspaceDir, requestedPath: "https://example.com/a.png" })).rejects.toBeInstanceOf(ChatFileAccessError);
      await expect(resolveChatFile({ workspaceDir, requestedPath: "   " })).rejects.toBeInstanceOf(ChatFileAccessError);
      await expect(resolveChatFile({ workspaceDir, requestedPath: "artifacts" })).rejects.toBeInstanceOf(ChatFileNotFoundError);
      await expect(resolveChatFile({ workspaceDir, requestedPath: "artifacts/missing.png" })).rejects.toBeInstanceOf(ChatFileNotFoundError);

      // Rewriting a file in place must change its validator so a cached preview is replaced.
      const beforeRewrite = (await open("artifacts/chart.png")).etag;
      fs.writeFileSync(path.join(workspaceDir, "artifacts", "chart.png"), Buffer.from("different-bytes"));
      expect((await open("artifacts/chart.png")).etag).not.toBe(beforeRewrite);
      // A same-size rewrite must not reuse the validator either, however fast it lands.
      const sameSize = (await open("artifacts/chart.png")).etag;
      fs.writeFileSync(path.join(workspaceDir, "artifacts", "chart.png"), Buffer.from("different-BYTES"));
      expect((await open("artifacts/chart.png")).etag).not.toBe(sameSize);
      expect(bufferEtag(Buffer.from("abc"))).not.toBe(bufferEtag(Buffer.from("abd")));
      expect(bufferEtag(Buffer.from("abc"))).toBe(bufferEtag(Buffer.from("abc")));
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("never emits a client-supplied MIME type that Node would reject as a header", () => {
    // A CR/LF in the stored type throws while the response is already streaming, past Fastify's
    // error handling, which terminates the process.
    expect(safeContentType("text/plain\r\nX-Injected: yes")).toBe("application/octet-stream");
    expect(safeContentType("image/png\u0000")).toBe("application/octet-stream");
    expect(safeContentType("not-a-type")).toBe("application/octet-stream");
    expect(safeContentType("", "image/png")).toBe("image/png");
    expect(safeContentType(undefined)).toBe("application/octet-stream");
    expect(safeContentType(`text/${"a".repeat(300)}`)).toBe("application/octet-stream");
    expect(safeContentType("IMAGE/PNG")).toBe("image/png");
    expect(safeContentType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(() => new Response("", { headers: { "Content-Type": safeContentType("text/plain\r\nX-Injected: yes") } })).not.toThrow();
  });

  it("lists only the attachments still in the model's history, and caps the list", () => {
    const workspaceDir = "/tmp/workspace";
    const attachments = Array.from({ length: 45 }, (_, index) => ({ name: `file-${index}.png`, filePath: `${workspaceDir}/.copilotchat/uploads/chat-1/file-${index}.png` }));
    const context = chatFileSystemContext({ workspaceDir, attachments }) ?? "";
    expect(context).toContain("5 older uploads omitted");
    expect(context).not.toContain("file-4.png");
    expect(context).toContain("file-44.png");
    // A repeated upload keeps its newest position rather than aging out.
    const repeated = chatFileSystemContext({ workspaceDir, attachments: [attachments[0]!, ...attachments.slice(5), attachments[0]!], limit: 3 }) ?? "";
    expect(repeated).toContain("file-0.png");
  });

  it("only offers inline display to content the browser cannot execute", () => {
    expect(isInlineContentType("image/png")).toBe(true);
    expect(isInlineContentType("text/plain; charset=utf-8")).toBe(true);
    expect(isInlineContentType("image/svg+xml")).toBe(false);
    expect(isInlineContentType("text/html")).toBe(false);
    expect(isInlineContentType("application/octet-stream")).toBe(false);
    expect(contentDispositionHeader("photo of a cat.png", "inline")).toBe(`inline; filename="photo of a cat.png"; filename*=UTF-8''photo%20of%20a%20cat.png`);
    expect(contentDispositionHeader('quote".png', "attachment")).toContain('filename="quote_.png"');
  });

  it("tells the agent how to show uploads back to the user", () => {
    const workspaceDir = "/tmp/workspace";
    const context = chatFileSystemContext({
      workspaceDir,
      attachments: [
        { name: "photo.jpg", filePath: `${workspaceDir}/.copilotchat/uploads/chat-1/abc-photo.jpg` },
        { name: "outside.jpg", filePath: "/elsewhere/outside.jpg" },
        { name: "pending.jpg" },
      ],
    });
    expect(context).toContain("![description](path/to/image.png)");
    expect(context).toContain(".copilotchat/uploads/chat-1/abc-photo.jpg (photo.jpg)");
    expect(context).not.toContain("outside.jpg");
    expect(context).not.toContain("pending.jpg");
    expect(chatFileSystemContext({ workspaceDir, attachments: [] })).toContain("Showing files to the user:");
  });

  it("scopes stored attachment lookups to the owner, chat, and message", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Attachment chat", projectId: null, workspaceId: null });
    const otherChat = db.createChat(owner.id, { title: "Other chat", projectId: null, workspaceId: null });
    const message = db.addMessage({ chatId: chat.id, role: "user", content: "Look at this." });
    db.replaceMessageAttachments(owner.id, chat.id, message.id, [{ id: "att-1", name: "photo.png", mimeType: "image/png", size: 5, data: Buffer.from("image").toString("base64") }]);

    expect(db.getMessageAttachment(owner.id, chat.id, message.id, "att-1")).toMatchObject({ name: "photo.png", mimeType: "image/png" });
    expect(db.getMessageAttachment(owner.id, chat.id, message.id, "missing")).toBeNull();
    expect(db.getMessageAttachment(owner.id, otherChat.id, message.id, "att-1")).toBeNull();
  });
});
