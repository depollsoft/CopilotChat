import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatRole, McpServer, PermissionMode, ProviderStatus, SkillManifest } from "@copilotchat/shared";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import type { CopilotClientOptions, CopilotSession, MCPServerConfig, MessageOptions, ModelInfo, PermissionHandler, SessionConfig, SessionEvent, SessionFsFileInfo, SessionFsProvider, Tool } from "@github/copilot-sdk";

export interface ProviderAttachment { type: "blob"; data: string; mimeType: string; displayName?: string }
export interface ProviderMessage { role: ChatRole; content: string; attachments?: ProviderAttachment[] }
export interface ProviderTool { name: string; description: string; parameters: Record<string, unknown>; skipPermission?: boolean; handler: (args: unknown) => unknown }
export type ProviderPermissionRequest = { kind: string; toolCallId?: string | null; toolName?: string | null; fileName?: string | null; fullCommandText?: string | null; url?: string | null; details?: Record<string, unknown>; raw: unknown };
export type ProviderUserInputRequest = { question: string; choices?: string[]; allowFreeform: boolean };
export type ProviderElicitationRequest = { message: string; mode?: string | null; elicitationSource?: string | null; requestedSchema?: unknown };
export type ProviderElicitationValue = string | number | boolean;
export type ProviderTaskListItem = { title: string; completed: boolean; depth?: number };
export type ProviderTitleTool = { currentTitle: string; required?: boolean; setTitle: (title: string) => Promise<string> | string };
export type ProviderInteractionHandlers = {
  requestPermission?: (request: ProviderPermissionRequest) => Promise<"approve" | "deny">;
  requestUserInput?: (request: ProviderUserInputRequest) => Promise<{ answer: string; wasFreeform: boolean }>;
  requestElicitation?: (request: ProviderElicitationRequest) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, ProviderElicitationValue> }>;
};
export type ProviderChatControls = { onSteer: (handler: (message: ProviderMessage) => void | Promise<void>) => () => void };
export interface ProviderChatRequest { messages: ProviderMessage[]; sessionId?: string | null; resumeSession?: boolean; model: string; reasoningEffort?: "default" | "none" | "low" | "medium" | "high" | "xhigh" | "max"; permissionMode?: PermissionMode; projectContext?: string | null; artifactContext?: string | null; skills?: SkillManifest[]; mcpServers?: McpServer[]; tools?: ProviderTool[]; titleTool?: ProviderTitleTool; interactions?: ProviderInteractionHandlers; controls?: ProviderChatControls; gitHubToken?: string | null; workingDirectory?: string | null; abortSignal?: AbortSignal }
export type ProviderEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "subagent-start"; id: string; name: string; displayName: string; description?: string; model?: string; toolCallId?: string | null }
  | { type: "subagent-delta"; id: string; text: string }
  | { type: "subagent-reasoning-delta"; id: string; text: string }
  | { type: "subagent-tool-call"; id: string; toolCallId?: string | null; toolName: string; input?: unknown }
  | { type: "subagent-tool-result"; id: string; toolCallId?: string | null; toolName: string; output?: unknown; error?: string | null; status: "succeeded" | "failed" }
  | { type: "subagent-complete"; id: string; name: string; displayName: string; durationMs?: number; model?: string; totalTokens?: number; totalToolCalls?: number }
  | { type: "subagent-failed"; id: string; name: string; displayName: string; error: string; durationMs?: number; model?: string; totalTokens?: number; totalToolCalls?: number }
  | { type: "task-list"; id?: string | null; title: string; items: ProviderTaskListItem[]; source?: string | null; content?: string | null }
  | { type: "session"; sessionId: string; workspacePath: string | null; resumed: boolean; infinite: boolean }
  | { type: "tool-call"; id?: string | null; toolName: string; input?: unknown }
  | { type: "tool-result"; id?: string | null; toolName: string; output?: unknown; error?: string | null; status: "succeeded" | "failed" }
  | { type: "artifact"; title: string; kind: string; content: string; language?: string | null }
  | { type: "done"; usage?: Record<string, unknown> };
export interface CopilotProvider { id: string; label: string; status(): Promise<ProviderStatus>; streamChat(request: ProviderChatRequest): AsyncIterable<ProviderEvent> }
export interface ProviderFactoryOptions { provider: "auto" | "sdk" | "http" | "cli" | "echo"; apiBaseUrl?: string; apiToken?: string; model: string; cliCommand?: string; sdkCliPath?: string; gitHubToken?: string }
const providerTextLimit = 1_000_000;
const providerValueStringLimit = 20_000;
const providerArrayLimit = 80;
const providerObjectKeyLimit = 80;
const providerDepthLimit = 5;
const providerTruncationNotice = "\n\n[Response truncated because it exceeded the local display limit. Ask for a narrower summary or a saved artifact for more detail.]";
type ProviderTextState = { length: number; tail: string };

export function createCopilotProvider(options: ProviderFactoryOptions): CopilotProvider {
  if (options.provider === "http" || (options.provider === "auto" && options.apiBaseUrl)) return new HttpCopilotProvider(options);
  if (options.provider === "cli" || (options.provider === "auto" && options.cliCommand)) return new CliCopilotProvider(options);
  if (options.provider === "sdk" || options.provider === "auto") return new SdkCopilotProvider(options);
  return new EchoProvider(options.model);
}

