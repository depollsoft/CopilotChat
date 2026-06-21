import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CopilotProvider } from "@copilotchat/provider";
import type { ImportPreview, MessageAttachment } from "@copilotchat/shared";
import { afterEach, describe, expect, it } from "vitest";
import { syncArtifactFiles, writeFileArtifact } from "./artifact-files.js";
import { applyChatTurnScope, buildProviderChatRequest } from "./chat-context.js";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { applyImportPreview } from "./import-apply.js";
import { ImportDraftStore } from "./import-drafts.js";
import { buildImportTools } from "./import-tools.js";
import { ActiveChatResponses } from "./responses.js";
import { ownerWorkspaceRoot, runWorkspaceCommand, validateRegisteredWorkspaceRoot } from "./workspace.js";

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

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Second question", model: "gpt-test", reasoningEffort: "high", skillIds: [] }, defaultModel: "fallback", gitHubToken: "gh-token", context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.projectContext).toContain("Use launch project rules.");
    expect(request.model).toBe("gpt-test");
    expect(request.reasoningEffort).toBe("high");
    expect(request.gitHubToken).toBe("gh-token");
    expect(request.sessionId).toBe(`copilotchat-${owner.id}-${chat.id}`);
    expect(request.resumeSession).toBe(false);
    expect(request.workingDirectory).toBe(`/tmp/isolated/${chat.id}`);
    expect(request.messages.map((message) => `${message.role}:${message.content}`)).toEqual(["user:First question", "assistant:First answer", "user:Second question"]);
  });

  it("uses saved chat model choices when a request does not override them", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const chat = db.createChat(owner.id, { title: "Model chat", projectId: null, workspaceId: null, model: "gpt-5-mini", reasoningEffort: "high" });
    db.addMessage({ chatId: chat.id, role: "user", content: "Use saved model" });

    const request = buildProviderChatRequest({ db, ownerId: owner.id, chat, message: { content: "Use saved model", skillIds: [] }, defaultModel: "fallback", gitHubToken: null, context: { isolatedWorkspaceRoot: "/tmp/isolated" } });

    expect(request.model).toBe("gpt-5-mini");
    expect(request.reasoningEffort).toBe("high");
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

    expect(request.messages.at(-1)?.attachments).toEqual([{ type: "blob", data: attachment.data, mimeType: "image/png", displayName: "project-list.png" }]);
    expect(db.listMessages(chat.id)[0]?.metadata.attachments).toEqual([{ id: "att-1", name: "project-list.png", mimeType: "image/png", size: 5 }]);
    expect(db.listMessages(chat.id, { includeAttachmentData: true })[0]?.metadata.attachments).toEqual([attachment]);
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
    const alice = db.getOrCreateGitHubOwner({ login: "alice", displayName: "Alice", avatarUrl: null });
    const bob = db.getOrCreateGitHubOwner({ login: "bob", displayName: "Bob", avatarUrl: null });

    db.createChat(alice.id, { title: "Alice chat", projectId: null, workspaceId: null });
    db.createChat(bob.id, { title: "Bob chat", projectId: null, workspaceId: null });

    expect(db.listChats(alice.id).map((chat) => chat.title)).toEqual(["Alice chat"]);
    expect(db.listChats(bob.id).map((chat) => chat.title)).toEqual(["Bob chat"]);
    expect(db.listSkills(alice.id).length).toBeGreaterThan(0);
    expect(db.listSkills(bob.id).length).toBeGreaterThan(0);
  });

  it("keeps large artifact content out of app state", () => {
    const db = createTestDb();
    const owner = db.getOwner();
    const content = "large artifact\n".repeat(1000);
    const artifact = db.createArtifact(owner.id, { title: "Large notes", kind: "markdown", content });

    const state = db.getState({ id: "echo", label: "Echo", available: true, details: "", capabilities: [], models: [], defaultModel: "gpt-test" });

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
    const chat = db.createChat(owner.id, { title: "Model chat", projectId: null, workspaceId: null, model: "gpt-4.1", reasoningEffort: "medium" });
    db.setChatProviderSession(owner.id, chat.id, { providerSessionId: "old-session", providerSessionWorkspacePath: "/tmp/old" });

    const updated = db.updateChat(owner.id, chat.id, { model: "gpt-5-mini", reasoningEffort: "high" });

    expect(updated.model).toBe("gpt-5-mini");
    expect(updated.reasoningEffort).toBe("high");
    expect(updated.providerSessionId).toBeNull();
    expect(updated.providerSessionWorkspacePath).toBeNull();
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
      const aliceRoot = ownerWorkspaceRoot(workspaceRoot, "github:alice");
      const aliceRepo = path.join(aliceRoot, "repo");
      fs.mkdirSync(aliceRepo, { recursive: true });

      await expect(validateRegisteredWorkspaceRoot({ authMode: "github", ownerId: "github:alice", rootPath: aliceRepo, workspaceRoot })).resolves.toBe(fs.realpathSync(aliceRepo));
      await expect(validateRegisteredWorkspaceRoot({ authMode: "github", ownerId: "github:alice", rootPath: outside, workspaceRoot })).rejects.toThrow(/configured workspace root/);
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
    const alice = db.getOrCreateGitHubOwner({ login: "alice", displayName: "Alice", avatarUrl: null });
    const bob = db.getOrCreateGitHubOwner({ login: "bob", displayName: "Bob", avatarUrl: null });
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
