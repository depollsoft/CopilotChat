import fs from "node:fs/promises";
import path from "node:path";
import type { CopilotProvider, ProviderChatControls, ProviderChatRequest, ProviderElicitationRequest, ProviderElicitationValue, ProviderEvent, ProviderMessage, ProviderPermissionRequest, ProviderTaskListItem, ProviderUserInputRequest } from "@copilotchat/provider";
import { titleFromContent } from "@copilotchat/shared";
import type { ActiveResponseInputRequest, Chat, ChatMessage, PermissionMode, SendMessageRequest } from "@copilotchat/shared";
import type { FastifyReply } from "fastify";
import { syncArtifactFiles, writeFileArtifact } from "./artifact-files.js";
import { forgetValidatedAttachmentFiles } from "./attachment-files.js";
import type { AppDatabase } from "./db.js";

type StreamListener = {
  reply: FastifyReply;
  queue: StreamEvent[];
  draining: boolean;
};
type StreamEvent = { event: string; data: unknown };
type ActiveTurn = { chat: Chat; userMessage: ChatMessage; providerRequest: ProviderChatRequest };
export type InternalSendMessageRequest = SendMessageRequest & { uploadClaimId?: string };
type InternalActiveResponseInputRequest = ActiveResponseInputRequest & { uploadClaimId?: string };
type ResponseCleanup = { id: string; run: () => Promise<void> };
type ResponseResources = { temporaryFiles?: string[]; cleanup?: ResponseCleanup };
type PendingTurn = {
  id: string;
  mode: "steer" | "queue";
  content: string;
  status: "queued" | "sent" | "running" | "done" | "failed";
  createdAt: string;
};
type QueuedTurn = PendingTurn & { request: InternalSendMessageRequest };
type PendingInteraction = {
  id: string;
  kind: "permission" | "user-input" | "elicitation";
  title: string;
  message: string;
  choices?: string[];
  allowFreeform?: boolean;
  request?: unknown;
  requestedSchema?: unknown;
};
type InteractionResolution = { action: string; answer?: string; wasFreeform?: boolean; content?: unknown };
type InteractionResolver = { resolve: (resolution: InteractionResolution) => void; cancel: () => void };
type AssistantActivity = {
  id: string;
  type: "reasoning" | "tool" | "subagent" | "task-list";
  title: string;
  status: "running" | "succeeded" | "failed";
  content?: string;
  items?: ProviderTaskListItem[];
  input?: unknown;
  output?: unknown;
  error?: string | null;
  details?: Record<string, unknown>;
  steps?: AssistantActivity[];
};
const activityStringLimit = 20_000;
const activityArrayLimit = 80;
const activityObjectKeyLimit = 80;
const activityDepthLimit = 5;
const assistantContentLimit = 1_000_000;
const persistedMetadataLimit = 950_000;
const persistedActivityStringLimit = 8_000;
const persistedNestedStepLimit = 24;
const sseBackpressureLimit = 256 * 1024;
const coalescedSseEvents = new Set(["activity", "snapshot", "pending", "interaction"]);

export class ActiveChatResponses {
  private readonly active = new Map<string, ActiveChatResponse>();

  has(chatId: string): boolean { return this.active.has(chatId); }
  chatIds(): string[] { return [...this.active.keys()]; }

  start(input: { db: AppDatabase; provider: CopilotProvider; ownerId: string; chat: Chat; userMessage: ChatMessage; providerRequest: ProviderChatRequest; prepareTurn: (request: InternalSendMessageRequest) => Promise<ActiveTurn> }): ActiveChatResponse {
    const existing = this.active.get(input.chat.id);
    if (existing) return existing;
    const response = new ActiveChatResponse(input.chat.id);
    this.active.set(input.chat.id, response);
    const providerRequest = response.decorateProviderRequest(input.providerRequest);
    void Promise.resolve().then(() => this.run(response, { ...input, providerRequest }));
    return response;
  }

  attach(chatId: string, reply: FastifyReply): void {
    reply.hijack();
    writeSseHeaders(reply);
    const response = this.active.get(chatId);
    if (!response) {
      writeSse(reply, "done", { ok: true, active: false });
      reply.raw.end();
      return;
    }
    response.attach(reply);
  }

  cancel(chatId: string): boolean {
    const response = this.active.get(chatId);
    if (!response) return false;
    response.cancel();
    response.close();
    this.active.delete(chatId);
    return true;
  }

  cancelAll(): void {
    for (const chatId of [...this.active.keys()]) this.cancel(chatId);
  }

  resolveInteraction(chatId: string, interactionId: string, resolution: InteractionResolution): boolean {
    const response = this.active.get(chatId);
    if (!response) return false;
    return response.resolveInteraction(interactionId, resolution);
  }

