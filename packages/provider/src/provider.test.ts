import type { ProviderEvent } from "./index.js";
import { CopilotClient } from "@github/copilot-sdk";
import type { CopilotSession, ModelInfo, SessionEvent } from "@github/copilot-sdk";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSdkMcpServers, createCopilotProvider, mapSdkModelInfo, pruneSdkSessionState, readSdkUsageNanoAiu, sdkSessionStatePath, summarizeSdkFailureMessage, webSearchMcpServerName, webSearchMcpServerUrl, webSearchToolName } from "./index.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("createCopilotProvider", () => {
  it("uses SDK provider by default", async () => {
    const provider = createCopilotProvider({ provider: "auto", model: "gpt-test" });
    expect((await provider.status()).id).toBe("sdk");
  }, 20_000);
  it("can use echo provider explicitly", async () => {
    const provider = createCopilotProvider({ provider: "echo", model: "gpt-test" });
    const status = await provider.status();
    expect(status.id).toBe("echo");
    expect(status.modelsAuthoritative).toBe(true);
  });
  it("extracts actionable CLI failures without returning bundled source", () => {
    const source = "minified-source ".repeat(5000);
    const message = summarizeSdkFailureMessage(new Error(`CLI server exited with code 1 stderr: ^ Error: decoy ${source} ^\n\nError: Persistence error: I/O error: Permission denied (os error 13) at Object.writeKey (file:///app/app.js:83:684) at async start (file:///app/app.js:100:1) Node.js v22.23.1`));

    expect(message).toBe("Error: Persistence error: I/O error: Permission denied (os error 13)");
    expect(message).not.toContain("minified-source");
    expect(message.length).toBeLessThan(200);
  });
  it("preserves actionable messages containing the word at", () => {
    expect(summarizeSdkFailureMessage(new Error("Open the device page at https://github.com/login/device"))).toBe("Open the device page at https://github.com/login/device");
  });
  it("only removes a standalone Node version footer", () => {
    expect(summarizeSdkFailureMessage(new Error("SyntaxError: unsupported syntax\nNode.js v22.23.1"))).toBe("SyntaxError: unsupported syntax");
    expect(summarizeSdkFailureMessage(new Error("Unsupported Node.js v20; upgrade to v22"))).toBe("Unsupported Node.js v20; upgrade to v22");
  });
  it("stops the SDK client when startup fails", async () => {
    vi.spyOn(CopilotClient.prototype, "start").mockRejectedValueOnce(new Error("startup failed"));
    const stop = vi.spyOn(CopilotClient.prototype, "stop").mockResolvedValueOnce([]);

    const status = await createCopilotProvider({ provider: "sdk", model: "gpt-test" }).status();

    expect(status.available).toBe(false);
    expect(status.modelsAuthoritative).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  });
  it("stops the SDK client when model discovery fails", async () => {
    vi.spyOn(CopilotClient.prototype, "start").mockResolvedValueOnce();
    vi.spyOn(CopilotClient.prototype, "listModels").mockRejectedValueOnce(new Error("model discovery failed"));
    const stop = vi.spyOn(CopilotClient.prototype, "stop").mockResolvedValueOnce([]);

    const status = await createCopilotProvider({ provider: "sdk", model: "gpt-test" }).status();

    expect(status.available).toBe(false);
    expect(status.modelsAuthoritative).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  });
  it("passes project context and prior messages through the development provider", async () => {
    const provider = createCopilotProvider({ provider: "echo", model: "gpt-test" });
    const events = await collect(provider.streamChat({
      messages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Second question" },
      ],
      sessionId: "copilotchat-test",
      resumeSession: true,
      model: "gpt-test",
      contextTier: "long_context",
      userContext: "The user prefers concise recommendations.",
      projectContext: "Use the project voice.",
      skills: [],
      mcpServers: [],
    }));
    const text = events.filter((event) => event.type === "delta").map((event) => event.text).join("");
    expect(events).toContainEqual({ type: "session", sessionId: "copilotchat-test", workspacePath: null, resumed: true, infinite: false });
    expect(text).toContain("Messages in context: 3.");
    expect(text).toContain("Provider session: copilotchat-test (resume).");
    expect(text).toContain("Previous context: user: First question | assistant: First answer");
    expect(text).toContain("Personal context: The user prefers concise recommendations.");
    expect(text).toContain("Project context: Use the project voice.");
    expect(text).toContain("Context size: long_context.");
  });
  it("injects personal context into HTTP provider system messages", async () => {
    type HttpChatBody = { messages?: Array<{ role?: string; content?: string }> };
    let captureBody!: (body: HttpChatBody) => void;
    const capturedBodyPromise = new Promise<HttpChatBody>((resolve) => { captureBody = resolve; });
    const server = http.createServer((request, response) => {
      if (request.url !== "/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      let rawBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { rawBody += chunk; });
      request.on("end", () => {
        captureBody(JSON.parse(rawBody) as HttpChatBody);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
      const provider = createCopilotProvider({ provider: "http", apiBaseUrl: `http://127.0.0.1:${address.port}`, apiToken: "token", model: "gpt-test" });

      await collect(provider.streamChat({ messages: [{ role: "user", content: "hello" }], model: "gpt-test", userContext: "The user prefers concise recommendations." }));

      const capturedBody = await capturedBodyPromise;
      const systemMessage = capturedBody.messages?.find((message) => message.role === "system");
      expect(systemMessage?.content).toContain("Personal context shared by the user:");
      expect(systemMessage?.content).toContain("The user prefers concise recommendations.");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("maps configurable model effort and long-context tiers from SDK metadata", () => {
    const model: ModelInfo = {
      id: "gpt-test",
      name: "GPT Test",
      capabilities: {
        supports: { vision: false, reasoningEffort: true },
        limits: { max_context_window_tokens: 128_000, max_prompt_tokens: 120_000 },
      },
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      billing: {
        tokenPrices: {
          maxPromptTokens: 114_000,
          longContext: { maxPromptTokens: 950_000 },
        },
      },
    };

    expect(mapSdkModelInfo(model)).toEqual({
      id: "gpt-test",
      name: "GPT Test",
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      supportsLongContext: true,
      contextWindowTokens: 128_000,
      maxPromptTokens: 114_000,
      longContextMaxPromptTokens: 950_000,
    });
  });
  it("emits reasoning and tool events from the development provider", async () => {
    const provider = createCopilotProvider({ provider: "echo", model: "gpt-test" });
    const events = await collect(provider.streamChat({
      messages: [{ role: "user", content: "Show thinking and tool use" }],
      model: "gpt-test",
      skills: [],
      mcpServers: [],
    }));

    expect(events).toContainEqual({ type: "reasoning-delta", text: "Checking the active chat context and selected tools." });
    expect(events).toContainEqual({ type: "tool-call", id: "echo-context-check", toolName: "context.inspect", input: { messages: 1, skills: [] } });
    expect(events).toContainEqual({ type: "tool-result", id: "echo-context-check", toolName: "context.inspect", status: "succeeded", output: { provider: "echo", workspace: null } });
  });
  it("emits task-list events from checklist output", async () => {
    const provider = createCopilotProvider({ provider: "echo", model: "gpt-test" });
    const events = await collect(provider.streamChat({
      messages: [{ role: "user", content: "Please create a task list with progress." }],
      model: "gpt-test",
      skills: [],
      mcpServers: [],
    }));
    const taskList = events.find((event) => event.type === "task-list");

    expect(taskList).toMatchObject({
      type: "task-list",
      id: "echo-task-list",
      title: "Task list",
      items: [
        { title: "Understand the request", completed: true, depth: 0 },
        { title: "Render task list progress", completed: true, depth: 0 },
        { title: "Polish the final details", completed: false, depth: 0 },
      ],
    });
  });
  it("can set a concise conversation title through the title tool", async () => {
    const provider = createCopilotProvider({ provider: "echo", model: "gpt-test" });
    const savedTitles: string[] = [];
    const events = await collect(provider.streamChat({
      messages: [{ role: "user", content: "Durable chat naming patterns across products need short summaries." }],
      model: "gpt-test",
      skills: [],
      mcpServers: [],
      titleTool: { currentTitle: "New chat", required: true, setTitle: async (title) => { savedTitles.push(title); return title; } },
    }));

    expect(savedTitles).toEqual(["Durable chat naming patterns across products"]);
    expect(savedTitles[0]?.split(/\s+/)).toHaveLength(6);
    expect(events).toContainEqual({ type: "tool-call", id: "echo-title-tool", toolName: "set_conversation_title", input: { title: "Durable chat naming patterns across products" } });
    expect(events).toContainEqual({ type: "tool-result", id: "echo-title-tool", toolName: "set_conversation_title", status: "succeeded", output: { title: "Durable chat naming patterns across products" } });
  });
  it("routes development provider user input and permission requests through interaction handlers", async () => {
    const provider = createCopilotProvider({ provider: "echo", model: "gpt-test" });
    const events = await collect(provider.streamChat({
      messages: [{ role: "user", content: "Please ask me a question and request permission." }],
      model: "gpt-test",
      permissionMode: "ask",
      skills: [],
      mcpServers: [],
      interactions: {
        requestUserInput: async () => ({ answer: "alpha", wasFreeform: false }),
        requestPermission: async () => "approve",
      },
    }));
    const text = events.filter((event) => event.type === "delta").map((event) => event.text).join("");

    expect(events).toContainEqual({ type: "tool-call", id: "echo-ask-user", toolName: "ask_user", input: { question: "Which option should I use?", choices: ["alpha", "beta"], allowFreeform: true } });
    expect(events).toContainEqual({ type: "tool-result", id: "echo-ask-user", toolName: "ask_user", status: "succeeded", output: { answer: "alpha", wasFreeform: false } });
    expect(text).toContain("User answered: alpha.");
    expect(text).toContain("Permission decision: approved.");
  });
  it("passes URL permission request details through interaction handlers", async () => {
    const provider = createCopilotProvider({ provider: "echo", model: "gpt-test" });
    let captured: unknown;
    const events = await collect(provider.streamChat({
      messages: [{ role: "user", content: "Please request a URL permission." }],
      model: "gpt-test",
      permissionMode: "ask",
      skills: [],
      mcpServers: [],
      interactions: {
        requestPermission: async (request) => {
          captured = request;
          return "approve";
        },
      },
    }));
    const text = events.filter((event) => event.type === "delta").map((event) => event.text).join("");

    expect(text).toContain("Permission decision: approved.");
    expect(captured).toMatchObject({ kind: "url", toolName: "web.fetch", url: "https://example.com/docs" });
  });
  it("auto-approves development provider permissions in yolo mode", async () => {
    const provider = createCopilotProvider({ provider: "echo", model: "gpt-test" });
    const events = await collect(provider.streamChat({
      messages: [{ role: "user", content: "Please request permission." }],
      model: "gpt-test",
      permissionMode: "yolo",
      skills: [],
      mcpServers: [],
      interactions: {
        requestPermission: async () => {
          throw new Error("Auto-approval should skip per-tool permission prompts.");
        },
      },
    }));
    const text = events.filter((event) => event.type === "delta").map((event) => event.text).join("");

    expect(text).toContain("Permission decision: approved (yolo).");
  });
  it("emits subagent lifecycle and work events from the development provider", async () => {
    const provider = createCopilotProvider({ provider: "echo", model: "gpt-test" });
    const events = await collect(provider.streamChat({
      messages: [{ role: "user", content: "Delegate this to a subagent." }],
      model: "gpt-test",
      skills: [],
      mcpServers: [],
    }));

    expect(events).toContainEqual({ type: "subagent-start", id: "echo-subagent", name: "research-helper", displayName: "Research helper", description: "Inspect project context and summarize useful findings.", model: "gpt-test", toolCallId: "echo-subagent-tool" });
    expect(events).toContainEqual({ type: "subagent-reasoning-delta", id: "echo-subagent", text: "Checking project context before reporting back." });
    expect(events).toContainEqual({ type: "subagent-tool-call", id: "echo-subagent", toolCallId: "echo-subagent-search", toolName: "context.search", input: { query: "project context" } });
    expect(events).toContainEqual({ type: "subagent-tool-result", id: "echo-subagent", toolCallId: "echo-subagent-search", toolName: "context.search", status: "succeeded", output: { matches: 2 } });
    expect(events).toContainEqual({ type: "subagent-delta", id: "echo-subagent", text: "Found shared project context and recent chat references." });
    expect(events).toContainEqual({ type: "subagent-complete", id: "echo-subagent", name: "research-helper", displayName: "Research helper", durationMs: 42, model: "gpt-test", totalTokens: 128, totalToolCalls: 1 });
  });
  it("reads per-request AI credit cost from SDK assistant usage events", () => {
    expect(readSdkUsageNanoAiu({ model: "gpt-test", copilotUsage: { totalNanoAiu: 42_000_000 } })).toBe(42_000_000);
    expect(readSdkUsageNanoAiu({ model: "gpt-test", copilotUsage: { totalNanoAiu: 0 } })).toBeNull();
    expect(readSdkUsageNanoAiu({ model: "gpt-test", inputTokens: 10 })).toBeNull();
    expect(readSdkUsageNanoAiu(null)).toBeNull();
  });
  it("reports AI credit usage from the development provider", async () => {
    const provider = createCopilotProvider({ provider: "echo", model: "gpt-test" });
    const events = await collect(provider.streamChat({ messages: [{ role: "user", content: "hello" }], model: "gpt-test" }));
    const usage = events.filter((event) => event.type === "usage");

    expect(usage.length).toBeGreaterThan(1);
    expect(usage.every((event) => event.nanoAiu > 0)).toBe(true);
  });
  it("never reports AI credit usage when the development provider is only an SDK fallback", async () => {
    const provider = createCopilotProvider({ provider: "sdk", model: "gpt-test", sdkCliPath: "/nonexistent/copilot-binary" });
    const events = await collect(provider.streamChat({ messages: [{ role: "user", content: "hello" }], model: "gpt-test" }));

    expect(events.filter((event) => event.type === "delta").map((event) => event.text).join("")).toContain("Copilot SDK was unavailable");
    expect(events.filter((event) => event.type === "usage")).toEqual([]);
  }, 20_000);
  it("gives each SDK session its own workspace session-state directory", () => {
    const first = sdkSessionStatePath("copilotchat-github-id-1-chat-a-b37dabfc-4444-4ee5-8d38-824cce18c13e");
    const second = sdkSessionStatePath("copilotchat-github-id-1-chat-a-2b1cf0f4-1111-4222-8333-444455556666");

    expect(first).toBe(".copilotchat-session/copilotchat-github-id-1-chat-a-b37dabfc-4444-4ee5-8d38-824cce18c13e");
    expect(second).not.toBe(first);
    expect(sdkSessionStatePath(null)).toBe(".copilotchat-session");
    expect(sdkSessionStatePath("../../escape")).toBe(".copilotchat-session/-.-escape");
    expect(sdkSessionStatePath("../../escape").split("/")).toHaveLength(2);
  });
  it("prunes abandoned session-state directories while keeping the active one", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "copilotchat-prune-"));
    const root = path.join(workspace, ".copilotchat-session");
    const names = Array.from({ length: 10 }, (_, index) => `session-${index}`);
    for (const [index, name] of names.entries()) {
      await fs.mkdir(path.join(root, name), { recursive: true });
      await fs.utimes(path.join(root, name), new Date(1_000_000 + index * 1000), new Date(1_000_000 + index * 1000));
    }
    await fs.writeFile(path.join(root, "events.jsonl"), "legacy");

    const removed = await pruneSdkSessionState(workspace, "session-0", 4);
    const remaining = (await fs.readdir(root)).sort();

    expect(removed.sort()).toEqual(["session-1", "session-2", "session-3", "session-4", "session-5"]);
    expect(remaining).toContain("session-0");
    expect(remaining).toContain("session-9");
    expect(remaining).toContain("events.jsonl");
    expect(remaining.filter((entry) => entry.startsWith("session-"))).toHaveLength(5);
    await fs.rm(workspace, { recursive: true, force: true });
  });
  it("leaves session state alone when the workspace has no session directories", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "copilotchat-prune-"));

    expect(await pruneSdkSessionState(workspace, "session-0")).toEqual([]);
    await fs.rm(workspace, { recursive: true, force: true });
  });
  it("recovers with a new SDK session when the resumed session no longer exists", async () => {
    vi.spyOn(CopilotClient.prototype, "stop").mockResolvedValue([]);
    const resume = vi.spyOn(CopilotClient.prototype, "resumeSession").mockImplementation((sessionId: string) => Promise.resolve(fakeSdkSession(sessionId, () => Promise.reject(new Error(`Request session.send failed with message: Session not found for sessionId: ${sessionId}`)))));
    const create = vi.spyOn(CopilotClient.prototype, "createSession").mockImplementation((config) => Promise.resolve(fakeSdkSession(String(config.sessionId), (emit) => {
      emit({ type: "assistant.message", data: { content: "fresh answer" } });
      emit({ type: "session.idle", data: {} });
      return Promise.resolve();
    })));
    const provider = createCopilotProvider({ provider: "sdk", model: "gpt-test" });

    const events = await collect(provider.streamChat({ messages: [{ role: "user", content: "hello" }], sessionId: "copilotchat-stale", resumeSession: true, model: "gpt-test" }));
    const text = events.filter((event) => event.type === "delta").map((event) => event.text).join("");

    expect(resume).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(text).toBe("fresh answer");
    expect(events.filter((event) => event.type === "session").at(-1)).toMatchObject({ sessionId: "copilotchat-stale", resumed: false });
  });
  it("resumes the existing session when a created session id is already taken", async () => {
    vi.spyOn(CopilotClient.prototype, "stop").mockResolvedValue([]);
    const resume = vi.spyOn(CopilotClient.prototype, "resumeSession").mockImplementation((sessionId: string) => Promise.resolve(fakeSdkSession(sessionId, (emit) => {
      emit({ type: "assistant.message", data: { content: "resumed answer" } });
      emit({ type: "session.idle", data: {} });
      return Promise.resolve();
    })));
    const create = vi.spyOn(CopilotClient.prototype, "createSession").mockRejectedValue(new Error("Session already exists"));
    const provider = createCopilotProvider({ provider: "sdk", model: "gpt-test" });

    const events = await collect(provider.streamChat({ messages: [{ role: "user", content: "hello" }], sessionId: "copilotchat-taken", resumeSession: false, model: "gpt-test" }));
    const session = events.filter((event) => event.type === "session").at(-1);

    expect(create).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(session).toMatchObject({ sessionId: "copilotchat-taken", resumed: true });
    expect(events.filter((event) => event.type === "delta").map((event) => event.text).join("")).toBe("resumed answer");
  });
  it("does not restart a turn whose streamed events were still queued when it failed", async () => {
    vi.spyOn(CopilotClient.prototype, "stop").mockResolvedValue([]);
    vi.spyOn(CopilotClient.prototype, "resumeSession").mockImplementation((sessionId: string) => Promise.resolve(fakeSdkSession(sessionId, (emit) => {
      emit({ type: "assistant.message", data: { content: "partial answer" } });
      emit({ type: "session.error", data: { message: "Session not found for sessionId: copilotchat-stale" } });
      return Promise.resolve();
    })));
    const create = vi.spyOn(CopilotClient.prototype, "createSession").mockResolvedValue(fakeSdkSession("unused", () => Promise.resolve()));
    const provider = createCopilotProvider({ provider: "sdk", model: "gpt-test" });

    const events = await collect(provider.streamChat({ messages: [{ role: "user", content: "hello" }], sessionId: "copilotchat-stale", resumeSession: true, model: "gpt-test" }));
    const text = events.filter((event) => event.type === "delta").map((event) => event.text).join("");

    expect(create).not.toHaveBeenCalled();
    expect(text).toContain("partial answer");
    expect(text).toContain("Falling back to local development provider.");
  });
  it("does not restart a turn that already streamed content", async () => {
    vi.spyOn(CopilotClient.prototype, "stop").mockResolvedValue([]);
    vi.spyOn(CopilotClient.prototype, "resumeSession").mockImplementation((sessionId: string) => Promise.resolve(fakeSdkSession(sessionId, (emit) => {
      emit({ type: "assistant.message", data: { content: "partial answer" } });
      return Promise.reject(new Error("Request session.send failed with message: Session not found for sessionId: copilotchat-stale"));
    })));
    const create = vi.spyOn(CopilotClient.prototype, "createSession").mockResolvedValue(fakeSdkSession("unused", () => Promise.resolve()));
    const provider = createCopilotProvider({ provider: "sdk", model: "gpt-test" });

    const events = await collect(provider.streamChat({ messages: [{ role: "user", content: "hello" }], sessionId: "copilotchat-stale", resumeSession: true, model: "gpt-test" }));
    const text = events.filter((event) => event.type === "delta").map((event) => event.text).join("");

    expect(create).not.toHaveBeenCalled();
    expect(text).toContain("partial answer");
    expect(text).toContain("Falling back to local development provider.");
  });
  it("recovers when the SDK reports a lost session as 'No session found'", async () => {
    vi.spyOn(CopilotClient.prototype, "stop").mockResolvedValue([]);
    vi.spyOn(CopilotClient.prototype, "resumeSession").mockImplementation((sessionId: string) => Promise.resolve(fakeSdkSession(sessionId, () => Promise.reject(new Error("Request session.send failed with message: No session found for copilotchat-stale")))));
    const create = vi.spyOn(CopilotClient.prototype, "createSession").mockImplementation((config) => Promise.resolve(fakeSdkSession(String(config.sessionId), (emit) => {
      emit({ type: "assistant.message", data: { content: "fresh answer" } });
      emit({ type: "session.idle", data: {} });
      return Promise.resolve();
    })));
    const provider = createCopilotProvider({ provider: "sdk", model: "gpt-test" });

    const events = await collect(provider.streamChat({ messages: [{ role: "user", content: "hello" }], sessionId: "copilotchat-stale", resumeSession: true, model: "gpt-test" }));

    expect(create).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "delta").map((event) => event.text).join("")).toBe("fresh answer");
  });
  it("keeps falling back to the development provider for non-session SDK failures", async () => {
    vi.spyOn(CopilotClient.prototype, "stop").mockResolvedValue([]);
    vi.spyOn(CopilotClient.prototype, "resumeSession").mockImplementation((sessionId: string) => Promise.resolve(fakeSdkSession(sessionId, () => Promise.reject(new Error("Request session.send failed with message: model not found")))));
    const create = vi.spyOn(CopilotClient.prototype, "createSession").mockResolvedValue(fakeSdkSession("unused", () => Promise.resolve()));
    const provider = createCopilotProvider({ provider: "sdk", model: "gpt-test" });

    const events = await collect(provider.streamChat({ messages: [{ role: "user", content: "hello" }], sessionId: "copilotchat-stale", resumeSession: true, model: "gpt-test" }));
    const text = events.filter((event) => event.type === "delta").map((event) => event.text).join("");

    expect(create).not.toHaveBeenCalled();
    expect(text).toContain("Falling back to local development provider.");
  });
  it("skips malformed HTTP provider stream chunks without aborting", async () => {
    const server = http.createServer((request, response) => {
      if (request.url === "/chat/completions") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end("data: {not-json}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-test" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
      const provider = createCopilotProvider({ provider: "http", apiBaseUrl: `http://127.0.0.1:${address.port}`, apiToken: "token", model: "gpt-test" });

      const status = await provider.status();
      const events = await collect(provider.streamChat({ messages: [{ role: "user", content: "hello" }], model: "gpt-test" }));

      expect(status.modelsAuthoritative).toBe(true);
      expect(status.models.map((model) => model.id)).toEqual(["gpt-test"]);
      expect(events).toContainEqual({ type: "delta", text: "ok" });
      expect(events.at(-1)).toEqual({ type: "done" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("marks HTTP fallback models as non-authoritative when discovery fails", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unavailable" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
      const provider = createCopilotProvider({ provider: "http", apiBaseUrl: `http://127.0.0.1:${address.port}`, apiToken: "token", model: "gpt-test" });

      const status = await provider.status();

      expect(status.available).toBe(true);
      expect(status.modelsAuthoritative).toBe(false);
      expect(status.models.some((model) => model.id === "gpt-test")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("buildSdkMcpServers", () => {
  const baseRequest = { messages: [{ role: "user" as const, content: "hi" }], model: "gpt-test" };
  it("registers the GitHub web search MCP server when a GitHub token is available", () => {
    const servers = buildSdkMcpServers({ ...baseRequest, gitHubToken: "gho_token", mcpServers: [] });

    expect(servers[webSearchMcpServerName]).toEqual({ type: "http", url: webSearchMcpServerUrl, tools: [webSearchToolName], headers: { Authorization: "Bearer gho_token" } });
  });
  it("falls back to the provider-level GitHub token", () => {
    const servers = buildSdkMcpServers({ ...baseRequest, mcpServers: [] }, "gho_factory");

    expect(servers[webSearchMcpServerName]).toEqual({ type: "http", url: webSearchMcpServerUrl, tools: [webSearchToolName], headers: { Authorization: "Bearer gho_factory" } });
  });
  it("omits web search when no GitHub token is available", () => {
    expect(buildSdkMcpServers({ ...baseRequest, mcpServers: [] })).toEqual({});
  });
  it("keeps user-configured MCP servers and does not overwrite a matching name", () => {
    const servers = buildSdkMcpServers({
      ...baseRequest,
      gitHubToken: "gho_token",
      mcpServers: [
        { id: "a", ownerId: "o", name: "Docs", transport: "http", command: null, args: [], url: "https://example.test/mcp", tools: ["lookup"], enabled: true, projectId: null, createdAt: "", updatedAt: "" },
        { id: "b", ownerId: "o", name: webSearchMcpServerName, transport: "http", command: null, args: [], url: "https://custom.test/mcp", tools: ["web_search"], enabled: true, projectId: null, createdAt: "", updatedAt: "" },
      ],
    });

    expect(servers.Docs).toEqual({ type: "http", url: "https://example.test/mcp", tools: ["lookup"] });
    expect(servers[webSearchMcpServerName]).toEqual({ type: "http", url: "https://custom.test/mcp", tools: ["web_search"] });
  });
});

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> { const result: ProviderEvent[] = []; for await (const event of events) result.push(event); return result; }

function fakeSdkSession(sessionId: string, send: (emit: (event: { type: string; data?: unknown }) => void) => Promise<void>): CopilotSession {
  let handler: ((event: SessionEvent) => void) | null = null;
  return {
    sessionId,
    workspacePath: "/tmp/fake-session",
    on: (listener: (event: SessionEvent) => void) => { handler = listener; return () => { handler = null; }; },
    send: () => send((event) => handler?.(event as SessionEvent)),
    disconnect: () => Promise.resolve(),
  } as unknown as CopilotSession;
}