class SdkCopilotProvider implements CopilotProvider {
  id = "sdk"; label = "GitHub Copilot SDK";
  constructor(private readonly options: ProviderFactoryOptions) {}
  async status(): Promise<ProviderStatus> {
    const capabilities = ["streaming", "markdown", "copilot-tools", "web-search", "mcp", "skills", "workspace-sessions", "infinite-sessions", "permission-guardrails"];
    try {
      const client = new CopilotClient(copilotClientOptions(this.options.gitHubToken, this.options.sdkCliPath));
      await withTimeout(client.start(), 10000);
      const models = await withTimeout(client.listModels(), 5000);
      await client.stop().catch(() => []);
      const mapped = models.map(mapModelInfo);
      return {
        id: this.id,
        label: this.label,
        available: true,
        details: "Using @github/copilot-sdk. Model list is loaded from Copilot.",
        capabilities,
        models: mapped,
        defaultModel: mapped.find((model) => model.id === "auto")?.id ?? mapped[0]?.id ?? this.options.model,
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        details: sdkFailureDetails(error, this.options),
        capabilities,
        models: fallbackModels(this.options.model),
        defaultModel: this.options.model,
      };
    }
  }
  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderEvent> {
    const fallback = new EchoProvider(this.options.model);
    try {
      yield* this.streamWithSdk(request);
    } catch (error) {
      yield { type: "delta", text: `Copilot SDK was unavailable (${(error as Error).message}). Falling back to local development provider.\n\n` };
      yield* fallback.streamChat(request);
    }
  }
  private async *streamWithSdk(request: ProviderChatRequest): AsyncIterable<ProviderEvent> {
    const client = new CopilotClient(copilotClientOptions(request.gitHubToken ?? this.options.gitHubToken, this.options.sdkCliPath, request.workingDirectory));
    const queue = new AsyncEventQueue<ProviderEvent>();
    const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
    const sessionOptions: SessionConfig = { clientName: "CopilotChat", sessionId: request.sessionId ?? undefined, model: request.model, reasoningEffort: sdkReasoningEffort(request.reasoningEffort), streaming: true, includeSubAgentStreamingEvents: true, infiniteSessions: { enabled: true, backgroundCompactionThreshold: 0.8, bufferExhaustionThreshold: 0.95 }, gitHubToken: request.gitHubToken ?? this.options.gitHubToken, onPermissionRequest: buildPermissionHandler(request), onUserInputRequest: buildUserInputHandler(request), onElicitationRequest: buildElicitationHandler(request), hooks: buildSandboxHooks(request), tools: buildTools(request), systemMessage: { mode: "append", content: buildSystemContext(request) } };
    if (request.workingDirectory) sessionOptions.workingDirectory = request.workingDirectory;
    if (request.workingDirectory) sessionOptions.createSessionFsProvider = () => new RootBoundSessionFsProvider(request.workingDirectory!);
    const mcpServers = mapMcpServers(request.mcpServers ?? []);
    if (Object.keys(mcpServers).length > 0) sessionOptions.mcpServers = mcpServers;
    let sessionData: { session: CopilotSession; resumed: boolean };
    try { sessionData = await createOrResumeSdkSession(client, sessionOptions, Boolean(request.resumeSession && request.sessionId)); }
    catch (error) { await client.stop().catch(() => []); throw error; }
    const { session, resumed } = sessionData;
    yield { type: "session", sessionId: session.sessionId, workspacePath: session.workspacePath ?? null, resumed, infinite: true };
    const unregisterSteer = request.controls?.onSteer((message) => session.send({ prompt: message.content, mode: "immediate", attachments: sdkAttachments(message) }).then(() => undefined));
    const rootText: ProviderTextState = { length: 0, tail: "" };
    let rootTextClosed = false;
    const subagentText = new Map<string, ProviderTextState>();
    const subagentReasoningText = new Map<string, ProviderTextState>();
    const subagentTextClosed = new Set<string>();
    const subagentReasoningClosed = new Set<string>();
    const sawSubagentDelta = new Set<string>();
    const sawSubagentReasoningDelta = new Set<string>();
    const pushCappedText = (text: string, eventForText: (text: string) => ProviderEvent, state: ProviderTextState, closeOnTruncate = false, limit = providerTextLimit): { truncated: boolean } => {
      const next = appendCappedProviderText(state, text, limit);
      if (next.appended) queue.push(eventForText(next.appended));
      if (next.truncated && closeOnTruncate) {
        queue.push({ type: "done", usage: { provider: this.id, truncated: true } });
        queue.close();
      }
      return { truncated: next.truncated };
    };
    session.on((event: SessionEvent) => {
      const eventType = String(event.type);
      const agentId = eventAgentId(event);
      if (eventType === "assistant.message_delta") {
        if (!agentId || subagentTextClosed.has(agentId)) return;
        const text = readNestedString(event.data, ["deltaContent"]);
        if (text) {
          sawSubagentDelta.add(agentId);
          const next = pushCappedText(text, (chunk) => ({ type: "subagent-delta", id: agentId, text: chunk }), getProviderTextState(subagentText, agentId), false, providerValueStringLimit);
          if (next.truncated) subagentTextClosed.add(agentId);
        }
        return;
      }
      if (eventType === "assistant.reasoning_delta") {
        if (!agentId || subagentReasoningClosed.has(agentId)) return;
        const text = readNestedString(event.data, ["deltaContent"]);
        if (text) {
          sawSubagentReasoningDelta.add(agentId);
          const next = pushCappedText(text, (chunk) => ({ type: "subagent-reasoning-delta", id: agentId, text: chunk }), getProviderTextState(subagentReasoningText, agentId), false, providerValueStringLimit);
          if (next.truncated) subagentReasoningClosed.add(agentId);
        }
        return;
      }
      if (eventType === "assistant.message") {
        const content = readNestedString(event.data, ["content"]);
        if (content && agentId) {
          if (sawSubagentDelta.has(agentId)) return;
          pushCappedText(content, (chunk) => ({ type: "subagent-delta", id: agentId, text: chunk }), getProviderTextState(subagentText, agentId), false, providerValueStringLimit);
        } else if (content && !rootTextClosed) {
          const next = pushCappedText(content, (chunk) => ({ type: "delta", text: chunk }), rootText, true);
          rootTextClosed = next.truncated;
        }
        return;
      }
      if (eventType === "assistant.reasoning") {
        const content = readNestedString(event.data, ["content"]);
        if (content && agentId) {
          if (sawSubagentReasoningDelta.has(agentId)) return;
          pushCappedText(content, (chunk) => ({ type: "subagent-reasoning-delta", id: agentId, text: chunk }), getProviderTextState(subagentReasoningText, agentId), false, providerValueStringLimit);
        } else if (content) {
          queue.push({ type: "reasoning", text: truncateProviderString(content) });
        }
        return;
      }
      if (eventType === "tool.execution_start") { const tool = { toolCallId: eventId(event.data), toolName: eventToolName(event.data), input: limitProviderValue(eventToolInput(event.data)) }; queue.push(agentId ? { type: "subagent-tool-call", id: agentId, ...tool } : { type: "tool-call", id: tool.toolCallId, toolName: tool.toolName, input: tool.input }); return; }
      if (eventType === "tool.execution_complete") { const error = eventToolError(event.data); const tool = { toolCallId: eventId(event.data), toolName: eventToolName(event.data), output: limitProviderValue(eventToolOutput(event.data)), error: error ? truncateProviderString(error) : null, status: error ? "failed" as const : "succeeded" as const }; queue.push(agentId ? { type: "subagent-tool-result", id: agentId, ...tool } : { type: "tool-result", id: tool.toolCallId, toolName: tool.toolName, output: tool.output, error: tool.error, status: tool.status }); return; }
      if (eventType === "subagent.started") { queue.push({ type: "subagent-start", id: subagentEventId(event), name: readNestedString(event.data, ["agentName"]) ?? "subagent", displayName: readNestedString(event.data, ["agentDisplayName"]) ?? "Subagent", description: readNestedString(event.data, ["agentDescription"]) ?? undefined, model: readNestedString(event.data, ["model"]) ?? undefined, toolCallId: readNestedString(event.data, ["toolCallId"]) }); return; }
      if (eventType === "subagent.completed") { queue.push({ type: "subagent-complete", id: subagentEventId(event), name: readNestedString(event.data, ["agentName"]) ?? "subagent", displayName: readNestedString(event.data, ["agentDisplayName"]) ?? "Subagent", durationMs: readNestedNumber(event.data, ["durationMs"]) ?? undefined, model: readNestedString(event.data, ["model"]) ?? undefined, totalTokens: readNestedNumber(event.data, ["totalTokens"]) ?? undefined, totalToolCalls: readNestedNumber(event.data, ["totalToolCalls"]) ?? undefined }); return; }
      if (eventType === "subagent.failed") { queue.push({ type: "subagent-failed", id: subagentEventId(event), name: readNestedString(event.data, ["agentName"]) ?? "subagent", displayName: readNestedString(event.data, ["agentDisplayName"]) ?? "Subagent", error: readNestedString(event.data, ["error"]) ?? "Subagent failed.", durationMs: readNestedNumber(event.data, ["durationMs"]) ?? undefined, model: readNestedString(event.data, ["model"]) ?? undefined, totalTokens: readNestedNumber(event.data, ["totalTokens"]) ?? undefined, totalToolCalls: readNestedNumber(event.data, ["totalToolCalls"]) ?? undefined }); return; }
      if (eventType === "session.plan_changed") { void session.rpc.plan.read().then((plan) => { const items = parseTaskListItems(plan.content ?? ""); if (items.length > 0) queue.push({ type: "task-list", id: "session-plan", title: "Session plan", source: "plan.md", content: plan.content, items }); }).catch(() => undefined); return; }
      if (eventType === "session.idle") { queue.push({ type: "done", usage: { provider: this.id } }); queue.close(); return; }
      if (eventType === "session.error") queue.fail(new Error(readNestedString(event.data, ["message"]) ?? "Copilot SDK session failed."));
    });
    void session.send({ prompt: resumed ? (lastUserMessage?.content ?? "") : buildSdkPrompt(request, lastUserMessage?.content ?? ""), attachments: sdkAttachments(lastUserMessage) }).catch((error: unknown) => queue.fail(error instanceof Error ? error : new Error(String(error))));
    try { yield* queue; } finally { unregisterSteer?.(); await session.disconnect(); await client.stop().catch(() => []); }
  }
}