  enqueue(chatId: string, request: InternalActiveResponseInputRequest, resources?: ResponseResources): PendingTurn | null {
    const response = this.active.get(chatId);
    if (!response || !response.trackResources(resources)) return null;
    return response.enqueue(request);
  }
  setPermissionMode(chatId: string, permissionMode: PermissionMode): boolean {
    const response = this.active.get(chatId);
    if (!response) return false;
    response.setPermissionMode(permissionMode);
    return true;
  }

  async steer(chatId: string, request: InternalActiveResponseInputRequest, resources?: ResponseResources): Promise<{ turn: PendingTurn | null; delivered: boolean } | null> {
    const response = this.active.get(chatId);
    return response ? await response.steer(request, resources) : null;
  }

  trackTemporaryFiles(chatId: string, filePaths: string[]): boolean {
    const response = this.active.get(chatId);
    if (!response) return false;
    return response.trackTemporaryFiles(filePaths);
  }

  private async run(response: ActiveChatResponse, input: { db: AppDatabase; provider: CopilotProvider; ownerId: string; chat: Chat; userMessage: ChatMessage; providerRequest: ProviderChatRequest; prepareTurn: (request: InternalSendMessageRequest) => Promise<ActiveTurn> }): Promise<void> {
    let turn: ActiveTurn = { chat: input.chat, userMessage: input.userMessage, providerRequest: input.providerRequest };
    let terminal: { event: "done" | "error"; data: Record<string, unknown> };
    try {
      while (!response.cancelled) {
        turn = await this.runTurn(response, input, turn);
        const next = response.nextQueued();
        if (!next) break;
        response.markPendingRunning(next.id);
        turn = await input.prepareTurn(next.request);
      }
      terminal = { event: "done", data: response.cancelled ? { ok: false, cancelled: true } : { ok: true } };
    } catch (error) {
      terminal = response.cancelled ? { event: "done", data: { ok: false, cancelled: true } } : { event: "error", data: { message: (error as Error).message } };
    }
    if (this.active.get(input.chat.id) === response) this.active.delete(input.chat.id);
    try {
      await response.cleanupResources();
    } catch (error) {
      terminal = { event: "error", data: { message: `Could not clean temporary attachments: ${(error as Error).message}` } };
    }
    response.emit(terminal.event, terminal.data);
    response.close();
  }

  private async runTurn(response: ActiveChatResponse, input: { db: AppDatabase; provider: CopilotProvider; ownerId: string }, turn: ActiveTurn): Promise<ActiveTurn> {
    let chat = turn.chat;
    response.resetStreamingTurn();
    const workspaceDir = turn.providerRequest.workingDirectory ?? null;
    const providerRequest = response.decorateProviderRequest(turn.providerRequest);
    for await (const event of input.provider.streamChat({ ...providerRequest, abortSignal: response.signal })) {
      if (response.cancelled) break;
      if (event.type === "delta") { const text = response.appendAssistantContent(event.text); if (text) response.emit("delta", { ...event, text }); if (response.assistantContentLimitReached) break; continue; }
      if (event.type === "reasoning-delta") { response.appendReasoning(event.text); response.emit("activity", { activities: response.activities }); continue; }
      if (event.type === "reasoning") { response.setReasoning(event.text); response.emit("activity", { activities: response.activities }); continue; }
      if (event.type === "tool-call") { if (isHiddenTool(event.toolName)) continue; response.startTool(event); response.emit("activity", { activities: response.activities }); continue; }
      if (event.type === "tool-result") { if (isHiddenToolResult(event)) { response.removeTool(event); response.emit("activity", { activities: response.activities }); continue; } response.finishTool(event); response.emit("activity", { activities: response.activities }); continue; }
      if (event.type === "subagent-start") { response.startSubagent(event); response.emit("activity", { activities: response.activities }); continue; }
      if (event.type === "subagent-delta") { response.appendSubagentContent(event.id, event.text); response.emit("activity", { activities: response.activities }); continue; }
      if (event.type === "subagent-reasoning-delta") { response.appendSubagentReasoning(event.id, event.text); response.emit("activity", { activities: response.activities }); continue; }
      if (event.type === "subagent-tool-call") { response.startSubagentTool(event); response.emit("activity", { activities: response.activities }); continue; }
      if (event.type === "subagent-tool-result") { response.finishSubagentTool(event); response.emit("activity", { activities: response.activities }); continue; }
      if (event.type === "subagent-complete" || event.type === "subagent-failed") { response.finishSubagent(event); response.emit("activity", { activities: response.activities }); continue; }
      if (event.type === "task-list") { response.setTaskList(event); response.emit("activity", { activities: response.activities }); continue; }
      if (event.type === "session") chat = input.db.setChatProviderSession(input.ownerId, chat.id, { providerSessionId: event.sessionId, providerSessionWorkspacePath: event.workspacePath });
      if (event.type === "artifact") {
        const artifact = workspaceDir
          ? (await writeFileArtifact({ db: input.db, ownerId: input.ownerId, chat, messageId: turn.userMessage.id, workspaceDir, artifact: { title: event.title, kind: normalizeArtifactKind(event.kind), language: event.language ?? null, content: event.content } })).artifact
          : input.db.createArtifact(input.ownerId, { chatId: chat.id, projectId: chat.projectId, messageId: turn.userMessage.id, title: event.title, kind: normalizeArtifactKind(event.kind), language: event.language ?? null, content: event.content });
        response.emit("artifact", artifact);
      }
      if (event.type !== "done") response.emit(event.type, event);
    }
    await response.ensureRequiredTitle(providerRequest, turn.userMessage.content);
    if (workspaceDir) await syncArtifactFiles({ db: input.db, ownerId: input.ownerId, chat, workspaceDir });
    response.finishOpenActivities();
    if (!response.cancelled) {
      const assistant = input.db.addMessage({ chatId: chat.id, role: "assistant", content: response.assistantContent, provider: input.provider.id, metadata: messageMetadataForActivities(response.activities) });
      response.finishRunningPendingTurn();
      response.emit("message", assistant);
    }
    return { chat, userMessage: turn.userMessage, providerRequest: { ...turn.providerRequest, sessionId: chat.providerSessionId ?? turn.providerRequest.sessionId, resumeSession: Boolean(chat.providerSessionId) } };
  }
}

