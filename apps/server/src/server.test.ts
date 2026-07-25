import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { CopilotProvider } from "@copilotchat/provider";
import type { ImportPreview, MessageAttachment } from "@copilotchat/shared";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { materializeMessageAttachments, relocateChatAttachments } from "./attachment-files.js";
import { syncArtifactFiles, writeFileArtifact } from "./artifact-files.js";
import { applyChatTurnScope, buildProviderChatRequest } from "./chat-context.js";
import { isGitHubLoginAllowed, loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { applyImportPreview } from "./import-apply.js";
import { ImportDraftStore } from "./import-drafts.js";
import { buildImportTools } from "./import-tools.js";
import { buildConversationTools } from "./conversation-tools.js";
import { isAllowedCorsOrigin } from "./cors-origin.js";
import { ActiveChatResponse, ActiveChatResponses } from "./responses.js";
import { UploadedFileStore } from "./uploaded-files.js";
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

    const state = db.getState({ id: "echo", label: "Echo", available: true, details: "", capabilities: [], models: [], defaultModel: "gpt-test" }, [], owner.id, "github");

    expect(state.authMode).toBe("github");
    expect(state.artifacts[0]).toMatchObject({ id: artifact.id, title: "Large notes", contentLength: content.length });
    expect(state.artifacts[0]?.contentPreview.length).toBeLessThan(content.length);
    expect(JSON.stringify(state)).not.toContain(content);
    expect(db.getArtifact(owner.id, artifact.id).content).toBe(content);
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
    const provider: CopilotProvider = { id: "test", label: "Test", status: async () => ({ id: "test", label: "Test", available: true, details: "", capabilities: [], models: [] }), async *streamChat() { yield { type: "done" }; } };
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

  it("enforces staged upload quotas and cleans orphaned files", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilotchat-uploads-"));
    try {
      const uploads = new UploadedFileStore(uploadDir, 1024, 6, 2);
      await uploads.create("github:alice", { fileName: "first.bin", mimeType: "application/octet-stream", size: 4 }, Readable.from(["1234"]));
      await expect(uploads.create("github:alice", { fileName: "second.bin", mimeType: "application/octet-stream", size: 3 }, Readable.from(["123"]))).rejects.toThrow("per-owner limit");
      const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const orphanPath = path.join(uploadDir, "orphan.upload");
      const partialPath = path.join(uploadDir, "partial.upload.part");
      fs.writeFileSync(orphanPath, "orphan");
      fs.writeFileSync(partialPath, "partial");
      fs.utimesSync(orphanPath, staleTime, staleTime);
      fs.utimesSync(partialPath, staleTime, staleTime);

      await uploads.cleanupExpired();

      expect(fs.existsSync(orphanPath)).toBe(false);
      expect(fs.existsSync(partialPath)).toBe(false);
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
      await expect(draftStore.create("github:alice", { source: "auto", fileName: "large.json", encoding: "text", content: "12345" })).rejects.toThrow("limit");
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

  it("hides title-tool activity when the SDK reports it as a generic tool", async () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Title chat", projectId: null, workspaceId: null });
    const userMessage = db.addMessage({ chatId: chat.id, role: "user", content: "Name this chat" });
    const provider: CopilotProvider = {
      id: "sdk",
      label: "SDK",
      status: async () => ({ id: "sdk", label: "SDK", available: true, details: "test", capabilities: [], models: [], defaultModel: "gpt-test" }),
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
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], defaultModel: "gpt-test" }),
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
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], defaultModel: "gpt-test" }),
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
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], defaultModel: "gpt-test" }),
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
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], defaultModel: "gpt-test" }),
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
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], defaultModel: "gpt-test" }),
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
      status: async () => ({ id: "echo", label: "Echo", available: true, details: "test", capabilities: [], models: [], defaultModel: "gpt-test" }),
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
