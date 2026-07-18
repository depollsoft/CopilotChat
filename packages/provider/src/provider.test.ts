import type { ProviderEvent } from "./index.js";
import type { ModelInfo } from "@github/copilot-sdk";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { createCopilotProvider, mapSdkModelInfo } from "./index.js";

describe("createCopilotProvider", () => {
  it("uses SDK provider by default", async () => {
    const provider = createCopilotProvider({ provider: "auto", model: "gpt-test" });
    expect((await provider.status()).id).toBe("sdk");
  }, 20_000);
  it("can use echo provider explicitly", async () => {
    const provider = createCopilotProvider({ provider: "echo", model: "gpt-test" });
    expect((await provider.status()).id).toBe("echo");
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
      projectContext: "Use the project voice.",
      skills: [],
      mcpServers: [],
    }));
    const text = events.filter((event) => event.type === "delta").map((event) => event.text).join("");
    expect(events).toContainEqual({ type: "session", sessionId: "copilotchat-test", workspacePath: null, resumed: true, infinite: false });
    expect(text).toContain("Messages in context: 3.");
    expect(text).toContain("Provider session: copilotchat-test (resume).");
    expect(text).toContain("Previous context: user: First question | assistant: First answer");
    expect(text).toContain("Project context: Use the project voice.");
    expect(text).toContain("Context size: long_context.");
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

      const events = await collect(provider.streamChat({ messages: [{ role: "user", content: "hello" }], model: "gpt-test" }));

      expect(events).toContainEqual({ type: "delta", text: "ok" });
      expect(events.at(-1)).toEqual({ type: "done" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> { const result: ProviderEvent[] = []; for await (const event of events) result.push(event); return result; }