export class ActiveChatResponse {
  readonly controller = new AbortController();
  readonly listeners = new Set<StreamListener>();
  private readonly temporaryFiles = new Set<string>();
  private readonly cleanupTasks = new Map<string, () => Promise<void>>();
  private readonly inFlightSteers = new Set<Promise<void>>();
  private finalizing = false;
  assistantContent = "";
  activities: AssistantActivity[] = [];
  interactions: PendingInteraction[] = [];
  pendingTurns: PendingTurn[] = [];
  cancelled = false;
  assistantContentLimitReached = false;
  private activityIndex = 0;
  private interactionIndex = 0;
  private pendingTurnIndex = 0;
  private titleWasSet = false;
  private readonly interactionResolvers = new Map<string, InteractionResolver>();
  private readonly queuedTurns: QueuedTurn[] = [];
  private steerHandler: ((message: ProviderMessage) => void | Promise<void>) | null = null;
  private permissionModeOverride: PermissionMode | null = null;

  constructor(readonly chatId: string) {}
  get signal(): AbortSignal { return this.controller.signal; }

  attach(reply: FastifyReply): void {
    const listener: StreamListener = { reply, queue: [], draining: false };
    this.listeners.add(listener);
    reply.raw.on("close", () => this.listeners.delete(listener));
    if (this.assistantContent || this.activities.length > 0 || this.interactions.length > 0 || this.pendingTurns.length > 0) this.send(listener, "snapshot", { text: this.assistantContent, activities: this.activities, interactions: this.interactions, pendingTurns: this.pendingTurns });
  }

  decorateProviderRequest(request: ProviderChatRequest): ProviderChatRequest {
    this.permissionModeOverride = request.permissionMode ?? "ask";
    return { ...request, titleTool: this.wrapTitleTool(request.titleTool), interactions: this.createInteractions(), controls: this.createControls() };
  }

  wrapTitleTool(titleTool: ProviderChatRequest["titleTool"]): ProviderChatRequest["titleTool"] {
    if (!titleTool) return undefined;
    return { ...titleTool, setTitle: async (title) => { const saved = await titleTool.setTitle(title); this.titleWasSet = true; return saved; } };
  }

  async ensureRequiredTitle(request: ProviderChatRequest, content: string): Promise<void> {
    if (!request.titleTool?.required || this.titleWasSet || this.cancelled) return;
    const fallback = titleFromContent(content);
    if (fallback) await request.titleTool.setTitle(fallback);
  }

  resetStreamingTurn(): void {
    this.assistantContent = "";
    this.assistantContentLimitReached = false;
    this.activities = [];
    this.interactions = [];
    this.emit("snapshot", { text: "", activities: [], interactions: this.interactions, pendingTurns: this.pendingTurns });
  }

  appendAssistantContent(text: string): string {
    if (this.assistantContentLimitReached) return "";
    const next = appendPossiblyCumulativeText(this.assistantContent, text);
    if (next.value.length <= assistantContentLimit) {
      this.assistantContent = next.value;
      return next.appended;
    }
    const suffix = "\n\n[Response truncated because it exceeded the local display limit. Ask for a narrower summary or a saved artifact for more detail.]";
    const limitedValue = `${next.value.slice(0, assistantContentLimit)}${suffix}`;
    const appended = limitedValue.startsWith(this.assistantContent) ? limitedValue.slice(this.assistantContent.length) : suffix;
    this.assistantContent = limitedValue;
    this.assistantContentLimitReached = true;
    return appended;
  }

  enqueue(request: InternalActiveResponseInputRequest): PendingTurn {
    const turn = this.createPendingTurn("queue", request.content);
    this.pendingTurns = [...this.pendingTurns, turn];
    this.queuedTurns.push({ ...turn, request: queueRequest(request) });
    this.emitPendingTurns();
    return turn;
  }