class EchoProvider implements CopilotProvider {
  id = "echo"; label = "Local development provider";
  constructor(private readonly model: string) {}
  status(): Promise<ProviderStatus> { return Promise.resolve({ id: this.id, label: this.label, available: true, details: "Using local echo provider. Configure Copilot SDK/auth, HTTP, or CLI provider for real model responses.", capabilities: ["streaming", "markdown", "artifacts:synthetic"], models: fallbackModels(this.model), defaultModel: this.model }); }
  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderEvent> {
    if (request.sessionId) yield { type: "session", sessionId: request.sessionId, workspacePath: null, resumed: Boolean(request.resumeSession), infinite: false };
    const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
    const steeringNotes: ProviderMessage[] = [];
    const unregisterSteer = request.controls?.onSteer((message) => { steeringNotes.push(message); });
    const enabledSkills = request.skills?.map((skill) => skill.name).join(", ") || "none";
    const attachmentSummary = summarizeAttachments(lastUser?.attachments);
    const priorMessages = request.messages.slice(0, -1);
    const projectContext = summarizeInline(request.projectContext);
    const shouldShowActivity = /thinking|reasoning|tool|search|workspace|file|artifact/i.test(lastUser?.content ?? "");
    if (shouldShowActivity) {
      yield { type: "tool-call", id: "echo-report-intent", toolName: "report_intent", input: { intent: "Inspecting context" } };
      await delay(12);
      yield { type: "tool-result", id: "echo-report-intent", toolName: "report_intent", status: "succeeded", output: { content: "Intent logged", detailedContent: "Inspecting context" } };
      await delay(12);
      yield { type: "reasoning-delta", text: "Checking the active chat context and selected tools." };
      await delay(12);
      yield { type: "tool-call", id: "echo-context-check", toolName: "context.inspect", input: { messages: request.messages.length, skills: request.skills?.map((skill) => skill.name) ?? [] } };
      await delay(12);
      yield { type: "tool-result", id: "echo-context-check", toolName: "context.inspect", status: "succeeded", output: { provider: "echo", workspace: request.workingDirectory ?? null } };
      await delay(12);
      if (/long tool payload|overflowing tool|tool overflow/i.test(lastUser?.content ?? "")) {
        const longCommand = `gh search repos 'language:Go topic:cli ${"sort stars ".repeat(24)}' --json nameWithOwner,description,stargazerCount`;
        yield { type: "tool-call", id: "echo-long-tool", toolName: "bash", input: { command: longCommand, description: "Search popular Go CLI repos with a deliberately long command payload", mode: "sync", initial_wait: 30 } };
        await delay(8);
        yield { type: "tool-result", id: "echo-long-tool", toolName: "bash", status: "failed", error: `The command was rejected after reviewing this very long payload: ${longCommand}`, output: null };
        await delay(8);
      }
      if (/many tool calls|tool call group|lots of tools/i.test(lastUser?.content ?? "")) {
        for (let index = 1; index <= 5; index += 1) {
          yield { type: "tool-call", id: `echo-extra-tool-${index}`, toolName: `context.step_${index}`, input: { index } };
          await delay(8);
          yield { type: "tool-result", id: `echo-extra-tool-${index}`, toolName: `context.step_${index}`, status: index === 5 ? "failed" : "succeeded", error: index === 5 ? "Synthetic failure for grouped-tool status counts." : null, output: { index, ok: index !== 5 } };
          await delay(8);
        }
      }
    }
    if (/subagent|sub-agent|delegate/i.test(lastUser?.content ?? "")) {
      yield { type: "subagent-start", id: "echo-subagent", name: "research-helper", displayName: "Research helper", description: "Inspect project context and summarize useful findings.", model: request.model, toolCallId: "echo-subagent-tool" };
      await delay(12);
      yield { type: "subagent-reasoning-delta", id: "echo-subagent", text: "Checking project context before reporting back." };
      await delay(12);
      yield { type: "subagent-tool-call", id: "echo-subagent", toolCallId: "echo-subagent-search", toolName: "context.search", input: { query: "project context" } };
      await delay(12);
      yield { type: "subagent-tool-result", id: "echo-subagent", toolCallId: "echo-subagent-search", toolName: "context.search", status: "succeeded", output: { matches: 2 } };
      await delay(12);
      yield { type: "subagent-delta", id: "echo-subagent", text: "Found shared project context and recent chat references." };
      await delay(12);
      yield { type: "subagent-complete", id: "echo-subagent", name: "research-helper", displayName: "Research helper", durationMs: 42, model: request.model, totalTokens: 128, totalToolCalls: 1 };
      await delay(12);
    }
    const importPreviewText = await maybeRunEchoImportPreview(request, lastUser?.content ?? "");
    const lowerPrompt = lastUser?.content.toLowerCase() ?? "";
    if (request.titleTool && (request.titleTool.required || /title|conversation|rename|topic/i.test(lastUser?.content ?? ""))) {
      const title = suggestConversationTitle(lastUser?.content ?? "");
      if (title && title !== request.titleTool.currentTitle) {
        yield { type: "tool-call", id: "echo-title-tool", toolName: "set_conversation_title", input: { title } };
        const savedTitle = await request.titleTool.setTitle(title);
        yield { type: "tool-result", id: "echo-title-tool", toolName: "set_conversation_title", status: "succeeded", output: { title: savedTitle } };
      }
    }
    let userAnswer = "";
    if (/ask me|question|user input/.test(lowerPrompt)) {
      const questionRequest = { question: "Which option should I use?", choices: ["alpha", "beta"], allowFreeform: true };
      yield { type: "tool-call", id: "echo-ask-user", toolName: "ask_user", input: questionRequest };
      const answer = await request.interactions?.requestUserInput?.(questionRequest);
      yield { type: "tool-result", id: "echo-ask-user", toolName: "ask_user", status: "succeeded", output: answer ?? { answer: "", wasFreeform: true } };
      userAnswer = answer ? `\n\n- User answered: ${answer.answer}${answer.wasFreeform ? " (freeform)" : ""}.` : "";
    }
    let permissionText = "";
    if (/url permission|network permission|allow url|fetch url/.test(lowerPrompt)) {
      const permissionRequest = { kind: "url", toolCallId: "echo-url-permission", toolName: "web.fetch", url: "https://example.com/docs", raw: { kind: "url", toolCallId: "echo-url-permission", toolName: "web.fetch", url: "https://example.com/docs", method: "GET", reason: "Fetch requested URL" } };
      const decision = request.permissionMode === "yolo" ? "approve" : await request.interactions?.requestPermission?.(permissionRequest) ?? "deny";
      permissionText = `\n\n- Permission decision: ${decision === "approve" ? "approved" : "denied"}${request.permissionMode === "yolo" ? " (yolo)" : ""}.`;
    } else if (/permission|approval|shell/.test(lowerPrompt)) {
      const decision = request.permissionMode === "yolo"
        ? "approve"
        : await request.interactions?.requestPermission?.({ kind: "shell", toolCallId: "echo-permission", toolName: "shell", fullCommandText: "echo hello", raw: { kind: "shell", fullCommandText: "echo hello" } }) ?? "deny";
      permissionText = `\n\n- Permission decision: ${decision === "approve" ? "approved" : "denied"}${request.permissionMode === "yolo" ? " (yolo)" : ""}.`;
    }
    let elicitationText = "";
    if (/elicitation|form/.test(lowerPrompt)) {
      const result = await request.interactions?.requestElicitation?.({ message: "Configure the sample action", mode: "form", elicitationSource: "echo", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } });
      elicitationText = result ? `\n\n- Elicitation action: ${result.action}.` : "";
    }
    const taskListText = /task list|todo list|checklist|tasks with progress/.test(lowerPrompt) ? "\n\n- [x] Understand the request\n- [x] Render task list progress\n- [ ] Polish the final details" : "";
    if (taskListText) yield { type: "task-list", id: "echo-task-list", title: "Task list", source: "assistant", content: taskListText.trim(), items: parseTaskListItems(taskListText) };
    const response = [
      "I am running with the local development provider using model label `" + request.model + "`.",
      "",
      "You said: " + (lastUser?.content ?? "(no user message)"),
      "",
      "- Messages in context: " + request.messages.length + ".",
      request.sessionId ? "- Provider session: " + request.sessionId + (request.resumeSession ? " (resume)" : " (new)") + "." : "",
      priorMessages.length > 0 ? "- Previous context: " + summarizeInline(priorMessages.map((message) => `${message.role}: ${message.content}`).join(" | ")) : "",
      projectContext ? "- Project context: " + projectContext : "",
      "- Enabled skills: " + enabledSkills + ".",
      attachmentSummary ? "- Attachments: " + attachmentSummary + "." : "",
      "- Reasoning effort: " + (request.reasoningEffort ?? "default") + ".",
      request.workingDirectory ? "- Workspace: " + request.workingDirectory : "",
      importPreviewText,
      "",
      `Configure Copilot auth/provider settings to use your Copilot subscription.${userAnswer}${permissionText}${elicitationText}${taskListText}`,
    ].filter((line, index, lines) => line || (lines[index - 1] && lines[index + 1])).join("\n");
    const streamDelayMs = /start a long response/i.test(lastUser?.content ?? "") ? 10 : 3;
    for (const token of chunkText(response, 24)) {
      while (steeringNotes.length > 0) yield { type: "delta", text: echoSteeringText(steeringNotes.shift()) };
      yield { type: "delta", text: token };
      await delay(streamDelayMs);
    }
    while (steeringNotes.length > 0) yield { type: "delta", text: echoSteeringText(steeringNotes.shift()) };
    unregisterSteer?.();
    if (/artifact/i.test(lastUser?.content ?? "")) yield { type: "artifact", title: "Generated artifact", kind: "markdown", content: `# Artifact\n\n${lastUser?.content ?? ""}` };
    yield { type: "done", usage: { provider: this.id } };
  }
}

class HttpCopilotProvider implements CopilotProvider {
  id = "http"; label = "Copilot-compatible HTTP provider";
  constructor(private readonly options: ProviderFactoryOptions) {}
  async status(): Promise<ProviderStatus> {
    const available = Boolean(this.options.apiBaseUrl && this.options.apiToken);
    let models = fallbackModels(this.options.model);
    if (available) {
      try {
        const response = await withTimeout(fetch(`${this.options.apiBaseUrl!.replace(/\/$/, "")}/models`, { headers: { Authorization: `Bearer ${this.options.apiToken}` } }), 3000);
        if (response.ok) {
          const body = await response.json() as { data?: Array<{ id?: string; name?: string }> };
          const listed = body.data?.map((model) => ({ id: model.id ?? model.name ?? "", name: model.name ?? model.id ?? "", supportsReasoningEffort: true, supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium" })).filter((model) => model.id);
          if (listed && listed.length > 0) models = listed;
        }
      } catch { /* keep configured model */ }
    }
    return { id: this.id, label: this.label, available, details: available ? `Using HTTP provider at ${this.options.apiBaseUrl}` : "Set COPILOT_API_BASE_URL and COPILOT_API_TOKEN.", capabilities: ["streaming", "markdown", "tools:provider-dependent"], models, defaultModel: models[0]?.id ?? this.options.model };
  }
  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderEvent> {
    if (!this.options.apiBaseUrl || !this.options.apiToken) throw new Error("HTTP provider is missing COPILOT_API_BASE_URL or COPILOT_API_TOKEN.");
    const body = { model: request.model, reasoning_effort: request.reasoningEffort === "default" ? undefined : request.reasoningEffort, stream: true, messages: materializeMessages(request) };
    const response = await fetch(`${this.options.apiBaseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${this.options.apiToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: request.abortSignal });
    if (!response.ok || !response.body) throw new Error(`HTTP provider failed with ${response.status}: ${await response.text()}`);
    const decoder = new TextDecoder(); const reader = response.body.getReader(); let buffer = "";
    while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) { const trimmed = line.trim(); if (!trimmed.startsWith("data:")) continue; const payload = trimmed.slice(5).trim(); if (payload === "[DONE]") { yield { type: "done" }; return; } const text = extractOpenAiDelta(payload); if (text) yield { type: "delta", text }; } }
    yield { type: "done" };
  }
}

class CliCopilotProvider implements CopilotProvider {
  id = "cli"; label = "Local CLI bridge";
  constructor(private readonly options: ProviderFactoryOptions) {}
  status(): Promise<ProviderStatus> { return Promise.resolve({ id: this.id, label: this.label, available: Boolean(this.options.cliCommand), details: this.options.cliCommand ? `Using CLI bridge: ${this.options.cliCommand}` : "Set COPILOT_CLI_COMMAND.", capabilities: ["markdown", "local-cli-auth", "streaming:stdout"], models: fallbackModels(this.options.model), defaultModel: this.options.model }); }
  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderEvent> {
    if (!this.options.cliCommand) throw new Error("CLI provider is missing COPILOT_CLI_COMMAND.");
    const child = spawn(this.options.cliCommand, [], { cwd: request.workingDirectory ?? process.cwd(), shell: true, stdio: ["pipe", "pipe", "pipe"], signal: request.abortSignal });
    child.stdin.end(buildCliPrompt(request)); let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    for await (const chunk of child.stdout) yield { type: "delta", text: String(chunk) };
    const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
    if (exitCode !== 0) throw new Error(`CLI provider exited with ${exitCode ?? "unknown"}: ${stderr}`);
    yield { type: "done", usage: { provider: this.id } };
  }
}

function copilotClientOptions(gitHubToken?: string | null, cliPath?: string, sandboxRoot?: string | null): CopilotClientOptions | undefined {
  if (!gitHubToken && !cliPath && !sandboxRoot) return undefined;
  const options: CopilotClientOptions = {};
  if (cliPath) options.connection = RuntimeConnection.forStdio({ path: cliPath });
  if (sandboxRoot) options.sessionFs = { initialCwd: path.resolve(sandboxRoot), sessionStatePath: ".copilotchat-session", conventions: process.platform === "win32" ? "windows" : "posix" };
  if (gitHubToken) {
    options.gitHubToken = gitHubToken;
    options.useLoggedInUser = false;
  }
  return options;
}

async function createOrResumeSdkSession(client: CopilotClient, config: SessionConfig, preferResume: boolean): Promise<{ session: CopilotSession; resumed: boolean }> {
  const { sessionId, ...resumeConfig } = config;
  if (preferResume && sessionId) {
    try { return { session: await client.resumeSession(sessionId, resumeConfig), resumed: true }; }
    catch (error) { if (!isMissingSessionError(error)) throw error; }
  }
  try { return { session: await client.createSession(config), resumed: false }; }
  catch (error) {
    if (sessionId && isExistingSessionError(error)) return { session: await client.resumeSession(sessionId, resumeConfig), resumed: true };
    throw error;
  }
}

function isMissingSessionError(error: unknown): boolean { return /not found|does not exist|no session/i.test(error instanceof Error ? error.message : String(error)); }
function isExistingSessionError(error: unknown): boolean { return /already exists|exists|duplicate/i.test(error instanceof Error ? error.message : String(error)); }
function materializeMessages(request: ProviderChatRequest): ProviderMessage[] { const system = buildSystemContext(request); return system ? [{ role: "system", content: system }, ...request.messages] : request.messages; }
function buildCliPrompt(request: ProviderChatRequest): string { return materializeMessages(request).map((message) => `${message.role.toUpperCase()}:\n${message.content}${message.attachments?.length ? `\nAttachments: ${summarizeAttachments(message.attachments)}` : ""}`).join("\n\n"); }
function buildSdkPrompt(request: ProviderChatRequest, latestUserMessage: string): string {
  const previous = request.messages.slice(0, -1);
  if (previous.length === 0) return latestUserMessage;
  return [
    "Continue this conversation. Prior messages are context; answer only the latest user message.",
    previous.map((m) => `${m.role.toUpperCase()}:\n${m.content}${m.attachments?.length ? `\nAttachments: ${summarizeAttachments(m.attachments)}` : ""}`).join("\n\n"),
    "Latest user message:",
    latestUserMessage,
  ].filter(Boolean).join("\n\n");
}
function sdkAttachments(message?: ProviderMessage): MessageOptions["attachments"] | undefined { return message?.attachments?.map((attachment) => ({ type: "blob" as const, data: attachment.data, mimeType: attachment.mimeType, displayName: attachment.displayName })); }
function summarizeAttachments(attachments?: ProviderAttachment[]): string { return attachments?.map((attachment) => `${attachment.displayName ?? "attachment"} (${attachment.mimeType}, ${formatBytes(attachment.data.length * 0.75)})`).join(", ") ?? ""; }
function echoSteeringText(message?: ProviderMessage): string {
  if (!message) return "";
  const attachmentSummary = summarizeAttachments(message.attachments);
  return `\n\nSteering received: ${message.content || "(no text)"}${attachmentSummary ? `\n\nSteering attachments: ${attachmentSummary}.` : ""}`;
}
function formatBytes(value: number): string { if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`; if (value >= 1024) return `${Math.round(value / 1024)} KB`; return `${Math.max(0, Math.round(value))} B`; }
function buildSystemContext(request: ProviderChatRequest): string { return [request.projectContext ? `Project context:\n${request.projectContext}` : "", request.workingDirectory ? `Active workspace: ${request.workingDirectory}\nSandbox: local filesystem and tool access must stay inside this workspace. Do not use paths outside it.` : "", request.titleTool ? `Conversation title: ${request.titleTool.currentTitle}\n${request.titleTool.required ? "You must call set_conversation_title after this first user message." : "Use the set_conversation_title tool whenever the conversation title should substantively change."} Titles must be concise, specific, and six words maximum. Do not mention that you are setting the title.` : "", request.artifactContext ?? "", ...(request.skills ?? []).map((skill) => [`Skill: ${skill.name}`, skill.description, skill.instructions, skill.workflow.length > 0 ? `Workflow:\n${skill.workflow.join("\n")}` : ""].filter(Boolean).join("\n"))].filter(Boolean).join("\n\n"); }
async function maybeRunEchoImportPreview(request: ProviderChatRequest, content: string): Promise<string> {
  const draftId = /Import draft ID:\s*([a-zA-Z0-9_.-]+)/i.exec(content)?.[1];
  const previewTool = request.tools?.find((tool) => tool.name === "preview_import_draft");
  if (!draftId || !previewTool) return "";
  const input = { draftId };
  const output = await previewTool.handler(input);
  return `- Import draft preview: ${summarizeInline(formatToolOutput(output))}.\n- Next import step: ask for Claude/ChatGPT project conversation screenshots or pasted title lists if project membership needs verification, then wait for confirmation before applying.`;
}
function buildTools(request: ProviderChatRequest): Tool[] | undefined {
  const customTools = (request.tools ?? []).map((tool): Tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, skipPermission: tool.skipPermission, handler: tool.handler }));
  const tools = [...customTools, buildTitleTool(request)].filter((tool): tool is Tool => Boolean(tool));
  return tools.length ? tools : undefined;
}
function buildTitleTool(request: ProviderChatRequest): Tool | null {
  if (!request.titleTool) return null;
  return {
    name: "set_conversation_title",
    description: "Set the current conversation title when the topic changes. Use concise, specific titles of six words maximum.",
    parameters: { type: "object", properties: { title: { type: "string", description: "A concise conversation title, six words maximum." } }, required: ["title"], additionalProperties: false },
    skipPermission: true,
    handler: async (args: unknown) => {
      const requestedTitle = readFirstString(args, [["title"]]) ?? "";
      const title = normalizeConversationTitle(requestedTitle);
      if (!title) throw new Error("Conversation title cannot be empty.");
      return { title: await request.titleTool!.setTitle(title) };
    },
  };
}
function mapMcpServers(servers: McpServer[]): Record<string, MCPServerConfig> { const mapped: Record<string, MCPServerConfig> = {}; for (const server of servers.filter((s) => s.enabled && s.tools.length > 0)) { if (server.transport === "stdio") { if (!server.command) throw new Error(`MCP server ${server.name} is missing a command.`); mapped[server.name] = { type: "stdio", command: server.command, args: server.args, tools: server.tools }; } else { if (!server.url) throw new Error(`MCP server ${server.name} is missing a URL.`); mapped[server.name] = { type: server.transport, url: server.url, tools: server.tools }; } } return mapped; }
function buildPermissionHandler(request: ProviderChatRequest): PermissionHandler {
  return async (permissionRequest: unknown) => {
    const serialized = serializePermissionRequest(permissionRequest);
    const sandboxViolation = sandboxViolationForPermission(serialized, request.workingDirectory);
    if (sandboxViolation) return { kind: "reject", feedback: sandboxViolation };
    if (request.permissionMode === "yolo") return { kind: "approve-once" };
    const decision = await request.interactions?.requestPermission?.(serialized);
    return decision === "approve" ? { kind: "approve-once" } : { kind: "reject", feedback: "Denied in CopilotChat." };
  };
}
function buildSandboxHooks(request: ProviderChatRequest): SessionConfig["hooks"] | undefined {
  if (!request.workingDirectory) return undefined;
  return { onPreToolUse: (input) => {
    const violation = sandboxViolationForTool(input.toolName, input.toolArgs, request.workingDirectory);
    return violation ? { permissionDecision: "deny", permissionDecisionReason: violation } : undefined;
  } };
}
function buildUserInputHandler(request: ProviderChatRequest) {
  return async (inputRequest: unknown) => {
    const serialized = serializeUserInputRequest(inputRequest);
    const response = await request.interactions?.requestUserInput?.(serialized);
    return response ?? { answer: "", wasFreeform: true };
  };
}
function buildElicitationHandler(request: ProviderChatRequest) {
  return async (elicitationRequest: unknown) => {
    const serialized = serializeElicitationRequest(elicitationRequest);
    return await request.interactions?.requestElicitation?.(serialized) ?? { action: "cancel" as const };
  };
}
function serializePermissionRequest(request: unknown): ProviderPermissionRequest {
  const kind = readFirstString(request, [["kind"], ["type"]]) ?? "tool";
  const toolCallId = readFirstString(request, [["toolCallId"], ["tool_call_id"], ["id"]]);
  const toolName = readFirstString(request, [["toolName"], ["tool_name"], ["name"], ["tool", "name"], ["server"], ["mcpServer"], ["mcp_server"]]);
  const fileName = readFirstString(request, [["fileName"], ["file_name"], ["filePath"], ["file_path"], ["path"]]);
  const fullCommandText = readFirstString(request, [["fullCommandText"], ["full_command_text"], ["commandText"], ["command_text"], ["command"], ["cmd"]]);
  const url = readFirstString(request, [["url"], ["uri"], ["href"], ["targetUrl"], ["target_url"], ["request", "url"], ["input", "url"], ["arguments", "url"], ["args", "url"], ["data", "url"], ["metadata", "url"]]) ?? readFirstStringByKey(request, ["url", "uri", "href", "targetUrl", "target_url"]);
  const details = compactRecord({
    kind,
    toolCallId,
    toolName,
    fileName,
    fullCommandText,
    url,
    method: readFirstString(request, [["method"], ["httpMethod"], ["http_method"], ["request", "method"], ["input", "method"], ["arguments", "method"], ["args", "method"]]) ?? readFirstStringByKey(request, ["method", "httpMethod", "http_method"]),
    host: readFirstString(request, [["host"], ["hostname"], ["domain"], ["origin"], ["request", "host"], ["input", "host"], ["arguments", "host"], ["args", "host"]]) ?? readFirstStringByKey(request, ["host", "hostname", "domain", "origin"]),
    reason: readFirstString(request, [["reason"], ["description"], ["message"], ["prompt"]]) ?? readFirstStringByKey(request, ["reason", "description", "message", "prompt"]),
  });
  return { kind, toolCallId, toolName, fileName, fullCommandText, url, details: Object.keys(details).length > 0 ? details : undefined, raw: request };
}
function serializeUserInputRequest(request: unknown): ProviderUserInputRequest {
  const choices = readNestedValue(request, ["choices"]) ?? readNestedValue(request, ["options"]);
  const allowFreeform = readNestedValue(request, ["allowFreeform"]) ?? readNestedValue(request, ["allow_freeform"]) ?? readNestedValue(request, ["freeform"]);
  return { question: readFirstString(request, [["question"], ["message"], ["prompt"], ["input", "question"], ["arguments", "question"], ["args", "question"]]) ?? "The agent needs more information.", choices: Array.isArray(choices) ? choices.map(String) : typeof choices === "string" ? choices.split(/\n|,/).map((choice) => choice.trim()).filter(Boolean) : undefined, allowFreeform: allowFreeform !== false };
}
function serializeElicitationRequest(request: unknown): ProviderElicitationRequest {
  return { message: readFirstString(request, [["message"], ["prompt"]]) ?? "Additional information is needed.", mode: readFirstString(request, [["mode"]]), elicitationSource: readFirstString(request, [["elicitationSource"], ["source"]]), requestedSchema: readNestedValue(request, ["requestedSchema"]) ?? readNestedValue(request, ["schema"]) };
}
class RootBoundSessionFsProvider implements SessionFsProvider {
  constructor(private readonly root: string) {}
  async readFile(filePath: string): Promise<string> { return fs.readFile(await this.existingPath(filePath), "utf8"); }
  async writeFile(filePath: string, content: string, mode?: number): Promise<void> { const target = await this.writablePath(filePath); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, { mode }); }
  async appendFile(filePath: string, content: string, mode?: number): Promise<void> { const target = await this.writablePath(filePath); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.appendFile(target, content, { mode }); }
  async exists(filePath: string): Promise<boolean> { try { await this.existingPath(filePath); return true; } catch { return false; } }
  async stat(filePath: string): Promise<SessionFsFileInfo> { const stat = await fs.stat(await this.existingPath(filePath)); return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), size: stat.size, mtime: stat.mtime.toISOString(), birthtime: stat.birthtime.toISOString() }; }
  async mkdir(filePath: string, recursive: boolean, mode?: number): Promise<void> { await fs.mkdir(await this.writablePath(filePath), { recursive, mode }); }
  async readdir(filePath: string): Promise<string[]> { return fs.readdir(await this.existingPath(filePath)); }
  async readdirWithTypes(filePath: string): Promise<Array<{ name: string; type: "file" | "directory" }>> { const entries = await fs.readdir(await this.existingPath(filePath), { withFileTypes: true }); return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" as const : "file" as const })); }
  async rm(filePath: string, recursive: boolean, force: boolean): Promise<void> { await fs.rm(await this.lexicalPath(filePath), { recursive, force }); }
  async rename(src: string, dest: string): Promise<void> { await fs.rename(await this.existingPath(src), await this.writablePath(dest)); }
  private async rootRealPath(): Promise<string> { return fs.realpath(path.resolve(this.root)); }
  private async lexicalPath(filePath: string): Promise<string> { const root = await this.rootRealPath(); const target = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath); if (!isPathInside(root, target)) throw sandboxError(`Path '${filePath}' is outside the active workspace.`); return target; }
  private async existingPath(filePath: string): Promise<string> { const target = await this.lexicalPath(filePath); const real = await fs.realpath(target); const root = await this.rootRealPath(); if (!isPathInside(root, real)) throw sandboxError(`Path '${filePath}' resolves outside the active workspace.`); return target; }
  private async writablePath(filePath: string): Promise<string> { const target = await this.lexicalPath(filePath); try { await this.existingPath(filePath); return target; } catch (error) { if (!isEnoent(error)) throw error; } const parent = await nearestExistingParent(path.dirname(target)); const parentReal = await fs.realpath(parent); const root = await this.rootRealPath(); if (!isPathInside(root, parentReal)) throw sandboxError(`Path '${filePath}' would write outside the active workspace.`); return target; }
}
function sandboxViolationForPermission(request: ProviderPermissionRequest, root?: string | null): string | null {
  if (!root) return null;
  const filePath = request.fileName ?? (typeof request.details?.path === "string" ? request.details.path : null);
  if (filePath && !isCandidatePathInsideRoot(filePath, root)) return `Denied by CopilotChat sandbox: ${filePath} is outside the active workspace.`;
  if (request.fullCommandText) return commandSandboxViolation(request.fullCommandText, root, root);
  if (request.kind === "shell" && !request.fullCommandText) return "Denied by CopilotChat sandbox: shell permission did not include a command to inspect.";
  return null;
}
function sandboxViolationForTool(toolName: string, args: unknown, root?: string | null): string | null {
  if (!root) return null;
  const command = readFirstString(args, [["command"], ["cmd"], ["fullCommandText"], ["full_command_text"], ["input", "command"]]);
  if (command) {
    const violation = commandSandboxViolation(command, root, root);
    if (violation) return violation;
  }
  const pathViolation = firstPathSandboxViolation(args, root);
  return pathViolation ? `Denied by CopilotChat sandbox: ${pathViolation} is outside the active workspace for ${toolName}.` : null;
}
function commandSandboxViolation(command: string, root: string, cwd: string): string | null {
  if (/[;&|`$<>\n\r]/.test(command)) return "Denied by CopilotChat sandbox: shell metacharacters are not allowed because they cannot be safely sandboxed.";
  const argv = splitCommandLine(command);
  const executable = path.basename(argv[0] ?? "");
  if (!executable) return "Denied by CopilotChat sandbox: command is empty.";
  if (/^(sh|bash|zsh|fish|osascript|pwsh|powershell)$/i.test(executable)) return "Denied by CopilotChat sandbox: nested shells are not allowed.";
  if (argv.some((arg) => /^(-c|--command|-e|--eval|--execute)$/i.test(arg))) return "Denied by CopilotChat sandbox: inline code execution flags are not allowed.";
  for (const arg of argv.slice(1)) {
    const violation = commandArgPathViolation(arg, root, cwd);
    if (violation) return `Denied by CopilotChat sandbox: ${violation} is outside the active workspace.`;
  }
  return null;
}
function commandArgPathViolation(arg: string, root: string, cwd: string): string | null {
  const values = arg.startsWith("-") && arg.includes("=") ? [arg.slice(arg.indexOf("=") + 1)] : [arg];
  for (const value of values) {
    if (looksLikeUrl(value) || !looksLikePath(value)) continue;
    if (!isCandidatePathInsideRoot(value, root, cwd)) return value;
  }
  return null;
}
function firstPathSandboxViolation(value: unknown, root: string): string | null {
  if (typeof value === "string") return !looksLikeUrl(value) && looksLikePath(value) && !isCandidatePathInsideRoot(value, root) ? value : null;
  if (Array.isArray(value)) { for (const item of value) { const violation = firstPathSandboxViolation(item, root); if (violation) return violation; } }
  if (isRecord(value)) { for (const [key, nested] of Object.entries(value)) { if (/command|script|prompt|content|message/i.test(key)) continue; const violation = firstPathSandboxViolation(nested, root); if (violation) return violation; } }
  return null;
}
function splitCommandLine(command: string): string[] { return (command.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? []).map((token) => token.replace(/^['"]|['"]$/g, "")); }
function looksLikePath(value: string): boolean { return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.startsWith("~") || value.includes("/../") || value.includes(path.sep); }
function looksLikeUrl(value: string): boolean { return /^[a-z][a-z0-9+.-]*:\/\//i.test(value); }
function isCandidatePathInsideRoot(candidate: string, root: string, cwd = root): boolean { if (candidate.startsWith("~")) return false; const base = path.resolve(cwd); const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(base, candidate); return isPathInside(path.resolve(root), resolved); }
async function nearestExistingParent(start: string): Promise<string> { let current = start; while (true) { try { const stat = await fs.stat(current); if (stat.isDirectory()) return current; } catch (error) { if (!isEnoent(error)) throw error; } const next = path.dirname(current); if (next === current) throw sandboxError(`No existing parent for ${start}.`); current = next; } }
function isPathInside(root: string, target: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function sandboxError(message: string): Error { const error = new Error(message) as NodeJS.ErrnoException; error.code = "EACCES"; return error; }
function isEnoent(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"; }
class AsyncEventQueue<T> implements AsyncIterable<T> { private readonly values: T[] = []; private readonly waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: Error) => void }> = []; private closed = false; private error: Error | null = null; push(value: T): void { if (this.closed) return; const waiter = this.waiters.shift(); if (waiter) { waiter.resolve({ value, done: false }); return; } this.values.push(value); } close(): void { this.closed = true; while (this.waiters.length > 0) this.waiters.shift()?.resolve({ value: undefined, done: true }); } fail(error: Error): void { this.error = error; this.closed = true; while (this.waiters.length > 0) this.waiters.shift()?.reject(error instanceof Error ? error : new Error(String(error))); } [Symbol.asyncIterator](): AsyncIterator<T> { return { next: () => { if (this.error) return Promise.reject(this.error); const value = this.values.shift(); if (value) return Promise.resolve({ value, done: false }); if (this.closed) return Promise.resolve({ value: undefined, done: true }); return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject })); } }; } }
function getProviderTextState(map: Map<string, ProviderTextState>, id: string): ProviderTextState {
  let state = map.get(id);
  if (!state) {
    state = { length: 0, tail: "" };
    map.set(id, state);
  }
  return state;
}
function appendCappedProviderText(state: ProviderTextState, next: string, limit = providerTextLimit): { appended: string; truncated: boolean } {
  if (!next) return { appended: "", truncated: false };
  const remaining = limit - state.length;
  if (remaining <= 0) return { appended: "", truncated: true };
  const cumulative = isCumulativeProviderText(state, next);
  const candidateStart = cumulative ? state.length : 0;
  const candidateLength = next.length - candidateStart;
  if (candidateLength <= 0) {
    if (cumulative) updateProviderTextState(state, "", next.length, copyStringRange(next, Math.max(0, next.length - providerTailLimit)));
    return { appended: "", truncated: false };
  }
  const truncated = candidateLength > remaining;
  const content = copyStringRange(next, candidateStart, candidateStart + Math.min(candidateLength, remaining));
  const appended = truncated ? `${content}${providerTruncationNotice}` : content;
  const nextLength = cumulative ? Math.min(next.length, limit) : Math.min(state.length + content.length, limit);
  updateProviderTextState(state, content, nextLength, cumulative ? copyStringRange(next, Math.max(0, next.length - providerTailLimit)) : undefined);
  return { appended, truncated };
}
const providerTailLimit = 4096;
function isCumulativeProviderText(state: ProviderTextState, next: string): boolean {
  if (state.length === 0 || next.length < state.length) return false;
  const overlapStart = Math.max(0, state.length - state.tail.length);
  return next.slice(overlapStart, state.length) === state.tail;
}
function updateProviderTextState(state: ProviderTextState, appended: string, length: number, cumulativeTail?: string): void {
  state.length = length;
  state.tail = cumulativeTail ?? copyStringRange(`${state.tail}${appended}`, Math.max(0, state.tail.length + appended.length - providerTailLimit));
}
function copyStringRange(value: string, start: number, end?: number): string { return Buffer.from(value.slice(start, end)).toString("utf8"); }
function truncateProviderString(value: string): string {
  if (value.length <= providerValueStringLimit) return value;
  return `${value.slice(0, providerValueStringLimit)}\n\n[truncated ${value.length - providerValueStringLimit} characters]`;
}
function limitProviderValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateProviderString(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "symbol";
  if (Array.isArray(value)) {
    const limited = value.slice(0, providerArrayLimit).map((entry) => limitProviderValue(entry, depth + 1));
    if (value.length > providerArrayLimit) limited.push(`[truncated ${value.length - providerArrayLimit} items]`);
    return limited;
  }
  if (!isRecord(value)) return null;
  if (depth >= providerDepthLimit) return "[truncated nested object]";
  const entries = Object.entries(value);
  const limited: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, providerObjectKeyLimit)) limited[key] = limitProviderValue(entry, depth + 1);
  if (entries.length > providerObjectKeyLimit) limited.__truncated = `${entries.length - providerObjectKeyLimit} fields omitted`;
  return limited;
}
function extractOpenAiDelta(payload: string): string | null { try { const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string }; text?: string }> }; return parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.text ?? null; } catch { return null; } }
function readNestedString(value: unknown, path: string[]): string | null { let cursor = value; for (const segment of path) { if (!isRecord(cursor)) return null; cursor = cursor[segment]; } return typeof cursor === "string" ? cursor : null; }
function readNestedNumber(value: unknown, path: string[]): number | null { let cursor = value; for (const segment of path) { if (!isRecord(cursor)) return null; cursor = cursor[segment]; } return typeof cursor === "number" ? cursor : null; }
function readNestedValue(value: unknown, path: string[]): unknown { let cursor = value; for (const segment of path) { if (!isRecord(cursor)) return null; cursor = cursor[segment]; } return cursor; }
function readFirstString(value: unknown, paths: string[][]): string | null { for (const path of paths) { const result = readNestedString(value, path); if (result) return result; } return null; }
function parseTaskListItems(markdown: string): ProviderTaskListItem[] {
  return markdown.split(/\r?\n/).map((line): ProviderTaskListItem | null => {
    const match = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (!match) return null;
    return { title: match[3]?.trim() || "Untitled task", completed: match[2]?.toLowerCase() === "x", depth: Math.floor((match[1] ?? "").replace(/\t/g, "  ").length / 2) };
  }).filter((item): item is ProviderTaskListItem => Boolean(item));
}
function readFirstStringByKey(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 5 || value === null || typeof value !== "object") return null;
  const normalizedKeys = keys.map((key) => key.toLowerCase());
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readFirstStringByKey(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (normalizedKeys.includes(key.toLowerCase()) && typeof nested === "string" && nested.trim()) return nested;
  }
  for (const nested of Object.values(value)) {
    const found = readFirstStringByKey(nested, keys, depth + 1);
    if (found) return found;
  }
  return null;
}
function compactRecord(input: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== "")); }
function eventId(value: unknown): string | null { return readFirstString(value, [["id"], ["toolCallId"], ["tool_call_id"], ["executionId"], ["execution_id"]]); }
function eventToolName(value: unknown): string { return readFirstString(value, [["toolName"], ["tool_name"], ["name"], ["tool", "name"], ["command"], ["server"]]) ?? "Tool"; }
function eventToolInput(value: unknown): unknown { return readNestedValue(value, ["input"]) ?? readNestedValue(value, ["arguments"]) ?? readNestedValue(value, ["args"]) ?? null; }
function eventToolOutput(value: unknown): unknown { return readNestedValue(value, ["output"]) ?? readNestedValue(value, ["result"]) ?? readNestedValue(value, ["data"]) ?? null; }
function eventToolError(value: unknown): string | null {
  const error = readNestedValue(value, ["error"]);
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return readFirstString(value, [["errorMessage"], ["error_message"]]);
}
function eventAgentId(event: SessionEvent): string | null { return typeof event.agentId === "string" && event.agentId ? event.agentId : null; }
function subagentEventId(event: SessionEvent): string { return eventAgentId(event) ?? readNestedString(event.data, ["toolCallId"]) ?? event.id; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function formatToolOutput(value: unknown): string { try { return JSON.stringify(value); } catch { return String(value); } }
function summarizeInline(value?: string | null): string { const normalized = value?.replace(/\s+/g, " ").trim() ?? ""; return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized; }
function normalizeConversationTitle(value: string): string { return value.replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`]+$/g, "").split(" ").filter(Boolean).slice(0, 6).join(" "); }
function suggestConversationTitle(value: string): string { return normalizeConversationTitle(value.replace(/^(please\s+)?(title|rename)\s+(this\s+)?(conversation|chat)\s*(about|to)?\s*/i, "")); }
function chunkText(text: string, size: number): string[] { const chunks: string[] = []; for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size)); return chunks; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function sdkFailureDetails(error: unknown, options: ProviderFactoryOptions): string {
  const message = error instanceof Error ? error.message : String(error);
  const detectedCli = options.sdkCliPath ? ` Detected Copilot CLI: ${options.sdkCliPath}.` : " No copilot executable was found on PATH.";
  const authHint = /auth/i.test(message)
    ? " No usable Copilot auth was found. Run `copilot login` or `gh auth login` in the same terminal that starts the app, or set `COPILOT_GITHUB_TOKEN`, then restart `pnpm dev`."
    : "";
  return `Copilot SDK model discovery failed: ${message}.${detectedCli}${authHint}`;
}