  async steer(request: InternalActiveResponseInputRequest, resources?: ResponseResources): Promise<{ turn: PendingTurn | null; delivered: boolean } | null> {
    const steerHandler = this.steerHandler;
    if (!steerHandler) return { turn: null, delivered: false };
    if (!this.trackResources(resources)) return null;
    const turn = this.createPendingTurn("steer", request.content, "sent");
    this.pendingTurns = [...this.pendingTurns, turn];
    const delivery = (async () => {
      try {
        await steerHandler(providerMessageForActiveInput(request));
      } catch (error) {
        this.pendingTurns = this.pendingTurns.filter((pending) => pending.id !== turn.id);
        this.untrackResources(resources);
        this.emitPendingTurns();
        throw error;
      }
    })();
    this.inFlightSteers.add(delivery);
    try {
      await delivery;
    } finally {
      this.inFlightSteers.delete(delivery);
    }
    this.emitPendingTurns();
    return { turn, delivered: true };
  }

  nextQueued(): QueuedTurn | null {
    const next = this.queuedTurns.shift() ?? null;
    if (!next) return null;
    this.pendingTurns = this.pendingTurns.map((turn) => turn.id === next.id ? { ...turn, status: "running" } : turn);
    this.emitPendingTurns();
    return next;
  }

  markPendingRunning(id: string): void {
    this.pendingTurns = this.pendingTurns.map((turn) => turn.id === id ? { ...turn, status: "running" } : turn);
    this.emitPendingTurns();
  }

  finishRunningPendingTurn(): void {
    const next = this.pendingTurns.map((turn) => turn.status === "running" ? { ...turn, status: "done" as const } : turn);
    if (next !== this.pendingTurns) {
      this.pendingTurns = next;
      this.emitPendingTurns();
    }
  }

  setPermissionMode(permissionMode: PermissionMode): void {
    this.permissionModeOverride = permissionMode;
    if (permissionMode !== "yolo") return;
    const pendingPermissionIds = this.interactions.filter((interaction) => interaction.kind === "permission").map((interaction) => interaction.id);
    for (const id of pendingPermissionIds) {
      const resolver = this.interactionResolvers.get(id);
      if (!resolver) continue;
      this.interactionResolvers.delete(id);
      resolver.resolve({ action: "approve" });
    }
    if (pendingPermissionIds.length > 0) {
      const pending = new Set(pendingPermissionIds);
      this.interactions = this.interactions.filter((interaction) => !pending.has(interaction.id));
      this.emit("interaction", { interactions: this.interactions });
    }
  }

  createInteractions(): ProviderChatRequest["interactions"] {
    return {
      requestPermission: async (request) => {
        if (this.permissionModeOverride === "yolo") return "approve";
        return await this.requestPermission(request);
      },
      requestUserInput: (request) => this.requestUserInput(request),
      requestElicitation: (request) => this.requestElicitation(request),
    };
  }

  createControls(): ProviderChatControls {
    return {
      onSteer: (handler) => {
        this.steerHandler = handler;
        return () => { if (this.steerHandler === handler) this.steerHandler = null; };
      },
    };
  }

  resolveInteraction(id: string, resolution: InteractionResolution): boolean {
    const resolver = this.interactionResolvers.get(id);
    if (!resolver) return false;
    this.interactionResolvers.delete(id);
    this.interactions = this.interactions.filter((interaction) => interaction.id !== id);
    resolver.resolve(resolution);
    this.emit("interaction", { interactions: this.interactions });
    return true;
  }

  appendReasoning(text: string): void {
    const activity = [...this.activities].reverse().find((item) => item.type === "reasoning" && item.status === "running");
    if (activity) activity.content = appendActivityText(activity.content, text);
    else this.activities.push({ id: this.nextActivityId("reasoning"), type: "reasoning", title: "Thinking", status: "running", content: text });
  }

  setReasoning(text: string): void {
    const activity = [...this.activities].reverse().find((item) => item.type === "reasoning" && item.status === "running");
    if (activity) { activity.content = text; activity.status = "succeeded"; }
    else this.activities.push({ id: this.nextActivityId("reasoning"), type: "reasoning", title: "Thinking", status: "succeeded", content: text });
  }

  setTaskList(event: Extract<ProviderEvent, { type: "task-list" }>): void {
    const id = event.id ?? "task-list";
    const existing = this.activities.find((activity) => activity.type === "task-list" && activity.id === id);
    const activity: AssistantActivity = { id, type: "task-list", title: event.title, status: "succeeded", content: event.content ? truncateActivityString(event.content) : undefined, items: event.items, details: event.source ? { source: event.source } : undefined };
    if (existing) Object.assign(existing, activity);
    else this.activities.push(activity);
  }