function mapModelInfo(model: ModelInfo): ProviderStatus["models"][number] {
  return {
    id: model.id,
    name: model.name || model.id,
    supportsReasoningEffort: Boolean(model.capabilities?.supports?.reasoningEffort),
    supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
    defaultReasoningEffort: model.defaultReasoningEffort,
    contextWindowTokens: positiveTokenLimit(model.capabilities?.limits?.max_context_window_tokens),
    maxPromptTokens: positiveTokenLimit(model.capabilities?.limits?.max_prompt_tokens),
  };
}
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); });
  });
}

function fallbackModels(defaultModel: string): ProviderStatus["models"] {
  const catalog: ProviderStatus["models"] = [
    { id: defaultModel, name: defaultModel, supportsReasoningEffort: true, supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium", contextWindowTokens: 128000, maxPromptTokens: 128000 },
    { id: "gpt-5-mini", name: "GPT-5 mini", supportsReasoningEffort: true, supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium", contextWindowTokens: 128000, maxPromptTokens: 128000 },
    { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", supportsReasoningEffort: true, supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium", contextWindowTokens: 200000, maxPromptTokens: 168000 },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", supportsReasoningEffort: true, supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium", contextWindowTokens: 200000, maxPromptTokens: 168000 },
  ];
  return Array.from(new Map(catalog.map((model) => [model.id, model])).values());
}

function positiveTokenLimit(value: number | undefined): number | undefined {
  return value && value > 0 ? value : undefined;
}

function sdkReasoningEffort(effort: ProviderChatRequest["reasoningEffort"]): "low" | "medium" | "high" | "xhigh" | undefined {
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") return effort;
  if (effort === "max") return "xhigh";
  return undefined;
}