  startTool(event: Extract<ProviderEvent, { type: "tool-call" }>): void {
    const id = event.id ?? this.nextActivityId("tool");
    this.activities.push({ id, type: "tool", title: event.toolName, status: "running", input: limitActivityValue(event.input) });
  }

  finishTool(event: Extract<ProviderEvent, { type: "tool-result" }>): void {
    const activity = this.findToolActivity(event.id, event.toolName);
    if (activity) {
      activity.status = event.status;
      activity.output = limitActivityValue(event.output);
      activity.error = event.error ? truncateActivityString(event.error) : null;
      return;
    }
    this.activities.push({ id: event.id ?? this.nextActivityId("tool"), type: "tool", title: event.toolName, status: event.status, output: limitActivityValue(event.output), error: event.error ? truncateActivityString(event.error) : null });
  }

  removeTool(event: Extract<ProviderEvent, { type: "tool-result" }>): void {
    const activity = this.findToolActivity(event.id, event.toolName);
    if (activity) this.activities = this.activities.filter((item) => item !== activity);
  }

  finishOpenActivities(): void {
    finishActivities(this.activities);
  }

  emit(event: string, data: unknown): void {
    for (const listener of [...this.listeners]) this.send(listener, event, data);
  }

  private send(listener: StreamListener, event: string, data: unknown): void {
    if (listener.draining || listener.reply.raw.writableNeedDrain || listener.reply.raw.writableLength > sseBackpressureLimit) {
      this.bufferStreamEvent(listener, event, data);
      if (!listener.draining) this.waitForDrain(listener);
      return;
    }
    try {
      const accepted = writeSse(listener.reply, event, data);
      if (!accepted) this.waitForDrain(listener);
    } catch {
      this.listeners.delete(listener);
    }
  }

  private bufferStreamEvent(listener: StreamListener, event: string, data: unknown): void {
    const bufferedEvent: StreamEvent = { event, data };
    if (coalescedSseEvents.has(event)) {
      const existing = listener.queue.findIndex((entry) => entry.event === event);
      if (existing >= 0) listener.queue[existing] = bufferedEvent;
      else listener.queue.push(bufferedEvent);
      return;
    }
    listener.queue.push(bufferedEvent);
  }

  private waitForDrain(listener: StreamListener): void {
    if (listener.draining) return;
    listener.draining = true;
    listener.reply.raw.once("drain", () => {
      listener.draining = false;
      this.flushListener(listener);
    });
  }

  private flushListener(listener: StreamListener): void {
    while (listener.queue.length > 0 && !listener.reply.raw.writableNeedDrain && listener.reply.raw.writableLength <= sseBackpressureLimit) {
      const next = listener.queue.shift();
      if (!next) return;
      try {
        const accepted = writeSse(listener.reply, next.event, next.data);
        if (!accepted) {
          this.waitForDrain(listener);
          return;
        }
      } catch {
        this.listeners.delete(listener);
        return;
      }
    }
    if (listener.queue.length > 0) this.waitForDrain(listener);
  }

  cancel(): void {
    this.cancelled = true;
    this.cancelInteractions();
    this.controller.abort();
  }

  close(): void {
    for (const listener of [...this.listeners]) {
      try { listener.reply.raw.end(); } catch { /* already closed */ }
    }
    this.listeners.clear();
  }

  trackResources(resources?: ResponseResources): boolean {
    if (this.finalizing) return false;
    if (resources?.cleanup) this.cleanupTasks.set(resources.cleanup.id, resources.cleanup.run);
    if (resources?.temporaryFiles) for (const filePath of resources.temporaryFiles) this.temporaryFiles.add(filePath);
    return true;
  }

  untrackResources(resources?: ResponseResources): void {
    if (resources?.cleanup) this.cleanupTasks.delete(resources.cleanup.id);
    if (resources?.temporaryFiles) for (const filePath of resources.temporaryFiles) this.temporaryFiles.delete(filePath);
  }

  trackTemporaryFiles(filePaths: string[]): boolean {
    if (this.finalizing) return false;
    for (const filePath of filePaths) this.temporaryFiles.add(filePath);
    return true;
  }

  async cleanupTemporaryFiles(): Promise<void> {
    const filePaths = [...this.temporaryFiles];
    this.temporaryFiles.clear();
    forgetValidatedAttachmentFiles(filePaths);
    const errors: unknown[] = [];
    for (const filePath of filePaths) {
      try {
        await fs.rm(filePath, { force: true });
        await fs.rmdir(path.dirname(filePath)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Temporary attachment cleanup failed.");
  }

  async cleanupResources(): Promise<void> {
    this.finalizing = true;
    await Promise.allSettled([...this.inFlightSteers]);
    const errors: unknown[] = [];
    try {
      await this.cleanupTemporaryFiles();
    } catch (error) {
      errors.push(error);
    }
    const tasks = [...this.cleanupTasks.values()];
    this.cleanupTasks.clear();
    for (const task of tasks) {
      try {
        await task();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Active response resource cleanup failed.");
  }

  private findToolActivity(id: string | null | undefined, toolName: string): AssistantActivity | undefined {
    if (id) {
      const byId = this.activities.find((activity) => activity.type === "tool" && activity.id === id);
      if (byId) return byId;
    }
    return [...this.activities].reverse().find((activity) => activity.type === "tool" && activity.title === toolName && activity.status === "running");
  }

  startSubagent(event: Extract<ProviderEvent, { type: "subagent-start" }>): void {
    const activity = this.ensureSubagent(event.id, event.displayName);
    activity.title = event.displayName;
    activity.status = "running";
    activity.details = limitActivityRecord(compactRecord({ name: event.name, description: event.description, model: event.model, toolCallId: event.toolCallId }));
  }

  appendSubagentContent(id: string, text: string): void {
    const activity = this.ensureSubagent(id);
    activity.content = appendActivityText(activity.content, text);
  }

  appendSubagentReasoning(id: string, text: string): void {
    const activity = this.ensureSubagent(id);
    const steps = activity.steps ??= [];
    const reasoning = [...steps].reverse().find((step) => step.type === "reasoning" && step.status === "running");
    if (reasoning) reasoning.content = appendActivityText(reasoning.content, text);
    else steps.push({ id: `${id}-reasoning-${steps.length + 1}`, type: "reasoning", title: "Thinking", status: "running", content: truncateActivityString(text) });
  }

  startSubagentTool(event: Extract<ProviderEvent, { type: "subagent-tool-call" }>): void {
    const activity = this.ensureSubagent(event.id);
    const steps = activity.steps ??= [];
    steps.push({ id: event.toolCallId ?? `${event.id}-tool-${steps.length + 1}`, type: "tool", title: event.toolName, status: "running", input: limitActivityValue(event.input) });
  }

  finishSubagentTool(event: Extract<ProviderEvent, { type: "subagent-tool-result" }>): void {
    const activity = this.ensureSubagent(event.id);
    const steps = activity.steps ??= [];
    const tool = findToolStep(steps, event.toolCallId, event.toolName);
    if (tool) {
      tool.status = event.status;
      tool.output = limitActivityValue(event.output);
      tool.error = event.error ? truncateActivityString(event.error) : null;
      return;
    }
    steps.push({ id: event.toolCallId ?? `${event.id}-tool-${steps.length + 1}`, type: "tool", title: event.toolName, status: event.status, output: limitActivityValue(event.output), error: event.error ? truncateActivityString(event.error) : null });
  }

  finishSubagent(event: Extract<ProviderEvent, { type: "subagent-complete" | "subagent-failed" }>): void {
    const activity = this.ensureSubagent(event.id, event.displayName);
    activity.title = event.displayName;
    activity.status = event.type === "subagent-failed" ? "failed" : "succeeded";
    activity.error = event.type === "subagent-failed" ? truncateActivityString(event.error) : null;
    activity.details = limitActivityRecord({ ...(activity.details ?? {}), ...compactRecord({ name: event.name, model: event.model, durationMs: event.durationMs, totalTokens: event.totalTokens, totalToolCalls: event.totalToolCalls }) });
    finishActivities(activity.steps ?? []);
  }

  private ensureSubagent(id: string, title = "Subagent"): AssistantActivity {
    const existing = this.activities.find((activity) => activity.type === "subagent" && activity.id === id);
    if (existing) return existing;
    const activity: AssistantActivity = { id, type: "subagent", title, status: "running", steps: [] };
    this.activities.push(activity);
    return activity;
  }

  private createPendingTurn(mode: PendingTurn["mode"], content: string, status: PendingTurn["status"] = "queued"): PendingTurn {
    this.pendingTurnIndex += 1;
    return { id: `${mode}-${Date.now()}-${this.pendingTurnIndex}`, mode, content, status, createdAt: new Date().toISOString() };
  }

  private emitPendingTurns(): void {
    this.emit("pending", { pendingTurns: this.pendingTurns });
  }

  private nextActivityId(prefix: string): string { this.activityIndex += 1; return `${prefix}-${this.activityIndex}`; }
  private nextInteractionId(prefix: string): string { this.interactionIndex += 1; return `${prefix}-${Date.now()}-${this.interactionIndex}`; }
  private requestPermission(request: ProviderPermissionRequest): Promise<"approve" | "deny"> {
    const id = this.nextInteractionId("permission");
    const interaction: PendingInteraction = { id, kind: "permission", title: `Allow ${permissionKindLabel(request.kind)} permission?`, message: permissionRequestMessage(request), request };
    return new Promise((resolve) => this.addInteraction(interaction, {
      resolve: (resolution) => resolve(resolution.action === "approve" ? "approve" : "deny"),
      cancel: () => resolve("deny"),
    }));
  }
  private requestUserInput(request: ProviderUserInputRequest): Promise<{ answer: string; wasFreeform: boolean }> {
    const id = this.nextInteractionId("question");
    const interaction: PendingInteraction = { id, kind: "user-input", title: "Agent question", message: request.question, choices: request.choices, allowFreeform: request.allowFreeform, request };
    return new Promise((resolve) => this.addInteraction(interaction, {
      resolve: (resolution) => resolve({ answer: resolution.answer ?? "", wasFreeform: Boolean(resolution.wasFreeform) }),
      cancel: () => resolve({ answer: "", wasFreeform: true }),
    }));
  }
  private requestElicitation(request: ProviderElicitationRequest): Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, ProviderElicitationValue> }> {
    const id = this.nextInteractionId("elicitation");
    const interaction: PendingInteraction = { id, kind: "elicitation", title: request.elicitationSource ? `Input for ${request.elicitationSource}` : "Agent needs input", message: request.message, request, requestedSchema: request.requestedSchema };
    return new Promise((resolve) => this.addInteraction(interaction, {
      resolve: (resolution) => resolve({ action: resolution.action === "accept" || resolution.action === "decline" || resolution.action === "cancel" ? resolution.action : "cancel", content: toElicitationContent(resolution.content) }),
      cancel: () => resolve({ action: "cancel" }),
    }));
  }
  private addInteraction(interaction: PendingInteraction, resolver: InteractionResolver): void {
    this.interactions = [...this.interactions, interaction];
    this.interactionResolvers.set(interaction.id, resolver);
    this.emit("interaction", { interactions: this.interactions });
  }
  private cancelInteractions(): void {
    for (const resolver of this.interactionResolvers.values()) resolver.cancel();
    this.interactionResolvers.clear();
    this.interactions = [];
    this.emit("interaction", { interactions: this.interactions });
  }
}

function toElicitationContent(value: unknown): Record<string, ProviderElicitationValue> {
  if (!isRecord(value)) return {};
  const result: Record<string, ProviderElicitationValue> = {};
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") result[key] = entry;
  return result;
}
function permissionKindLabel(kind: string): string { return kind === "url" ? "URL" : kind.replace(/[-_]/g, " "); }
function permissionRequestMessage(request: ProviderPermissionRequest): string {
  if (request.url) return `The agent wants to access ${request.url}.`;
  if (request.fullCommandText) return "The agent wants to run a shell command.";
  if (request.fileName) return `The agent wants to ${request.kind === "read" ? "read" : request.kind === "write" ? "edit" : "access"} ${request.fileName}.`;
  if (request.toolName) return `The agent wants to use ${request.toolName}.`;
  return `The agent wants to use ${request.kind}.`;
}
function finishActivities(activities: AssistantActivity[]): void {
  for (const activity of activities) {
    if (activity.status === "running") activity.status = "succeeded";
    if (activity.steps) finishActivities(activity.steps);
  }
}
function messageMetadataForActivities(activities: AssistantActivity[]): Record<string, unknown> {
  if (activities.length === 0) return {};
  let stringLimit = persistedActivityStringLimit;
  let stepLimit = persistedNestedStepLimit;
  while (true) {
    const metadata = { activities: limitActivitiesForPersistence(activities, stringLimit, stepLimit, false) };
    if (JSON.stringify(metadata).length <= persistedMetadataLimit || (stringLimit <= 1_000 && stepLimit <= 8)) return metadata;
    if (stepLimit > 8) stepLimit = Math.max(8, Math.floor(stepLimit * 0.7));
    else stringLimit = Math.max(1_000, Math.floor(stringLimit * 0.6));
  }
}
function limitActivitiesForPersistence(activities: AssistantActivity[], stringLimit: number, stepLimit: number, nested: boolean): AssistantActivity[] {
  const limited = activities.map((activity) => limitActivityForPersistence(activity, stringLimit, stepLimit));
  if (!nested || limited.length <= stepLimit) return limited;
  const headCount = Math.floor((stepLimit - 1) / 2);
  const tailCount = Math.max(0, stepLimit - 1 - headCount);
  return [
    ...limited.slice(0, headCount),
    { id: `omitted-${limited.length - stepLimit + 1}`, type: "reasoning", title: "Omitted steps", status: "succeeded", content: `${limited.length - stepLimit + 1} intermediate steps omitted from saved history.` },
    ...limited.slice(limited.length - tailCount),
  ];
}
function limitActivityForPersistence(activity: AssistantActivity, stringLimit: number, stepLimit: number): AssistantActivity {
  return {
    ...activity,
    content: activity.content === undefined ? undefined : truncateActivityString(activity.content, stringLimit),
    input: activity.input === undefined ? undefined : limitActivityValue(activity.input, 0, stringLimit),
    output: activity.output === undefined ? undefined : limitActivityValue(activity.output, 0, stringLimit),
    error: activity.error === undefined || activity.error === null ? activity.error : truncateActivityString(activity.error, stringLimit),
    details: activity.details === undefined ? undefined : limitActivityValue(activity.details, 0, stringLimit) as Record<string, unknown>,
    steps: activity.steps ? limitActivitiesForPersistence(activity.steps, stringLimit, stepLimit, true) : undefined,
  };
}
function isHiddenTool(toolName: string): boolean { return toolName === "set_conversation_title"; }
function isHiddenToolResult(event: Extract<ProviderEvent, { type: "tool-result" }>): boolean {
  return isHiddenTool(event.toolName) || (event.toolName === "Tool" && isTitleToolOutput(event.output));
}
function isTitleToolOutput(output: unknown): boolean {
  const payload = typeof output === "string" ? parseJsonObject(output) : isRecord(output) ? output : null;
  if (!payload) return false;
  if (isTitlePayload(payload)) return true;
  const content = typeof payload.content === "string" ? parseJsonObject(payload.content) : null;
  const detailedContent = typeof payload.detailedContent === "string" ? parseJsonObject(payload.detailedContent) : null;
  return Boolean((content && isTitlePayload(content)) || (detailedContent && isTitlePayload(detailedContent)));
}
function isTitlePayload(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "title" && typeof value.title === "string" && value.title.trim().length > 0;
}
function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function findToolStep(steps: AssistantActivity[], id: string | null | undefined, toolName: string): AssistantActivity | undefined {
  if (id) {
    const byId = steps.find((activity) => activity.type === "tool" && activity.id === id);
    if (byId) return byId;
  }
  return [...steps].reverse().find((activity) => activity.type === "tool" && activity.title === toolName && activity.status === "running");
}
function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}
function appendActivityText(current: string | undefined, next: string): string {
  return truncateActivityString(appendPossiblyCumulativeText(current ?? "", next).value);
}
function appendPossiblyCumulativeText(current: string, next: string): { value: string; appended: string } {
  if (!next) return { value: current, appended: "" };
  if (!current) return { value: next, appended: next };
  if (next.startsWith(current)) {
    const appended = next.slice(current.length);
    return { value: next, appended };
  }
  return { value: `${current}${next}`, appended: next };
}
function truncateActivityString(value: string, limit = activityStringLimit): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} characters]`;
}
function limitActivityRecord(value: Record<string, unknown>): Record<string, unknown> {
  const limited = limitActivityValue(value);
  return isRecord(limited) ? limited : {};
}
function limitActivityValue(value: unknown, depth = 0, stringLimit = activityStringLimit): unknown {
  if (typeof value === "string") return truncateActivityString(value, stringLimit);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "symbol";
  if (Array.isArray(value)) {
    const limited = value.slice(0, activityArrayLimit).map((entry) => limitActivityValue(entry, depth + 1, stringLimit));
    if (value.length > activityArrayLimit) limited.push(`[truncated ${value.length - activityArrayLimit} items]`);
    return limited;
  }
  if (!isRecord(value)) return null;
  if (depth >= activityDepthLimit) return "[truncated nested object]";
  const entries = Object.entries(value);
  const limited: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, activityObjectKeyLimit)) limited[key] = limitActivityValue(entry, depth + 1, stringLimit);
  if (entries.length > activityObjectKeyLimit) limited.__truncated = `${entries.length - activityObjectKeyLimit} fields omitted`;
  return limited;
}
function queueRequest(request: InternalActiveResponseInputRequest): InternalSendMessageRequest {
  return { content: request.content, attachments: request.attachments, projectId: request.projectId, workspaceId: request.workspaceId, skillIds: request.skillIds, model: request.model, reasoningEffort: request.reasoningEffort, contextTier: request.contextTier, permissionMode: request.permissionMode, uploadClaimId: request.uploadClaimId };
}
function providerMessageForActiveInput(request: InternalActiveResponseInputRequest): ProviderMessage {
  const attachments: NonNullable<ProviderMessage["attachments"]> = [];
  for (const attachment of request.attachments ?? []) {
    if (attachment.filePath) attachments.push({ type: "file", path: attachment.filePath, displayName: attachment.name, size: attachment.size });
    else if (attachment.data) attachments.push({ type: "blob", data: attachment.data, mimeType: attachment.mimeType, displayName: attachment.name, size: attachment.size });
  }
  return {
    role: "user",
    content: request.content,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}
function normalizeArtifactKind(kind: string): "text" | "markdown" | "code" | "json" | "mermaid" | "html" | "file-bundle" {
  return kind === "html" || kind === "json" || kind === "mermaid" || kind === "code" || kind === "text" || kind === "file-bundle" ? kind : "markdown";
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function writeSseHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  reply.raw.socket?.setNoDelay(true);
  reply.raw.flushHeaders();
  reply.raw.write(": connected\n\n");
}

export function writeSse(reply: FastifyReply, event: string, data: unknown): boolean {
  const payload: StreamEvent = { event, data };
  const accepted = reply.raw.write(`event: ${payload.event}\ndata: ${JSON.stringify(payload.data)}\n\n`);
  const raw = reply.raw as typeof reply.raw & { flush?: () => void };
  raw.flush?.();
  return accepted;
}
