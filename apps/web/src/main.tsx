import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { AppState, Chat, ChatMessage, ContextTier, ImportDraft, McpServer, MessageAttachment, PermissionMode, Project, ProjectChatReference, ProjectChatSearchResult, ProjectReference, ProviderModel, ProviderStatus, Skill, Workspace } from "@copilotchat/shared";
import { IconBell, IconCheck, IconClose, IconCopy, IconCopilot, IconDownload, IconEdit, IconFolder, IconMenu, IconMore, IconPlug, IconPlus, IconRetry, IconSearch, IconSend, IconSettings, IconSparkle, IconStar, IconStop, IconTerminal, IconUpload } from "./icons.js";
import { externalLinkProps } from "./links.js";
import "./styles.css";

type Theme = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";
type Tab = "preferences" | "skills" | "tools" | "code";
type SseEvent = { event: string; data: unknown };
const API_TOKEN_KEY = "copilotchat.apiToken";
const MODEL_KEY = "copilotchat.model";
const EFFORT_KEY = "copilotchat.reasoningEffort";
const CONTEXT_TIER_KEY = "copilotchat.contextTier";
const PERMISSION_MODE_KEY = "copilotchat.permissionMode";
const TEXT_SCALE_KEY = "copilotchat.textScale";
const CHAT_SEEN_KEY = "copilotchat.chatSeenUpdatedAt";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";
const CHAT_ROUTE_PREFIX = "/chats/";
const PROJECT_ROUTE_PREFIX = "/projects/";
const LIVE_SCROLL_THRESHOLD = 96;
const DEFAULT_TEXT_SCALE = 0.95;
const IMPORT_ASSISTANT_SKILL_ID = "import-assistant";
const EMPTY_PROVIDER: ProviderStatus = { id: "unknown", label: "Loading", available: false, details: "", capabilities: [], models: [], defaultModel: undefined };
const STARTERS = [
  ["Search the web", "Get up-to-date answers using Copilot tools.", "Search the web for the latest GitHub Copilot SDK release notes and summarize the highlights."],
  ["Plan a refactor", "Outline phases, risks, and validation.", "Help me plan a step-by-step refactor of a Node.js service to TypeScript."],
  ["Draft an artifact", "Create a reusable Markdown document.", "Draft a one-page design doc as a Markdown artifact for a small CLI utility."],
  ["Cowork on a folder", "Connect a workspace and explore changes.", "Walk me through registering a workspace folder and reviewing the current changes."],
] as const;
const PERMISSIONS = ["network", "filesystem:read", "filesystem:write", "shell", "mcp", "github", "artifacts"] as const;
const EFFORT_OPTIONS = ["default", "none", "low", "medium", "high", "xhigh", "max"] as const;
type ReasoningEffort = (typeof EFFORT_OPTIONS)[number];
type ContextStatus = { estimatedTokens: number; limitTokens: number | null; percent: number | null; label: string; detail: string; state: "ok" | "warn" | "full" | "unknown" };
type TaskListItem = { title: string; completed: boolean; depth?: number };
type AssistantActivity = { id: string; type: "reasoning" | "tool" | "subagent" | "task-list"; title: string; status: "running" | "succeeded" | "failed"; content?: string; items?: TaskListItem[]; input?: unknown; output?: unknown; error?: string | null; details?: Record<string, unknown>; steps?: AssistantActivity[] };
type PendingInteraction = { id: string; kind: "permission" | "user-input" | "elicitation"; title: string; message: string; choices?: string[]; allowFreeform?: boolean; request?: unknown; requestedSchema?: unknown };
type PendingTurn = { id: string; mode: "steer" | "queue"; content: string; status: "queued" | "sent" | "running" | "done" | "failed"; createdAt: string };
type ProjectEditorState = { kind: "memory" | "instructions"; title: string; value: string; placeholder: string } | { kind: "reference"; title: string; referenceId?: string; referenceTitle: string; value: string };
type AppDialog = { kind: "text"; title: string; message?: string; label: string; initialValue?: string; placeholder?: string; confirmLabel: string; onConfirm: (value: string) => void | Promise<void> } | { kind: "confirm"; title: string; message: string; confirmLabel: string; danger?: boolean; requireText?: string; onConfirm: () => void | Promise<void> };
type AppRoute = { kind: "home" } | { kind: "chat"; chatId: string } | { kind: "project"; projectId: string };
type SlashCommand = { command: string; title: string; description: string; body: string };
type ComposerHandle = { focus: () => void; setValue: (value: string) => void; clear: () => void };
type ChatScrollState = { top: number; atLive: boolean };
type MessageProps = { message: ChatMessage; streaming?: boolean; activities?: AssistantActivity[]; editing?: boolean; editValue?: string; canEdit?: boolean; canRetry?: boolean; onEditStart?: (message: ChatMessage) => void; onEditChange?: (content: string) => void; onEditCancel?: () => void; onEditSave?: (message: ChatMessage, content: string) => void; onRetry?: (message: ChatMessage) => void };
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "preferences", label: "Preferences", icon: <IconSettings width={14} height={14} /> },
  { id: "skills", label: "Skills", icon: <IconSparkle width={14} height={14} /> },
  { id: "tools", label: "Tools", icon: <IconPlug width={14} height={14} /> },
  { id: "code", label: "Code", icon: <IconTerminal width={14} height={14} /> },
];
const DRAWER_DESCRIPTIONS: Record<Tab, string> = {
  preferences: "Account, appearance, imports, notifications, and local data.",
  skills: "Choose reusable behaviors for the next turn.",
  tools: "Connect external tools and keep their permissions visible.",
  code: "Attach local folders for cowork tasks.",
};

function App(): React.ReactElement {
  const initialRoute = appRouteFromLocation();
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => readSystemTheme());
  const [apiToken, setApiToken] = useState(() => localStorage.getItem(API_TOKEN_KEY) ?? "");
  const [state, setState] = useState<AppState | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(() => initialRoute.kind === "chat" ? initialRoute.chatId : null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => initialRoute.kind === "project" ? initialRoute.projectId : null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => (localStorage.getItem(EFFORT_KEY) as ReasoningEffort | null) ?? "default");
  const [contextTier, setContextTier] = useState<ContextTier>(() => readContextTier());
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => localStorage.getItem(PERMISSION_MODE_KEY) === "yolo" ? "yolo" : "ask");
  const [textScale, setTextScale] = useState(() => readTextScale());
  const [seenChatUpdates, setSeenChatUpdates] = useState<Record<string, string>>(() => readSeenChatUpdates());
  const [localRunningChatIds, setLocalRunningChatIds] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [editingMessage, setEditingMessage] = useState<{ id: string; content: string } | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [streamingActivities, setStreamingActivities] = useState<AssistantActivity[]>([]);
  const [pendingInteractions, setPendingInteractions] = useState<PendingInteraction[]>([]);
  const [pendingTurns, setPendingTurns] = useState<PendingTurn[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [drawer, setDrawer] = useState<Tab | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loginRequired, setLoginRequired] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [showJumpToLive, setShowJumpToLive] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const liveScrollRef = useRef(true);
  const chatScrollStatesRef = useRef<Record<string, ChatScrollState>>({});
  const pendingChatScrollRef = useRef<{ chatId: string; state: ChatScrollState | null } | null>(null);
  const composerRef = useRef<ComposerHandle | null>(null);
  const seenInitializedRef = useRef(false);
  const drawerRef = useRef<Tab | null>(null);
  const sidebarOpenRef = useRef(false);
  const busyRef = useRef(false);
  const selectedChatIdRef = useRef<string | null>(null);
  const appPathRef = useRef(appPathForSelection(selectedChatId, activeProjectId));
  const stopResponseRef = useRef<() => void>(() => {});
  const provider = state?.provider ?? EMPTY_PROVIDER;
  const chats = state?.chats ?? [];
  const allChats = useMemo(() => [...(state?.chats ?? []), ...(state?.archivedChats ?? [])], [state?.chats, state?.archivedChats]);
  const projects = state?.projects ?? [];
  const skills = state?.skills ?? [];
  const selectedChat = useMemo(() => allChats.find((c) => c.id === selectedChatId) ?? null, [allChats, selectedChatId]);
  const activeProject = useMemo(() => projects.find((p) => p.id === (selectedChat?.projectId ?? activeProjectId)) ?? null, [projects, activeProjectId, selectedChat?.projectId]);
  const activeWorkspace = useMemo(() => (state?.workspaces ?? []).find((w) => w.id === (selectedChat?.workspaceId ?? activeWorkspaceId)) ?? null, [state?.workspaces, selectedChat?.workspaceId, activeWorkspaceId]);
  const selectedSkills = useMemo(() => skills.filter((s) => selectedSkillIds.includes(s.id)), [skills, selectedSkillIds]);
  const runningChatIdsArray = useMemo(() => Array.from(new Set([...(state?.activeChatIds ?? []), ...localRunningChatIds])), [state?.activeChatIds, localRunningChatIds]);
  const runningChatIds = useMemo(() => new Set(runningChatIdsArray), [runningChatIdsArray]);
  const runningChatKey = runningChatIdsArray.join("|");
  const unreadChatIds = useMemo(() => new Set(chats.filter((chat) => chat.id !== selectedChatId && Boolean(seenChatUpdates[chat.id]) && chat.updatedAt > seenChatUpdates[chat.id]!).map((chat) => chat.id)), [chats, selectedChatId, seenChatUpdates]);
  const fallbackModel = provider.defaultModel ?? (selectedModel || "gpt-4.1");
  const providerModels = provider.models.length > 0 ? provider.models : [{ id: fallbackModel, name: fallbackModel, supportsReasoningEffort: true, supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium", supportsLongContext: false, contextWindowTokens: 128000, maxPromptTokens: 128000 }];
  const providerDefaultModel = provider.defaultModel ?? providerModels[0]?.id ?? selectedModel;
  const selectedModelInfo = providerModels.find((model) => model.id === selectedModel) ?? providerModels.find((model) => model.id === providerDefaultModel) ?? providerModels[0];
  const effortChoices = reasoningEffortChoices(selectedModelInfo);
  const supportsLongContext = Boolean(selectedModelInfo?.supportsLongContext);
  const contextStatus = useMemo(() => buildContextStatus(messages, streamingText, draft, activeProject, activeWorkspace, selectedSkills, selectedModelInfo ?? null, contextTier), [messages, streamingText, draft, activeProject, activeWorkspace, selectedSkills, selectedModelInfo, contextTier]);
  useEffect(() => {
    const query = window.matchMedia(SYSTEM_THEME_QUERY);
    const update = () => setSystemTheme(query.matches ? "dark" : "light");
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme === "system" ? systemTheme : theme; document.documentElement.dataset.themePreference = theme; localStorage.setItem("copilotchat.theme", theme); }, [theme, systemTheme]);
  useEffect(() => { document.documentElement.style.setProperty("--text-scale", textScale.toFixed(2)); localStorage.setItem(TEXT_SCALE_KEY, textScale.toFixed(2)); }, [textScale]);
  useEffect(() => { if (selectedModel) localStorage.setItem(MODEL_KEY, selectedModel); }, [selectedModel]);
  useEffect(() => {
    if (!provider.defaultModel || provider.models.length === 0) return;
    const isSavedFallback = selectedModel === "gpt-4.1" && provider.defaultModel !== "gpt-4.1";
    const missingFromProvider = !provider.models.some((model) => model.id === selectedModel);
    if (!selectedModel || isSavedFallback || missingFromProvider) setSelectedModel(provider.defaultModel);
  }, [provider.defaultModel, provider.models, selectedModel]);
  useEffect(() => { if (selectedModelInfo && selectedModelInfo.id !== selectedModel) setSelectedModel(selectedModelInfo.id); }, [selectedModel, selectedModelInfo]);
  useEffect(() => { if (!effortChoices.includes(reasoningEffort)) setReasoningEffort("default"); }, [effortChoices, reasoningEffort]);
  useEffect(() => { localStorage.setItem(EFFORT_KEY, reasoningEffort); }, [reasoningEffort]);
  useEffect(() => { if (provider.id !== "unknown" && !supportsLongContext && contextTier !== "default") setContextTier("default"); }, [provider.id, supportsLongContext, contextTier]);
  useEffect(() => { localStorage.setItem(CONTEXT_TIER_KEY, contextTier); }, [contextTier]);
  useEffect(() => { localStorage.setItem(PERMISSION_MODE_KEY, permissionMode); }, [permissionMode]);
  useEffect(() => { drawerRef.current = drawer; }, [drawer]);
  useEffect(() => { sidebarOpenRef.current = sidebarOpen; }, [sidebarOpen]);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { selectedChatIdRef.current = selectedChatId; appPathRef.current = appPathForSelection(selectedChatId, selectedChat?.projectId ?? activeProjectId); syncAppUrl(appPathRef.current); }, [selectedChatId, selectedChat?.projectId, activeProjectId]);
  useEffect(() => { stopResponseRef.current = () => { void stopActiveResponse(); }; });
  useEffect(() => installBackGuard({ drawerRef, sidebarOpenRef, busyRef, stopResponseRef, currentPath: () => appPathRef.current, closeDrawer: () => setDrawer(null), closeSidebar: () => setSidebarOpen(false), toast: setToast }), []);
  useEffect(() => {
    function keyDown(event: KeyboardEvent): void {
      if (isEditableTarget(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") { setShortcutsOpen(false); return; }
      if (event.key === "?" && !mod) { event.preventDefault(); setShortcutsOpen(true); return; }
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "k") { event.preventDefault(); setShortcutsOpen(true); return; }
      if (key === "n") { event.preventDefault(); void createChat(activeProjectId, activeWorkspaceId); return; }
      if (key === ",") { event.preventDefault(); setDrawer("preferences"); return; }
      if (key === "b") { event.preventDefault(); setSidebarOpen((open) => !open); }
    }
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  });
  useEffect(() => { void registerServiceWorker(); void refreshState(); }, []);
  useEffect(() => { if (selectedChat) { markChatSeen(selectedChat.id, selectedChat.updatedAt); setActiveProjectId(selectedChat.projectId); setActiveWorkspaceId(selectedChat.workspaceId); if (selectedChat.model) setSelectedModel(selectedChat.model); setReasoningEffort(selectedChat.reasoningEffort && EFFORT_OPTIONS.includes(selectedChat.reasoningEffort) ? selectedChat.reasoningEffort : "default"); setContextTier(selectedChat.contextTier ?? "default"); } }, [selectedChat]);
  useEffect(() => { if (!selectedChatId) { setMessages([]); setStreamingText(""); setStreamingActivities([]); setPendingInteractions([]); setPendingTurns([]); return; } const controller = new AbortController(); void loadChatAndReconnect(selectedChatId, controller); return () => controller.abort(); }, [selectedChatId, apiToken]);
  useEffect(() => {
    setShowJumpToLive(false);
    if (!selectedChatId) {
      liveScrollRef.current = false;
      pendingChatScrollRef.current = null;
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0, behavior: "auto" }));
      return;
    }
    const saved = chatScrollStatesRef.current[selectedChatId] ?? null;
    pendingChatScrollRef.current = { chatId: selectedChatId, state: saved };
    liveScrollRef.current = saved?.atLive ?? true;
  }, [selectedChatId, activeProjectId]);
  useEffect(() => { if (!state) return; const active = new Set(state.activeChatIds); setLocalRunningChatIds((current) => current.filter((id) => active.has(id) || (busy && id === selectedChatId))); }, [state?.activeChatIds, busy, selectedChatId]);
  useEffect(() => { if (!runningChatKey) return; const id = window.setInterval(() => void refreshState(), 1200); return () => window.clearInterval(id); }, [runningChatKey, apiToken]);
  useEffect(() => { if (provider.id !== "unknown") return; const id = window.setInterval(() => void refreshState(), 1000); return () => window.clearInterval(id); }, [provider.id, apiToken]);
  useLayoutEffect(() => {
    if (!selectedChatId) return;
    const pending = pendingChatScrollRef.current;
    if (pending?.chatId === selectedChatId) {
      restoreChatScroll(selectedChatId, pending.state);
      pendingChatScrollRef.current = null;
      return;
    }
    if (liveScrollRef.current) scrollToLive("auto");
  }, [selectedChatId, messages, streamingText, streamingActivities, pendingTurns, pendingInteractions, busy]);
  async function refreshState(): Promise<void> { try { const next = await api<AppState>("/api/state", {}, apiToken); setLoginRequired(false); const selectedId = selectedChatIdRef.current; if (selectedId && ![...next.chats, ...next.archivedChats].some((chat) => chat.id === selectedId)) { selectedChatIdRef.current = null; setSelectedChatId(null); setMessages([]); setStreamingText(""); setStreamingActivities([]); setPendingInteractions([]); setPendingTurns([]); syncAppUrl(appPathForSelection(null, activeProjectId)); } setState(next); initializeSeenChatUpdates(next); } catch (e) { const message = toErr(e); if (message.includes("Login required") || message.includes("Unauthorized")) { const status = await api<{mode:string;authenticated?:boolean;githubOAuthConfigured?:boolean}>("/api/auth/status").catch(() => null); if (status?.mode === "github" && !status.authenticated) { setLoginRequired(true); setError(status.githubOAuthConfigured ? null : "GitHub OAuth is not configured on this server."); return; } } if (message.includes("Unauthorized")) setDrawer("preferences"); setError(message); } }
  async function createChat(projectId = activeProjectId, workspaceId = activeWorkspaceId, options: { cleanup?: boolean; refresh?: boolean } = {}): Promise<Chat> { saveCurrentChatScroll(); activateLiveScroll(); const projectDefaultModel = projectId ? projects.find((project) => project.id === projectId)?.defaultModel : null; const model = projectDefaultModel ?? selectedModelInfo?.id ?? selectedModel; const modelInfo = providerModels.find((item) => item.id === model); const choices = reasoningEffortChoices(modelInfo); const nextEffort = choices.includes(reasoningEffort) ? reasoningEffort : "default"; const nextContextTier = modelInfo?.supportsLongContext ? contextTier : "default"; const chat = await api<Chat>("/api/chats", { method: "POST", body: { title: "New chat", projectId, workspaceId, model, reasoningEffort: nextEffort, contextTier: nextContextTier } }, apiToken); syncAppUrl(appPathForSelection(chat.id, null)); selectedChatIdRef.current = chat.id; setSelectedChatId(chat.id); setState((current) => current ? { ...current, chats: [chat, ...current.chats.filter((item) => item.id !== chat.id)] } : current); setMessages([]); setStreamingText(""); setStreamingActivities([]); setPendingInteractions([]); setPendingTurns([]); setError(null); if (options.cleanup !== false) await cleanupAbandonedEmptyChats(chat.id); if (options.refresh !== false) await refreshState(); composerRef.current?.focus(); return chat; }
  async function renameChat(chat: Chat): Promise<void> { setDialog({ kind: "text", title: "Rename chat", label: "Chat title", initialValue: chat.title, confirmLabel: "Save title", onConfirm: async (title) => { if (!title.trim()) return; await api<Chat>(`/api/chats/${chat.id}`, { method: "PATCH", body: { title: title.trim() } }, apiToken); await refreshState(); } }); }
  async function archiveChat(chat: Chat): Promise<void> { await api<Chat>(`/api/chats/${chat.id}`, { method: "PATCH", body: { archived: true } }, apiToken); if (selectedChatId === chat.id) setSelectedChatId(null); await refreshState(); setToast("Archived chat"); }
  async function deleteChat(chat: Chat): Promise<void> { setDialog({ kind: "confirm", title: "Delete chat?", message: `"${chat.title}" will be permanently deleted from this device.`, confirmLabel: "Delete chat", danger: true, onConfirm: async () => { await api<void>(`/api/chats/${chat.id}`, { method: "DELETE", raw: true }, apiToken); if (selectedChatId === chat.id) setSelectedChatId(null); await refreshState(); setToast("Deleted chat"); } }); }
  async function toggleChatFavorite(chat: Chat): Promise<void> { await api<Chat>(`/api/chats/${chat.id}`, { method: "PATCH", body: { favorite: !chat.favorite } }, apiToken); await refreshState(); }
  async function toggleProjectFavorite(project: Project): Promise<void> { await api<Project>(`/api/projects/${project.id}`, { method: "PATCH", body: { favorite: !project.favorite } }, apiToken); await refreshState(); }
  async function createProjectFromSidebar(): Promise<void> { setDialog({ kind: "text", title: "New project", message: "Projects keep instructions, memory, references, and default model choices together.", label: "Project name", placeholder: "My project", confirmLabel: "Create project", onConfirm: async (name) => { if (!name.trim()) return; const project = await api<Project>("/api/projects", { method: "POST", body: { name: name.trim(), description: "", instructions: "", memory: "" } }, apiToken); selectProject(project.id); await refreshState(); } }); }
  async function renameProject(project: Project): Promise<void> { setDialog({ kind: "text", title: "Rename project", label: "Project name", initialValue: project.name, confirmLabel: "Save name", onConfirm: async (name) => { if (!name.trim()) return; await api<Project>(`/api/projects/${project.id}`, { method: "PATCH", body: { name: name.trim() } }, apiToken); await refreshState(); } }); }
  async function deleteProject(project: Project): Promise<void> { setDialog({ kind: "confirm", title: "Delete project?", message: `"${project.name}" will be deleted. Its chats move back to General chats.`, confirmLabel: "Delete project", danger: true, onConfirm: async () => { await api<void>(`/api/projects/${project.id}`, { method: "DELETE", raw: true }, apiToken); if (activeProjectId === project.id) selectProject(null); await refreshState(); setToast("Deleted project"); } }); }
  function changeModel(model: string): void { const modelInfo = providerModels.find((item) => item.id === model); const choices = reasoningEffortChoices(modelInfo); const nextEffort = choices.includes(reasoningEffort) ? reasoningEffort : "default"; const nextContextTier = modelInfo?.supportsLongContext ? contextTier : "default"; setSelectedModel(model); setReasoningEffort(nextEffort); setContextTier(nextContextTier); if (selectedChatIdRef.current) void api<Chat>(`/api/chats/${selectedChatIdRef.current}`, { method: "PATCH", body: { model, reasoningEffort: nextEffort, contextTier: nextContextTier } }, apiToken).then(() => refreshState()).catch((e) => setError(toErr(e))); }
  function changeReasoningEffort(effort: ReasoningEffort): void { setReasoningEffort(effort); if (selectedChatIdRef.current) void api<Chat>(`/api/chats/${selectedChatIdRef.current}`, { method: "PATCH", body: { reasoningEffort: effort } }, apiToken).then(() => refreshState()).catch((e) => setError(toErr(e))); }
  function changeContextTier(tier: ContextTier): void { setContextTier(tier); if (selectedChatIdRef.current) void api<Chat>(`/api/chats/${selectedChatIdRef.current}`, { method: "PATCH", body: { contextTier: tier } }, apiToken).then(() => refreshState()).catch((e) => setError(toErr(e))); }
  function changePermissionMode(mode: PermissionMode): void { setPermissionMode(mode); const chatId = selectedChatIdRef.current; if (chatId && busyRef.current) void api<{ active: boolean }>(`/api/chats/${chatId}/active-response`, { method: "PATCH", body: { permissionMode: mode } }, apiToken).catch((e) => setError(toErr(e))); }
  async function sendMessage(content: string, options: { chat?: Chat; skillIds?: string[]; attachments?: MessageAttachment[] } = {}): Promise<void> { const trimmed = content.trim(); const attachments = options.attachments ?? []; if ((!trimmed && attachments.length === 0) || busy) return; activateLiveScroll(); setBusy(true); setError(null); setStreamingActivities([]); setPendingInteractions([]); setPendingTurns([]); let chat = options.chat ?? selectedChat; const useChatSettings = Boolean(options.chat) || !chat; if (!chat) chat = await createChat(activeProjectId, activeWorkspaceId, { cleanup: false, refresh: false }); setDraft(""); setMessages((m) => [...m, { id: `optimistic-${Date.now()}`, chatId: chat.id, role: "user", content: trimmed, provider: null, metadata: attachments.length ? { attachments } : {}, createdAt: new Date().toISOString() }]); const controller = new AbortController(); abortRef.current = controller; await streamChatResponse(chat.id, `/api/chats/${chat.id}/messages`, turnBody(trimmed, chat, options.skillIds, attachments, useChatSettings ? chat : undefined), controller); }
  async function sendWhileBusy(mode: "steer" | "queue", content: string, attachments: MessageAttachment[] = []): Promise<void> { const trimmed = content.trim(); const chat = selectedChat; if ((!trimmed && attachments.length === 0) || !chat || !busy) return; setDraft(""); const pending = await api<PendingTurn>(`/api/chats/${chat.id}/active-response/input`, { method: "POST", body: { ...turnBody(trimmed, chat, selectedSkillIds, attachments), mode } }, apiToken); setPendingTurns((current) => upsertPendingTurn(current, pending)); }
  async function editAndContinue(messageId: string, content: string): Promise<void> { const trimmed = content.trim(); if (!selectedChat || !trimmed || busy) return; const index = messages.findIndex((message) => message.id === messageId); if (index < 0) return; activateLiveScroll(); setEditingMessage(null); setBusy(true); setError(null); setStreamingText(""); setStreamingActivities([]); setPendingInteractions([]); setPendingTurns([]); setMessages(messages.slice(0, index + 1).map((message) => message.id === messageId ? { ...message, content: trimmed, metadata: { ...message.metadata, editedAt: new Date().toISOString() } } : message)); const controller = new AbortController(); abortRef.current = controller; await streamChatResponse(selectedChat.id, `/api/chats/${selectedChat.id}/messages/${messageId}/edit`, { content: trimmed, skillIds: selectedSkillIds, model: selectedModel, reasoningEffort, contextTier, permissionMode }, controller); }
  async function retryResponse(messageId: string): Promise<void> { if (!selectedChat || busy) return; const index = messages.findIndex((message) => message.id === messageId); if (index < 0) return; activateLiveScroll(); setBusy(true); setError(null); setStreamingText(""); setStreamingActivities([]); setPendingInteractions([]); setPendingTurns([]); setMessages(messages.slice(0, index)); const controller = new AbortController(); abortRef.current = controller; await streamChatResponse(selectedChat.id, `/api/chats/${selectedChat.id}/messages/${messageId}/retry`, { skillIds: selectedSkillIds, model: selectedModel, reasoningEffort, contextTier, permissionMode }, controller); }
  async function loadChatAndReconnect(chatId: string, controller: AbortController): Promise<void> { try { setStreamingText(""); setStreamingActivities([]); setPendingInteractions([]); setPendingTurns([]); setMessages(await api<ChatMessage[]>(`/api/chats/${chatId}/messages`, {}, apiToken)); await streamChatResponse(chatId, `/api/chats/${chatId}/active-response`, undefined, controller, "GET", false); } catch (e) { if ((e as Error).name === "AbortError") return; const message = toErr(e); if (message.includes("Chat not found")) { selectedChatIdRef.current = null; setSelectedChatId(null); setMessages([]); setStreamingText(""); setStreamingActivities([]); setPendingInteractions([]); setPendingTurns([]); setError(null); syncAppUrl(appPathForSelection(null, activeProjectId)); await refreshState(); return; } setError(message); } }
  async function streamChatResponse(chatId: string, url: string, body: unknown, controller: AbortController, method = "POST", notifyWhenDone = true): Promise<void> {
    abortRef.current = controller;
    addRunningChat(chatId);
    let completed = false;
    try {
      for await (const event of streamSse(url, body, controller.signal, apiToken, method)) {
        const done = await handleStreamEvent(chatId, event);
        if (done) { completed = true; break; }
      }
      setStreamingText("");
      setStreamingActivities([]);
      setPendingInteractions([]);
      setPendingTurns([]);
      setMessages(await api<ChatMessage[]>(`/api/chats/${chatId}/messages`, {}, apiToken));
      await refreshState();
      if (notifyWhenDone) notify("CopilotChat", "Response ready");
    } catch (e) {
      if ((e as Error).name !== "AbortError") { removeRunningChat(chatId); setError(toErr(e)); }
    } finally {
      if (completed || !controller.signal.aborted) removeRunningChat(chatId);
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  }
  async function handleStreamEvent(chatId: string, event: SseEvent): Promise<boolean> { if (event.event === "snapshot") { const data = event.data as { text?: string; activities?: unknown; interactions?: unknown; pendingTurns?: unknown }; setBusy(true); setStreamingText(data.text ?? ""); setStreamingActivities(readActivities(data.activities)); setPendingInteractions(readInteractions(data.interactions)); setPendingTurns(readPendingTurns(data.pendingTurns)); return false; } if (event.event === "pending") { setBusy(true); setPendingTurns(readPendingTurns((event.data as { pendingTurns?: unknown }).pendingTurns)); return false; } if (event.event === "message") { setMessages(await api<ChatMessage[]>(`/api/chats/${chatId}/messages`, {}, apiToken)); setStreamingText(""); setStreamingActivities([]); return false; } if (event.event === "interaction") { setBusy(true); setPendingInteractions(readInteractions((event.data as { interactions?: unknown }).interactions)); return false; } if (event.event === "activity") { setBusy(true); setStreamingActivities(readActivities((event.data as { activities?: unknown }).activities)); return false; } if (event.event === "delta") { setBusy(true); setStreamingText((t) => t + ((event.data as { text?: string }).text ?? "")); return false; } if (event.event === "artifact") { void refreshState(); setToast("Artifact created"); return false; } if (event.event === "error") throw new Error((event.data as { message?: string }).message ?? "Message failed"); if (event.event === "done") { const data = event.data as { active?: boolean; cancelled?: boolean } | undefined; if (data?.active === false) return true; if (data?.cancelled) setToast("Response stopped"); setPendingInteractions([]); setPendingTurns([]); setMessages(await api<ChatMessage[]>(`/api/chats/${chatId}/messages`, {}, apiToken)); return true; } return false; }
  async function resolveInteraction(interaction: PendingInteraction, resolution: { action: string; answer?: string; wasFreeform?: boolean; content?: unknown }): Promise<void> { const chatId = selectedChatIdRef.current; if (!chatId) return; setPendingInteractions((current) => current.filter((item) => item.id !== interaction.id)); await api<void>(`/api/chats/${chatId}/interactions/${interaction.id}`, { method: "POST", body: resolution, raw: true }, apiToken); }
  async function stopActiveResponse(): Promise<void> {
    const chatId = selectedChatIdRef.current;
    const controller = abortRef.current;
    controller?.abort();
    try {
      if (chatId) {
        await api<void>(`/api/chats/${chatId}/active-response`, { method: "DELETE", raw: true }, apiToken);
        removeRunningChat(chatId);
        if (selectedChatIdRef.current === chatId) setMessages(await api<ChatMessage[]>(`/api/chats/${chatId}/messages`, {}, apiToken));
      }
    } catch (e) {
      setError(toErr(e));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
      setStreamingText("");
      setStreamingActivities([]);
      setPendingInteractions([]);
      setPendingTurns([]);
    }
  }
  function turnBody(content: string, chat: Chat, skillIds = selectedSkillIds, attachments: MessageAttachment[] = [], chatSettings?: Chat): Record<string, unknown> { return { content, attachments, projectId: chat.projectId, workspaceId: chat.workspaceId ?? activeWorkspaceId, skillIds, model: chatSettings?.model ?? selectedModel, reasoningEffort: chatSettings?.reasoningEffort ?? reasoningEffort, contextTier: chatSettings?.contextTier ?? contextTier, permissionMode }; }
  function initializeSeenChatUpdates(next: AppState): void {
    if (seenInitializedRef.current) return;
    seenInitializedRef.current = true;
    setSeenChatUpdates((current) => writeSeenChatUpdates([...next.chats, ...next.archivedChats].reduce((acc, chat) => ({ ...acc, [chat.id]: acc[chat.id] ?? chat.updatedAt }), { ...current })));
  }
  function markChatSeen(chatId: string, updatedAt?: string): void {
    const stamp = updatedAt ?? allChats.find((chat) => chat.id === chatId)?.updatedAt;
    if (!stamp) return;
    setSeenChatUpdates((current) => current[chatId] === stamp ? current : writeSeenChatUpdates({ ...current, [chatId]: stamp }));
  }
  async function cleanupAbandonedEmptyChats(exceptChatId: string | null): Promise<void> {
    try {
      const query = exceptChatId ? `?except=${encodeURIComponent(exceptChatId)}` : "";
      const result = await api<{ deletedChatIds: string[] }>(`/api/chats/empty${query}`, { method: "DELETE" }, apiToken);
      if (result.deletedChatIds.length === 0) return;
      const deleted = new Set(result.deletedChatIds);
      setState((current) => current ? { ...current, chats: current.chats.filter((chat) => !deleted.has(chat.id)), archivedChats: current.archivedChats.filter((chat) => !deleted.has(chat.id)) } : current);
      setSeenChatUpdates((current) => { const next = { ...current }; for (const id of deleted) delete next[id]; return writeSeenChatUpdates(next); });
      setLocalRunningChatIds((current) => current.filter((id) => !deleted.has(id)));
      if (selectedChatIdRef.current && deleted.has(selectedChatIdRef.current)) setSelectedChatId(null);
    } catch (e) {
      setError(toErr(e));
    }
  }
  async function clearAllData(): Promise<void> {
    setDialog({ kind: "confirm", title: "Clear local app data?", message: "This deletes chats, projects, artifacts, skills, MCP servers, workspaces, tool history, and isolated chat workspaces. Account/auth setup is kept.", confirmLabel: "Clear all data", danger: true, requireText: "CLEAR", onConfirm: async () => {
      abortRef.current?.abort();
      await api<void>("/api/data", { method: "DELETE", raw: true }, apiToken);
      selectedChatIdRef.current = null;
      setSelectedChatId(null);
      setActiveProjectId(null);
      setActiveWorkspaceId(null);
      setSelectedSkillIds([]);
      composerRef.current?.clear();
      setDraft("");
      setMessages([]);
      setStreamingText("");
      setStreamingActivities([]);
      setPendingInteractions([]);
      setPendingTurns([]);
      setLocalRunningChatIds([]);
      setSeenChatUpdates(writeSeenChatUpdates({}));
      setBusy(false);
      setError(null);
      await refreshState();
      setToast("Cleared local app data");
    } });
  }
  async function startGuidedImport(file: File): Promise<void> {
    try {
      const isZip = file.name.toLowerCase().endsWith(".zip");
      const draft = await api<ImportDraft>("/api/imports/drafts", { method: "POST", body: { source: "auto", fileName: file.name, content: isZip ? await fileToBase64(file) : await file.text(), encoding: isZip ? "base64" : "text" } }, apiToken);
      const importSkillId = state?.skills.find((skill) => skill.manifest.id === IMPORT_ASSISTANT_SKILL_ID || skill.id === IMPORT_ASSISTANT_SKILL_ID)?.id ?? "";
      const skillIds = importSkillId ? [importSkillId] : [];
      if (importSkillId) setSelectedSkillIds((current) => current.includes(importSkillId) ? current : [...current, importSkillId]);
      setDrawer(null);
      const chat = await createChat(null, null, { cleanup: false, refresh: false });
      await sendMessage(guidedImportPrompt(draft), { chat, skillIds });
    } catch (e) {
      setError(toErr(e));
    }
  }
  function addRunningChat(chatId: string): void { setLocalRunningChatIds((current) => current.includes(chatId) ? current : [...current, chatId]); }
  function removeRunningChat(chatId: string): void { setLocalRunningChatIds((current) => current.filter((id) => id !== chatId)); }
  function selectChat(id: string): void { saveCurrentChatScroll(); selectedChatIdRef.current = id; void cleanupAbandonedEmptyChats(id); markChatSeen(id); setSelectedChatId(id); setError(null); }
  function selectProject(id: string | null): void { saveCurrentChatScroll(); selectedChatIdRef.current = null; void cleanupAbandonedEmptyChats(null); setActiveProjectId(id); setSelectedChatId(null); setMessages([]); setStreamingText(""); setStreamingActivities([]); setPendingInteractions([]); setPendingTurns([]); setError(null); }
  function activateLiveScroll(): void { liveScrollRef.current = true; setShowJumpToLive(false); }
  function scrollToLive(behavior: ScrollBehavior = "smooth"): void { const scroll = scrollRef.current; if (!scroll) return; scroll.scrollTo({ top: scroll.scrollHeight, behavior }); activateLiveScroll(); }
  function handleThreadScroll(): void { const scroll = scrollRef.current; if (!scroll) return; const atLive = isAtLiveEdge(scroll); if (selectedChatIdRef.current) chatScrollStatesRef.current[selectedChatIdRef.current] = { top: scroll.scrollTop, atLive }; liveScrollRef.current = Boolean(selectedChatIdRef.current) && atLive; const shouldShow = Boolean(selectedChatIdRef.current) && !atLive && scroll.scrollHeight > scroll.clientHeight + LIVE_SCROLL_THRESHOLD; setShowJumpToLive((shown) => shown === shouldShow ? shown : shouldShow); }
  function saveCurrentChatScroll(): void { const chatId = selectedChatIdRef.current; const scroll = scrollRef.current; if (!chatId || !scroll) return; chatScrollStatesRef.current[chatId] = { top: scroll.scrollTop, atLive: isAtLiveEdge(scroll) }; }
  function restoreChatScroll(chatId: string, state: ChatScrollState | null): void { const scroll = scrollRef.current; if (!scroll) return; if (!state || state.atLive) { scrollToLive("auto"); chatScrollStatesRef.current[chatId] = { top: scroll.scrollTop, atLive: true }; return; } scroll.scrollTo({ top: Math.min(state.top, scroll.scrollHeight), behavior: "auto" }); liveScrollRef.current = false; chatScrollStatesRef.current[chatId] = { top: scroll.scrollTop, atLive: isAtLiveEdge(scroll) }; setShowJumpToLive(scroll.scrollHeight > scroll.clientHeight + LIVE_SCROLL_THRESHOLD); }
  function renderThreadMessages(): React.ReactNode[] { const nodes: React.ReactNode[] = []; let lastDay = ""; for (const message of messages) { const day = messageDayKey(message.createdAt); if (day && day !== lastDay) { nodes.push(<DateBarrier key={`date-${day}-${message.id}`} value={message.createdAt} />); lastDay = day; } nodes.push(<Message key={message.id} message={message} editing={editingMessage?.id === message.id} editValue={editingMessage?.id === message.id ? editingMessage.content : ""} canEdit={!busy} canRetry={!busy} onEditStart={(next) => setEditingMessage({ id: next.id, content: next.content })} onEditChange={(content) => setEditingMessage((current) => current ? { ...current, content } : current)} onEditCancel={() => setEditingMessage(null)} onEditSave={(next, content) => void editAndContinue(next.id, content)} onRetry={(next) => void retryResponse(next.id)} />); } return nodes; }
  if (loginRequired) return <div className="auth-screen"><div className="auth-panel"><span className="welcome-mark"><IconCopilot width={46} height={46}/></span><h1>Sign in to CopilotChat</h1><p>Use GitHub to access this self-hosted instance. Your chats, projects, tools, and imports are isolated by GitHub login.</p>{error ? <p className="auth-error">{error}</p> : null}<a className="btn btn-primary" href="/api/auth/github/login">Sign in with GitHub</a></div></div>;
  return <div className="app">
    {sidebarOpen ? <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} /> : null}
    <Sidebar open={sidebarOpen} chats={chats} projects={projects} selectedChatId={selectedChatId} activeProjectId={activeProjectId} runningChatIds={runningChatIds} unreadChatIds={unreadChatIds} searchQuery={searchQuery} owner={state?.owner.login ?? "Local"} providerLabel={provider.id === "sdk" ? "GitHub Copilot" : provider.label} onSearch={setSearchQuery} onSelectChat={(id) => { selectChat(id); setSidebarOpen(false); }} onNewChat={() => void createChat()} onNewProject={() => void createProjectFromSidebar()} onSelectProject={(id) => { selectProject(id); setSidebarOpen(false); }} onToggleChatFavorite={(chat) => void toggleChatFavorite(chat)} onToggleProjectFavorite={(project) => void toggleProjectFavorite(project)} onRenameProject={(project) => void renameProject(project)} onDeleteProject={(project) => void deleteProject(project)} onRenameChat={(chat) => void renameChat(chat)} onArchiveChat={(chat) => void archiveChat(chat)} onDeleteChat={(chat) => void deleteChat(chat)} onOpenDrawer={(tab) => { setDrawer(tab); setSidebarOpen(false); }} />
    <main className="main">
      <Header chatTitle={selectedChat?.title ?? "New conversation"} projectName={activeProject?.name ?? null} chatFavorite={selectedChat?.favorite ?? null} projectFavorite={activeProject?.favorite ?? null} provider={provider} model={selectedModelInfo?.id ?? selectedModel} models={providerModels} modelInfo={selectedModelInfo ?? null} effort={reasoningEffort} effortChoices={effortChoices} contextTier={contextTier} context={contextStatus} busy={busy} onModelChange={changeModel} onEffortChange={changeReasoningEffort} onContextTierChange={changeContextTier} onToggleSidebar={() => setSidebarOpen((v) => !v)} onToggleChatFavorite={selectedChat ? () => void toggleChatFavorite(selectedChat) : undefined} onToggleProjectFavorite={activeProject ? () => void toggleProjectFavorite(activeProject) : undefined} onRenameChat={selectedChat ? () => void renameChat(selectedChat) : undefined} onArchiveChat={selectedChat ? () => void archiveChat(selectedChat) : undefined} onDeleteChat={selectedChat ? () => void deleteChat(selectedChat) : undefined} onRenameProject={activeProject ? () => void renameProject(activeProject) : undefined} onDeleteProject={activeProject ? () => void deleteProject(activeProject) : undefined} onOpenTab={setDrawer} onNewChat={() => void createChat()} onOpenShortcuts={() => setShortcutsOpen(true)} />
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} onRetry={() => void refreshState()} /> : null}
      {state && !provider.available ? <SetupBanner details={provider.details} onOpenSettings={() => setDrawer("preferences")} /> : null}
      <div ref={scrollRef} className="scroll" onScroll={handleThreadScroll}>
        {activeProject && !selectedChat && state
          ? <ProjectHome project={activeProject} state={state} models={providerModels} chats={chats.filter((chat) => chat.projectId === activeProject.id)} onSelectChat={selectChat} onNewChat={() => void createChat(activeProject.id, activeWorkspaceId)} refresh={refreshState} showToast={setToast} />
          : messages.length === 0 && !streamingText && streamingActivities.length === 0 && pendingTurns.length === 0 && pendingInteractions.length === 0
            ? <Welcome userName={state?.owner.displayName ?? state?.owner.login ?? ""} project={activeProject} onPrompt={(p) => { setDraft(p); composerRef.current?.setValue(p); composerRef.current?.focus(); }} />
            : <div className="thread">{renderThreadMessages()}<PendingTurns turns={pendingTurns}/>{streamingText || streamingActivities.length > 0 ? <Message streaming activities={streamingActivities} message={{ id: "streaming", chatId: selectedChatId ?? "", role: "assistant", content: streamingText, provider: provider.id, metadata: {}, createdAt: new Date().toISOString() }} /> : null}{busy && !streamingText && streamingActivities.length === 0 ? <Thinking /> : null}<InteractionDock interactions={pendingInteractions} onResolve={(interaction, resolution) => void resolveInteraction(interaction, resolution)} /></div>}
      </div>
      <Composer ref={composerRef} busy={busy} project={activeProject} projects={projects} workspace={activeWorkspace} workspaces={state?.workspaces ?? []} skills={skills} selectedSkills={selectedSkills} selectedSkillIds={selectedSkillIds} permissionMode={permissionMode} setPermissionMode={changePermissionMode} onDraftPreviewChange={setDraft} onSubmit={(content, attachments) => void (busy ? sendWhileBusy("queue", content, attachments) : sendMessage(content, { attachments }))} onSteer={(content, attachments) => void sendWhileBusy("steer", content, attachments)} onStop={() => void stopActiveResponse()} onOpenTab={setDrawer} onSelectProject={selectProject} onSelectWorkspace={setActiveWorkspaceId} onSelectSkills={setSelectedSkillIds} />
      {showJumpToLive && selectedChat ? <button className="jump-to-live" aria-label="Jump to live" onClick={() => scrollToLive("smooth")}><IconDownload width={16}/><span>Live</span></button> : null}
    </main>
    {drawer && state ? <Drawer active={drawer} onChangeTab={setDrawer} onClose={() => setDrawer(null)}><DrawerContent tab={drawer} state={state} theme={theme} setTheme={setTheme} textScale={textScale} setTextScale={setTextScale} apiToken={apiToken} setApiToken={(token) => { setApiToken(token); if (token) localStorage.setItem(API_TOKEN_KEY, token); else localStorage.removeItem(API_TOKEN_KEY); }} selectedSkillIds={selectedSkillIds} setSelectedSkillIds={setSelectedSkillIds} activeProjectId={activeProjectId} onSelectProject={selectProject} activeWorkspaceId={activeWorkspaceId} setActiveWorkspaceId={setActiveWorkspaceId} refresh={refreshState} showToast={setToast} clearAllData={clearAllData} onStartGuidedImport={startGuidedImport} /></Drawer> : null}
    {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
    {dialog ? <AppDialogView dialog={dialog} onClose={() => setDialog(null)} onError={(message) => setError(message)} /> : null}
    {toast ? <Toast text={toast} onDone={() => setToast(null)} /> : null}
  </div>;
}

type SidebarProps = { open: boolean; chats: Chat[]; projects: Project[]; selectedChatId: string | null; activeProjectId: string | null; runningChatIds: Set<string>; unreadChatIds: Set<string>; searchQuery: string; owner: string; providerLabel: string; onSearch: (v: string) => void; onSelectChat: (id: string) => void; onNewChat: () => void; onNewProject: () => void; onSelectProject: (id: string | null) => void; onToggleChatFavorite: (chat: Chat) => void; onToggleProjectFavorite: (project: Project) => void; onRenameProject: (project: Project) => void; onDeleteProject: (project: Project) => void; onRenameChat: (c: Chat) => void; onArchiveChat: (c: Chat) => void; onDeleteChat: (c: Chat) => void; onOpenDrawer: (t: Tab) => void };
const Sidebar = React.memo(function Sidebar(p: SidebarProps) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuRef = useDismissablePopup<HTMLDivElement>(Boolean(menuId), () => setMenuId(null));
  const grouped = groupChatsByDate(p.chats.filter((c) => c.title.toLowerCase().includes(p.searchQuery.toLowerCase())));
  function runMenuAction(action: () => void): void { setMenuId(null); action(); }
  return <aside className={`sidebar${p.open ? " open" : ""}`}><button className="sidebar-brand" onClick={() => p.onOpenDrawer("preferences")}><span className="sidebar-brand-mark"><IconCopilot width={22} height={22}/></span><span className="sidebar-brand-text"><strong>CopilotChat</strong><small>{p.providerLabel}</small></span></button><button className="sidebar-new" onClick={p.onNewChat}>New chat <IconPlus width={16}/></button><div className="sidebar-search"><IconSearch/><input aria-label="Search chats" value={p.searchQuery} placeholder="Search chats" onChange={(e) => p.onSearch(e.target.value)} /></div><div className="sidebar-scroll"><div className="sidebar-section-label">Projects</div><button className={`sidebar-row${p.activeProjectId === null ? " active" : ""}`} onClick={() => p.onSelectProject(null)}><span className="sidebar-row-title">General chats</span></button>{sortFavoritesFirst(p.projects).map((project) => <SidebarProjectRow key={project.id} project={project} active={p.activeProjectId === project.id} menuOpen={menuId === `project:${project.id}`} menuRef={menuId === `project:${project.id}` ? menuRef : undefined} onMenu={() => setMenuId(menuId === `project:${project.id}` ? null : `project:${project.id}`)} onSelect={() => p.onSelectProject(project.id)} onToggleFavorite={() => runMenuAction(() => p.onToggleProjectFavorite(project))} onRename={() => runMenuAction(() => p.onRenameProject(project))} onDelete={() => runMenuAction(() => p.onDeleteProject(project))} />)}<button className="sidebar-row manage-projects-row" onClick={p.onNewProject}><span className="sidebar-row-title muted">New project…</span></button>{grouped.length === 0 ? <div className="sidebar-empty">No conversations yet.</div> : grouped.map((g) => <React.Fragment key={g.label}><div className="sidebar-section-label">{g.label}</div>{g.chats.map((chat) => { const running = p.runningChatIds.has(chat.id); const unread = p.unreadChatIds.has(chat.id); return <div key={chat.id} data-chat-id={chat.id} className={`sidebar-row${chat.id === p.selectedChatId ? " active" : ""}${running ? " running" : ""}${unread ? " unread" : ""}`} role="button" tabIndex={0} aria-label={`${chat.title}${running ? " generating" : unread ? " new content" : ""}`} onClick={() => p.onSelectChat(chat.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onSelectChat(chat.id); } }}><span className="sidebar-row-title"><SidebarFlags favorite={chat.favorite}/>{chat.title}</span><span className="sidebar-row-meta">{running ? <span className="chat-indicator running" title="Response in progress" aria-label="Response in progress">Live</span> : unread ? <span className="chat-indicator unread" title="New content" aria-label="New content">New</span> : null}</span><div ref={menuId === `chat:${chat.id}` ? menuRef : undefined} className="menu-wrap" onClick={(e) => e.stopPropagation()}><button aria-label="Chat actions" className="sidebar-row-menu" aria-expanded={menuId === `chat:${chat.id}`} onClick={() => setMenuId(menuId === `chat:${chat.id}` ? null : `chat:${chat.id}`)}><IconMore width={16}/></button>{menuId === `chat:${chat.id}` ? <div className="menu" role="menu" aria-label="Chat actions menu"><button onClick={() => runMenuAction(() => p.onToggleChatFavorite(chat))}>{chat.favorite ? "Unstar" : "Star"}</button><button onClick={() => runMenuAction(() => p.onRenameChat(chat))}>Rename</button><button onClick={() => runMenuAction(() => p.onArchiveChat(chat))}>Archive</button><button className="danger" onClick={() => runMenuAction(() => p.onDeleteChat(chat))}>Delete</button></div> : null}</div></div>; })}</React.Fragment>)}</div><div className="sidebar-footer"><button className="sidebar-row sidebar-preferences-row" onClick={() => p.onOpenDrawer("preferences")}><span className="sidebar-row-title"><IconSettings width={16}/>Preferences</span></button><button className="sidebar-footer-user" onClick={() => p.onOpenDrawer("preferences")}><span className="sidebar-footer-avatar">{p.owner.slice(0,2).toUpperCase()}</span><span className="sidebar-footer-text"><strong>{p.owner}</strong><small>Account</small></span></button></div></aside>;
}, areSidebarPropsEqual);
function areSidebarPropsEqual(previous: SidebarProps, next: SidebarProps): boolean {
  return previous.open === next.open &&
    previous.chats === next.chats &&
    previous.projects === next.projects &&
    previous.selectedChatId === next.selectedChatId &&
    previous.activeProjectId === next.activeProjectId &&
    previous.runningChatIds === next.runningChatIds &&
    previous.unreadChatIds === next.unreadChatIds &&
    previous.searchQuery === next.searchQuery &&
    previous.owner === next.owner &&
    previous.providerLabel === next.providerLabel;
}
function SidebarProjectRow(p: { project: Project; active: boolean; menuOpen: boolean; menuRef?: React.RefObject<HTMLDivElement | null>; onMenu: () => void; onSelect: () => void; onToggleFavorite: () => void; onRename: () => void; onDelete: () => void }) {
  return <div className={`sidebar-row project-row${p.active ? " active" : ""}`} role="button" tabIndex={0} aria-label={p.project.name} onClick={p.onSelect} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onSelect(); } }}><span className="sidebar-row-title"><SidebarFlags favorite={p.project.favorite}/>{p.project.name}</span><span className="sidebar-row-meta"/><div ref={p.menuOpen ? p.menuRef : undefined} className="menu-wrap" onClick={(e) => e.stopPropagation()}><button aria-label="Project actions" className="sidebar-row-menu" aria-expanded={p.menuOpen} onClick={p.onMenu}><IconMore width={16}/></button>{p.menuOpen ? <div className="menu" role="menu" aria-label="Project actions menu"><button onClick={p.onToggleFavorite}>{p.project.favorite ? "Unstar" : "Star"}</button><button onClick={p.onRename}>Rename</button><button className="danger" onClick={p.onDelete}>Delete</button></div> : null}</div></div>;
}
function SidebarFlags(p: { favorite?: boolean }) { return p.favorite ? <span className="sidebar-row-flags"><IconStar width={12} height={12}/></span> : null; }
function Header(p: { chatTitle: string; projectName: string | null; chatFavorite: boolean | null; projectFavorite: boolean | null; provider: ProviderStatus; model: string; models: ProviderStatus["models"]; modelInfo: ProviderModel | null; effort: ReasoningEffort; effortChoices: ReasoningEffort[]; contextTier: ContextTier; context: ContextStatus; busy: boolean; onModelChange: (v: string) => void; onEffortChange: (v: ReasoningEffort) => void; onContextTierChange: (v: ContextTier) => void; onToggleSidebar: () => void; onToggleChatFavorite?: () => void; onToggleProjectFavorite?: () => void; onRenameChat?: () => void; onArchiveChat?: () => void; onDeleteChat?: () => void; onRenameProject?: () => void; onDeleteProject?: () => void; onOpenTab: (t: Tab) => void; onNewChat: () => void; onOpenShortcuts: () => void }) {
  const [showContext, setShowContext] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const contextRef = useDismissablePopup<HTMLDivElement>(showContext, () => setShowContext(false));
  const overflowRef = useDismissablePopup<HTMLDivElement>(showOverflow, () => setShowOverflow(false));
  const hasOverflow = Boolean(p.onToggleChatFavorite || p.onRenameChat || p.onArchiveChat || p.onDeleteChat || p.onToggleProjectFavorite || p.onRenameProject || p.onDeleteProject);
  function run(action?: () => void): void { if (!action) return; setShowOverflow(false); action(); }
  return <header className={`header${p.busy ? " thinking" : ""}`}>
    <div className="header-left">
      <button className="header-pill icon-only" aria-label="Toggle sidebar" onClick={p.onToggleSidebar}><IconMenu/></button>
      {p.projectName ? <button className="header-pill project-pill" aria-label={`Project: ${p.projectName}`} title={p.projectName}><IconFolder width={18}/><span>{p.projectName}</span></button> : null}
    </div>
    <div className="header-controls">
      <ModelPicker model={p.model} models={p.models} modelInfo={p.modelInfo} effort={p.effort} effortChoices={p.effortChoices} contextTier={p.contextTier} onModelChange={p.onModelChange} onEffortChange={p.onEffortChange} onContextTierChange={p.onContextTierChange} />
      <div ref={contextRef} className="context-ring-wrap"><button type="button" className={`context-ring ${p.context.state}`} title={p.context.detail} aria-label={`Context: ${p.context.detail}`} aria-expanded={showContext} aria-controls="context-details" style={{ background: contextRingBackground(p.context) }} onClick={() => setShowContext((value) => !value)}><span>{contextRingLabel(p.context)}</span></button>{showContext ? <div id="context-details" className="context-popover" role="dialog" aria-label="Context details"><strong>Context</strong><span>{p.context.detail}</span><small>{p.context.label}</small></div> : null}</div>
    </div>
    <div className="header-actions">
      <button className="header-pill icon-only shortcut-pill" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" onClick={p.onOpenShortcuts}>?</button>
      {hasOverflow ? <div ref={overflowRef} className="header-overflow"><button className="header-pill icon-only" aria-label="More actions" title="More actions" aria-expanded={showOverflow} onClick={() => setShowOverflow((v) => !v)}><IconMore/></button>{showOverflow ? <div className="menu header-overflow-menu" role="menu" aria-label="Header actions menu">
        {p.onToggleChatFavorite ? <button onClick={() => run(p.onToggleChatFavorite)}>{p.chatFavorite ? "Unstar chat" : "Star chat"}</button> : null}
        {p.onRenameChat ? <button onClick={() => run(p.onRenameChat)}>Rename chat</button> : null}
        {p.onArchiveChat ? <button onClick={() => run(p.onArchiveChat)}>Archive chat</button> : null}
        {p.onDeleteChat ? <button className="danger" onClick={() => run(p.onDeleteChat)}>Delete chat</button> : null}
        {p.onToggleProjectFavorite ? <button onClick={() => run(p.onToggleProjectFavorite)}>{p.projectFavorite ? "Unstar project" : "Star project"}</button> : null}
        {p.onRenameProject ? <button onClick={() => run(p.onRenameProject)}>Rename project</button> : null}
        {p.onDeleteProject ? <button className="danger" onClick={() => run(p.onDeleteProject)}>Delete project</button> : null}
      </div> : null}</div> : null}
    </div>
  </header>;
}
function ModelPicker(p: { model: string; models: ProviderModel[]; modelInfo: ProviderModel | null; effort: ReasoningEffort; effortChoices: ReasoningEffort[]; contextTier: ContextTier; onModelChange: (model: string) => void; onEffortChange: (effort: ReasoningEffort) => void; onContextTierChange: (tier: ContextTier) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissablePopup<HTMLDivElement>(open, () => setOpen(false));
  const selected = p.modelInfo ?? p.models.find((model) => model.id === p.model) ?? null;
  const supportsEffort = p.effortChoices.length > 1;
  const supportsLongContext = Boolean(selected?.supportsLongContext);
  return <div ref={ref} className="model-picker-wrap"><button type="button" className="model-picker-trigger" aria-label={`Model picker: ${selected?.name ?? p.model}`} aria-expanded={open} aria-controls="model-picker" onClick={() => setOpen((value) => !value)}><span className="model-picker-trigger-copy"><small>Model</small><strong>{selected?.name ?? p.model}</strong></span><span className="model-picker-trigger-meta">{modelSelectionSummary(selected, p.effort, p.contextTier)}</span></button>{open ? <div id="model-picker" className="model-picker-popover" role="dialog" aria-label="Model picker"><div className="model-picker-head"><strong>Model</strong><span>Choose a model, then tune the options it supports.</span></div><div className="model-picker-list" role="listbox" aria-label="Available models">{p.models.map((model) => { const active = model.id === p.model; return <button type="button" key={model.id} data-model-id={model.id} className={`model-picker-row${active ? " active" : ""}`} role="option" aria-selected={active} onClick={() => p.onModelChange(model.id)}><span className="model-picker-row-copy"><strong>{model.name || model.id}</strong>{model.name !== model.id ? <small>{model.id}</small> : null}</span><span className="model-picker-row-meta">{modelContextLabel(model)}{model.supportsReasoningEffort ? <em>Effort</em> : null}{model.supportsLongContext ? <em>Long context</em> : null}</span>{active ? <IconCheck width={16} height={16}/> : null}</button>; })}</div><div className="model-picker-options"><strong>Options for {selected?.name ?? p.model}</strong>{supportsEffort ? <label className="model-option-field"><span>Reasoning effort</span><select aria-label="Reasoning effort" value={p.effort} onChange={(e) => p.onEffortChange(e.target.value as ReasoningEffort)}>{p.effortChoices.map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}</select><small>Higher effort can improve complex answers but may take longer.</small></label> : null}{supportsLongContext ? <label className="model-option-field"><span>Context size</span><select aria-label="Context size" value={p.contextTier} onChange={(e) => p.onContextTierChange(e.target.value as ContextTier)}><option value="default">{contextTierLabel("default", selected)}</option><option value="long_context">{contextTierLabel("long_context", selected)}</option></select><small>Long context keeps more material available and may use more credits.</small></label> : null}{!supportsEffort && !supportsLongContext ? <p>This model uses fixed reasoning and context settings.</p> : null}</div></div> : null}</div>;
}
function SetupBanner(p: { details: string; onOpenSettings: () => void }) { return <div className="setup-banner" role="status"><div className="setup-banner-main"><strong>Copilot needs authentication in this terminal.</strong><span>{p.details || "No Copilot provider is available yet."}</span></div><button className="btn btn-sm" onClick={p.onOpenSettings}>Fix setup</button></div>; }
function ErrorBanner(p: { error: string; onDismiss: () => void; onRetry: () => void }) { const error = friendlyError(p.error); return <section className="error-banner" role="alert" aria-live="assertive"><div className="error-banner-copy"><strong>{error.title}</strong><span>{error.message}</span></div><div className="error-banner-actions"><button className="btn btn-sm" onClick={p.onRetry}>{error.action}</button><button className="icon-button" aria-label="Dismiss error" onClick={p.onDismiss}><IconClose/></button></div></section>; }
function AppDialogView(p: { dialog: AppDialog; onClose: () => void; onError: (message: string) => void }) {
  const [value, setValue] = useState(p.dialog.kind === "text" ? p.dialog.initialValue ?? "" : "");
  const [confirmValue, setConfirmValue] = useState("");
  const [working, setWorking] = useState(false);
  const canConfirm = p.dialog.kind === "text" ? value.trim().length > 0 : !p.dialog.requireText || confirmValue === p.dialog.requireText;
  async function confirm(): Promise<void> {
    if (!canConfirm || working) return;
    setWorking(true);
    try {
      if (p.dialog.kind === "text") await p.dialog.onConfirm(value.trim());
      else await p.dialog.onConfirm();
      p.onClose();
    } catch (e) {
      p.onError(toErr(e));
      setWorking(false);
    }
  }
  return <><div className="modal-scrim" onClick={working ? undefined : p.onClose}/><form className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title" onSubmit={(e) => { e.preventDefault(); void confirm(); }}><div className="app-dialog-head"><div><h2 id="app-dialog-title">{p.dialog.title}</h2>{p.dialog.kind === "text" && p.dialog.message ? <p>{p.dialog.message}</p> : p.dialog.kind === "confirm" ? <p>{p.dialog.message}</p> : null}</div><button type="button" className="icon-button" aria-label="Close" disabled={working} onClick={p.onClose}><IconClose/></button></div><div className="app-dialog-body">{p.dialog.kind === "text" ? <FormField label={p.dialog.label}><input autoFocus value={value} placeholder={p.dialog.placeholder} onChange={(e) => setValue(e.target.value)} /></FormField> : p.dialog.requireText ? <FormField label={`Type ${p.dialog.requireText} to confirm`} hint="This extra step protects local data from accidental deletion."><input autoFocus value={confirmValue} onChange={(e) => setConfirmValue(e.target.value)} /></FormField> : null}</div><div className="app-dialog-actions"><button type="button" className="btn" disabled={working} onClick={p.onClose}>Cancel</button><button className={`btn ${p.dialog.kind === "confirm" && p.dialog.danger ? "btn-danger" : "btn-primary"}`} disabled={!canConfirm || working}>{working ? "Working…" : p.dialog.confirmLabel}</button></div></form></>;
}
function ShortcutsDialog(p: { onClose: () => void }) { return <><div className="modal-scrim" onClick={p.onClose}/><section className="app-dialog shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title"><div className="app-dialog-head"><div><h2 id="shortcuts-title">Keyboard shortcuts</h2><p>Fast paths for the local workbench. These never override typing in the composer or form fields.</p></div><button className="icon-button" aria-label="Close" onClick={p.onClose}><IconClose/></button></div><dl className="shortcut-list"><div><dt><kbd>⌘/Ctrl</kbd><kbd>K</kbd></dt><dd>Open this shortcut guide</dd></div><div><dt><kbd>⌘/Ctrl</kbd><kbd>N</kbd></dt><dd>Start a new chat in the current project/workspace</dd></div><div><dt><kbd>⌘/Ctrl</kbd><kbd>,</kbd></dt><dd>Open Preferences</dd></div><div><dt><kbd>⌘/Ctrl</kbd><kbd>B</kbd></dt><dd>Toggle the sidebar</dd></div><div><dt><kbd>?</kbd></dt><dd>Show shortcuts when focus is not in an input</dd></div><div><dt><kbd>Esc</kbd></dt><dd>Close menus, dialogs, and panels</dd></div></dl></section></>; }
function ConfirmButton(p: { className?: string; label: string; confirmLabel?: string; disabled?: boolean; onConfirm: () => void | Promise<void> }) { const [confirming, setConfirming] = useState(false); const [working, setWorking] = useState(false); async function click(): Promise<void> { if (p.disabled || working) return; if (!confirming) { setConfirming(true); window.setTimeout(() => setConfirming(false), 3000); return; } setWorking(true); try { await p.onConfirm(); } finally { setWorking(false); setConfirming(false); } } return <button type="button" className={p.className ?? "btn btn-sm btn-danger"} disabled={p.disabled || working} onClick={() => void click()}>{working ? "Working…" : confirming ? p.confirmLabel ?? "Confirm" : p.label}</button>; }
function FormField(p: { label: string; hint?: string; children: React.ReactElement<{ id?: string; "aria-describedby"?: string }> }) { const id = useMemo(() => `field-${slugify(p.label)}-${Math.random().toString(36).slice(2, 7)}`, [p.label]); const hintId = `${id}-hint`; return <label className="form-field" htmlFor={id}><span>{p.label}</span>{React.cloneElement(p.children, { id, "aria-describedby": p.hint ? hintId : undefined })}{p.hint ? <small id={hintId}>{p.hint}</small> : null}</label>; }
function Welcome(p: { userName: string; project: Project | null; onPrompt: (v: string) => void }) { const name = cleanName(p.userName); return <div className="welcome"><div className="welcome-inner"><div className="welcome-mark"><IconCopilot width={46} height={46}/></div><h1>{p.project ? `Ready in ${p.project.name}` : name ? `Back at it, ${name}` : "Back at it"}</h1><p className="welcome-sub">{p.project ? "Project instructions will be included with every turn in this conversation." : "Start a focused chat, connect tools, or work against a local folder."}</p><div className="welcome-grid">{STARTERS.map(([title, body, prompt]) => <button className="welcome-card" key={title} onClick={() => p.onPrompt(prompt)}><strong>{title}</strong><span>{body}</span><em>Start</em></button>)}</div></div></div>; }
function ProjectHome(p: { project: Project; state: AppState; models: ProviderStatus["models"]; chats: Chat[]; onSelectChat: (id: string) => void; onNewChat: () => void; refresh: () => Promise<void>; showToast: (s: string) => void }) {
  const [editor, setEditor] = useState<ProjectEditorState | null>(null);
  const references = p.state.projectReferences.filter((reference) => reference.projectId === p.project.id);
  const chatReferences = p.state.projectChatReferences.filter((reference) => reference.projectId === p.project.id);
  async function saveEditor(next: ProjectEditorState): Promise<void> {
    if (next.kind === "memory") await api<Project>(`/api/projects/${p.project.id}`, { method: "PATCH", body: { memory: next.value } });
    if (next.kind === "instructions") await api<Project>(`/api/projects/${p.project.id}`, { method: "PATCH", body: { instructions: next.value } });
    if (next.kind === "reference") {
      if (next.referenceId) await api<ProjectReference>(`/api/project-references/${next.referenceId}`, { method: "PATCH", body: { title: next.referenceTitle, content: next.value } });
      else await api<ProjectReference>("/api/project-references", { method: "POST", body: { projectId: p.project.id, title: next.referenceTitle, content: next.value } });
    }
    p.showToast(next.kind === "reference" ? "Reference saved" : "Project context saved");
    setEditor(null);
    await p.refresh();
  }
  async function saveDefaultModel(defaultModel: string): Promise<void> { await api<Project>(`/api/projects/${p.project.id}`, { method: "PATCH", body: { defaultModel: defaultModel || null } }); p.showToast(defaultModel ? "Project default model saved" : "Project default model cleared"); await p.refresh(); }
  return <section className="project-home"><div className="project-title-block"><h1>{p.project.name}</h1></div><div className="project-summary-grid"><ProjectDefaultModelCard project={p.project} models={p.models} onChange={(model) => void saveDefaultModel(model)} /><button className="project-summary-card wide editable" onClick={() => setEditor({ kind: "memory", title: "Edit memory", value: p.project.memory ?? "", placeholder: "Facts and decisions every chat in this project should remember." })}><div className="card-h"><strong>Memory</strong><span className="btn btn-sm">Edit</span></div><p>{previewText(p.project.memory, "No shared memory yet.")}</p></button><button className="project-summary-card editable" onClick={() => setEditor({ kind: "instructions", title: "Edit custom instructions", value: p.project.instructions ?? "", placeholder: "Describe how the assistant should behave for this project." })}><div className="card-h"><strong>Custom instructions</strong><span className="btn btn-sm">Edit</span></div><p>{previewText(p.project.instructions, "No custom instructions yet.")}</p></button></div><section className="project-knowledge-section"><div className="card-h"><h2>Project knowledge</h2><button className="btn btn-sm" onClick={() => setEditor({ kind: "reference", title: "Add reference material", referenceTitle: "", value: "" })}>Add reference</button></div><div className="project-reference-list">{references.length === 0 ? <p className="section-help">No reference materials yet.</p> : references.map((reference) => <div className="mini-card" key={reference.id}><strong>{reference.title}</strong><p>{reference.content.slice(0,180)}</p><div className="card-actions"><button className="btn btn-sm" onClick={() => setEditor({ kind: "reference", title: "Edit reference material", referenceId: reference.id, referenceTitle: reference.title, value: reference.content })}>Edit</button><button className="btn btn-sm btn-danger" onClick={async()=>{await api<void>(`/api/project-references/${reference.id}`,{method:"DELETE",raw:true}); await p.refresh();}}>Remove</button></div></div>)}</div><ProjectChatReferences project={p.project} state={p.state} refresh={p.refresh} showToast={p.showToast}/>{chatReferences.length > 0 ? <p className="section-help">{chatReferences.length} referenced chat {chatReferences.length === 1 ? "excerpt" : "excerpts"}</p> : null}</section><section className="recent-chats"><div className="card-h"><h2>Recent chats</h2><button className="btn btn-sm btn-primary" onClick={p.onNewChat}><IconPlus width={14}/>Start a new chat</button></div>{p.chats.length === 0 ? <p className="section-help">No chats in this project yet.</p> : <div className="recent-chat-list">{p.chats.map((chat) => <button key={chat.id} className="recent-chat-row" onClick={() => p.onSelectChat(chat.id)}><strong>{chat.title}</strong><span>{formatProjectDate(chat.updatedAt)}</span></button>)}</div>}</section>{editor ? <ProjectEditorModal editor={editor} onClose={() => setEditor(null)} onSave={(next) => void saveEditor(next)} /> : null}</section>;
}
function ProjectDefaultModelCard(p: { project: Project; models: ProviderStatus["models"]; onChange: (model: string) => void }) { return <div className="project-summary-card project-model-card"><div className="card-h"><strong>Default model</strong><span className="tag">{p.project.defaultModel ? "Project" : "App default"}</span></div><p>New chats in this project start with this model unless the chat is changed later.</p><select aria-label="Project default model" value={p.project.defaultModel ?? ""} onChange={(e) => p.onChange(e.currentTarget.value)}><option value="">Use app default</option>{p.models.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select></div>; }
function ProjectEditorModal(p: { editor: ProjectEditorState; onClose: () => void; onSave: (next: ProjectEditorState) => void }) {
  const [value, setValue] = useState(p.editor.value);
  const [referenceTitle, setReferenceTitle] = useState(p.editor.kind === "reference" ? p.editor.referenceTitle : "");
  useEffect(() => { setValue(p.editor.value); setReferenceTitle(p.editor.kind === "reference" ? p.editor.referenceTitle : ""); }, [p.editor]);
  function save(): void { if (p.editor.kind === "reference") p.onSave({ ...p.editor, referenceTitle, value }); else p.onSave({ ...p.editor, value }); }
  return <><div className="modal-scrim" onClick={p.onClose}/><section className="editor-modal" role="dialog" aria-label={p.editor.title}><div className="drawer-head"><div><h2>{p.editor.title}</h2><p>Make changes in a larger editor, then save them into project context.</p></div><button className="icon-button" aria-label="Close editor" onClick={p.onClose}><IconClose/></button></div><div className="editor-modal-body">{p.editor.kind === "reference" ? <><label>Reference title</label><input aria-label="Reference title" value={referenceTitle} onChange={(e) => setReferenceTitle(e.target.value)} /></> : null}<label>{p.editor.kind === "memory" ? "Memory" : p.editor.kind === "instructions" ? "Instructions" : "Reference content"}</label><textarea aria-label="Project context editor" value={value} placeholder={p.editor.kind === "reference" ? "Paste source material every chat should see." : p.editor.placeholder} onChange={(e) => setValue(e.target.value)} autoFocus /></div><div className="editor-modal-actions"><button className="btn" onClick={p.onClose}>Cancel</button><button className="btn btn-primary" disabled={p.editor.kind === "reference" ? !referenceTitle.trim() || !value.trim() : false} onClick={save}>Save changes</button></div></section></>;
}
const Markdown = React.memo(function Markdown(p: { children: string }) { const parts = useMemo(() => splitMarkdownTaskLists(p.children), [p.children]); if (parts.length === 1 && parts[0]?.kind === "markdown") return <MarkdownText>{p.children}</MarkdownText>; return <>{parts.map((part, index) => part.kind === "tasks" ? <TaskListCard key={index} items={part.items} /> : <MarkdownText key={index}>{part.content}</MarkdownText>)}</>; });
const MarkdownText = React.memo(function MarkdownText(p: { children: string }) { return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={markdownComponents}>{p.children}</ReactMarkdown>; });
function DateBarrier(p: { value: string }) { return <time className="date-barrier" dateTime={messageDayKey(p.value)} title={formatMessageDateTime(p.value)}><span>{formatMessageDateBarrier(p.value)}</span></time>; }
function MessageTime(p: { value: string }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissablePopup<HTMLSpanElement>(open, () => setOpen(false));
  const shortTime = formatMessageTime(p.value);
  const fullTime = formatMessageDateTime(p.value);
  return <span ref={ref} className="msg-time-wrap"><time className="msg-time" dateTime={p.value} title={fullTime} role="button" tabIndex={0} aria-expanded={open} aria-label={`Message time: ${shortTime}. Show full date and time.`} onClick={() => setOpen((value) => !value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((value) => !value); } }}>{shortTime}</time>{open ? <span className="msg-time-popover" role="tooltip"><time dateTime={p.value}>{fullTime}</time></span> : null}</span>;
}
const Message = React.memo(function Message(p: MessageProps) {
  const isUser = p.message.role === "user";
  const activities = !isUser ? (p.activities ?? readActivities(p.message.metadata.activities)) : [];
  const attachments = messageAttachments(p.message);
  const intent = p.streaming ? currentReportIntent(activities) : null;
  const actions = !p.streaming ? <div className="msg-actions"><button aria-label={isUser ? "Copy message" : "Copy response"} title="Copy" className="msg-action-button" onClick={() => void copyText(p.message.content)}><IconCopy width={18}/></button>{isUser ? <button aria-label="Edit message" title="Edit" className="msg-action-button" disabled={!p.canEdit} onClick={() => p.onEditStart?.(p.message)}><IconEdit width={18}/></button> : <button aria-label="Retry response" title="Retry" className="msg-action-button" disabled={!p.canRetry} onClick={() => p.onRetry?.(p.message)}><IconRetry width={18}/></button>}</div> : null;
  return <article className={`msg ${isUser ? "user" : "assistant"}`}><span className="msg-avatar">{isUser ? "You" : <IconCopilot width={18} height={18}/>}</span><div className="msg-body">{p.editing ? <form className="edit-message-form" onSubmit={(e) => { e.preventDefault(); p.onEditSave?.(p.message, p.editValue ?? ""); }}><textarea aria-label="Edit message" value={p.editValue ?? ""} rows={4} onChange={(e) => p.onEditChange?.(e.target.value)} autoFocus/><div className="msg-actions"><button aria-label="Save and continue" title="Save and continue" className="msg-action-button primary" disabled={!p.editValue?.trim() && attachments.length === 0}><IconCheck width={18}/></button><button type="button" aria-label="Cancel edit" title="Cancel" className="msg-action-button" onClick={p.onEditCancel}><IconClose width={18}/></button></div></form> : <>{activities.length > 0 ? <ActivityList activities={activities} streaming={Boolean(p.streaming)} /> : null}{attachments.length > 0 ? <AttachmentTray attachments={attachments} /> : null}{p.message.content ? <Markdown>{p.message.content}</Markdown> : null}{p.streaming ? <StreamingCursor intent={intent}/> : null}</>}</div><div className="msg-meta"><MessageTime value={p.message.createdAt} />{!p.editing ? actions : null}</div></article>;
}, areMessagePropsEqual);
function areMessagePropsEqual(prev: Readonly<MessageProps>, next: Readonly<MessageProps>): boolean {
  return prev.message === next.message &&
    prev.streaming === next.streaming &&
    prev.activities === next.activities &&
    prev.editing === next.editing &&
    prev.editValue === next.editValue &&
    prev.canEdit === next.canEdit &&
    prev.canRetry === next.canRetry;
}
function PendingTurns(p: { turns: PendingTurn[] }) { const visible = p.turns.filter((turn) => turn.status !== "done"); if (visible.length === 0) return null; return <div className="pending-turns">{visible.map((turn) => <article key={turn.id} className={`pending-turn ${turn.mode} ${turn.status}`}><span className="pending-label">{turn.mode === "steer" ? "Steer" : "Queued"}</span><span className="pending-content">{turn.content}</span><span className="pending-status">{turn.status === "running" ? "Running next" : turn.status === "sent" ? "Sent live" : turn.status}</span></article>)}</div>; }
const markdownComponents: Components = { pre: ({ children }) => <CodeBlock>{children}</CodeBlock>, a: (props) => <MarkdownLink {...props} /> };
function MarkdownLink(props: React.ComponentPropsWithoutRef<"a"> & { node?: unknown }) { const anchor: React.ComponentPropsWithoutRef<"a"> & { node?: unknown } = { ...props }; delete anchor.node; return <a {...anchor} {...externalLinkProps(props.href)} />; }
function CodeBlock(p: { children?: React.ReactNode }) { const code = textFromNode(p.children).replace(/\n$/, ""); return <div className="code-block"><button type="button" className="code-copy" aria-label="Copy code block" title="Copy code" onClick={() => void copyText(code)}><IconCopy width={15}/></button><pre>{p.children}</pre></div>; }
type MarkdownTaskPart = { kind: "markdown"; content: string } | { kind: "tasks"; items: TaskListItem[] };
function splitMarkdownTaskLists(markdown: string): MarkdownTaskPart[] {
  const parts: MarkdownTaskPart[] = [];
  const markdownLines: string[] = [];
  let taskItems: TaskListItem[] = [];
  function flushMarkdown(): void { const content = markdownLines.join("\n"); if (content.trim()) parts.push({ kind: "markdown", content }); markdownLines.length = 0; }
  function flushTasks(): void { if (taskItems.length) parts.push({ kind: "tasks", items: taskItems }); taskItems = []; }
  for (const line of markdown.split(/\r?\n/)) {
    const item = parseTaskListLine(line);
    if (item) { flushMarkdown(); taskItems.push(item); }
    else { flushTasks(); markdownLines.push(line); }
  }
  flushTasks();
  flushMarkdown();
  return parts.length ? parts : [{ kind: "markdown", content: markdown }];
}
function parseTaskListItems(markdown: string): TaskListItem[] { return markdown.split(/\r?\n/).map(parseTaskListLine).filter((item): item is TaskListItem => Boolean(item)); }
function parseTaskListLine(line: string): TaskListItem | null { const match = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line); if (!match) return null; return { title: match[3]?.trim() || "Untitled task", completed: match[2]?.toLowerCase() === "x", depth: Math.floor((match[1] ?? "").replace(/\t/g, "  ").length / 2) }; }
function TaskListCard(p: { items: TaskListItem[]; title?: string; source?: string }) { const total = p.items.length; const completed = p.items.filter((item) => item.completed).length; const percent = total ? Math.round((completed / total) * 100) : 0; return <details className="task-list-card" aria-label={p.title ?? "Task list"} open><summary className="task-list-summary"><div className="task-list-head"><div><strong>{p.title ?? "Task list"}</strong>{p.source ? <span>{p.source}</span> : null}</div><span>{completed}/{total} complete</span></div><div className="task-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${percent}% complete`}><span style={{ transform: `scaleX(${percent / 100})` }} /></div></summary><div className="task-list-items">{p.items.map((item, index) => <div key={`${item.title}-${index}`} className={`task-list-row${item.completed ? " done" : ""}`} style={{ paddingLeft: `${Math.min(item.depth ?? 0, 4) * 18}px` }}><input type="checkbox" checked={item.completed} readOnly tabIndex={-1} aria-label={item.completed ? "Completed task" : "Incomplete task"} /><div className="task-list-label"><MarkdownText>{item.title}</MarkdownText></div></div>)}</div></details>; }
const TOOL_GROUP_THRESHOLD = 4;
type ActivityListEntry = { kind: "activity"; activity: AssistantActivity } | { kind: "tool-group"; id: string; activities: AssistantActivity[] };
function ActivityList(p: { activities: AssistantActivity[]; streaming: boolean; nested?: boolean }) {
  const activities = p.activities.filter((activity) => !isReportIntentActivity(activity));
  if (activities.length === 0) return null;
  return <div className={`activity-list${p.nested ? " nested" : ""}`}>{groupToolActivities(activities).map((entry) => entry.kind === "tool-group" ? <ToolCallGroup key={entry.id} activities={entry.activities} /> : <ActivityCard key={entry.activity.id} activity={entry.activity} streaming={p.streaming} />)}</div>;
}
function groupToolActivities(activities: AssistantActivity[]): ActivityListEntry[] {
  const entries: ActivityListEntry[] = [];
  let tools: AssistantActivity[] = [];
  const flushTools = () => {
    if (tools.length >= TOOL_GROUP_THRESHOLD) entries.push({ kind: "tool-group", id: `tools-${tools[0]?.id ?? "start"}-${tools[tools.length - 1]?.id ?? "end"}`, activities: tools });
    else entries.push(...tools.map((activity) => ({ kind: "activity" as const, activity })));
    tools = [];
  };
  for (const activity of activities) {
    if (activity.type === "tool") tools.push(activity);
    else { flushTools(); entries.push({ kind: "activity", activity }); }
  }
  flushTools();
  return entries;
}
function ActivityCard(p: { activity: AssistantActivity; streaming: boolean }) {
  const activity = p.activity;
  if (activity.type === "task-list") return <TaskListActivity activity={activity} />;
  return <details className={`activity-card ${activity.type} ${activity.status}`} open={activity.type === "reasoning" && (p.streaming || activity.status === "running")}><summary><span className="activity-icon">{activityIcon(activity.type)}</span><span className="activity-title">{activity.type === "reasoning" ? "Thinking" : activity.title}</span><span className={`activity-status ${activity.status}`}>{activityStatusLabel(activity.status)}</span></summary><div className="activity-body">{activity.type === "reasoning" ? <Markdown>{activity.content?.trim() || "Thinking…"}</Markdown> : activity.type === "subagent" ? <SubagentActivity activity={activity} /> : <ToolActivity activity={activity}/>}</div></details>;
}
function ToolCallGroup(p: { activities: AssistantActivity[] }) {
  const counts = toolActivityCounts(p.activities);
  return <details className={`activity-card tool-group ${counts.status}`}><summary><span className="activity-icon"><IconTerminal width={13}/></span><span className="tool-group-heading"><span className="activity-title">{p.activities.length} tool calls</span><span className="tool-kind-summary">{toolKindCountLabel(p.activities)}</span></span><span className={`activity-status activity-status-summary ${counts.status}`}>{toolActivityCountLabel(counts)}</span></summary><div className="activity-body"><div className="activity-list nested tool-group-list">{p.activities.map((activity) => <ActivityCard key={activity.id} activity={activity} streaming={false} />)}</div></div></details>;
}
function toolActivityCounts(activities: AssistantActivity[]): { status: AssistantActivity["status"]; succeeded: number; failed: number; running: number } {
  const counts = { status: "succeeded" as AssistantActivity["status"], succeeded: 0, failed: 0, running: 0 };
  for (const activity of activities) {
    if (activity.status === "failed") counts.failed += 1;
    else if (activity.status === "running") counts.running += 1;
    else counts.succeeded += 1;
  }
  counts.status = counts.failed > 0 ? "failed" : counts.running > 0 ? "running" : "succeeded";
  return counts;
}
function toolActivityCountLabel(counts: { succeeded: number; failed: number; running: number }): string {
  return [
    counts.succeeded ? `${counts.succeeded} succeeded` : "",
    counts.failed ? `${counts.failed} failed` : "",
    counts.running ? `${counts.running} running` : "",
  ].filter(Boolean).join(" · ");
}
function toolKindCountLabel(activities: AssistantActivity[]): string {
  const counts = new Map<string, number>();
  for (const activity of activities) counts.set(activity.title, (counts.get(activity.title) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([name, count]) => `${name} ×${count}`).join(" · ");
}
function activityStatusLabel(status: AssistantActivity["status"]): string { return status === "running" ? "Running" : status === "failed" ? "Failed" : "Done"; }
function activityIcon(type: AssistantActivity["type"]): React.ReactNode { if (type === "reasoning") return <IconSparkle width={14}/>; if (type === "subagent") return <IconCopilot width={14} height={14}/>; if (type === "task-list") return <IconCheck width={13}/>; return <IconTerminal width={13}/>; }
function StreamingCursor(p: { intent?: string | null }) { return <span className={`cursor-wrap${p.intent ? " with-intent" : ""}`} role={p.intent ? "status" : undefined} aria-live={p.intent ? "polite" : undefined} aria-label={p.intent ? `Agent status: ${p.intent}` : undefined}><span className="cursor" aria-hidden="true"/>{p.intent ? <span className="cursor-intent"><span className="cursor-sparkles" aria-hidden="true"><IconSparkle width={12}/><span/><span/></span><span>{p.intent}</span></span> : null}</span>; }
function isReportIntentActivity(activity: AssistantActivity): boolean { return activity.type === "tool" && activity.title === "report_intent"; }
function currentReportIntent(activities: AssistantActivity[]): string | null { const activity = [...activities].reverse().find(isReportIntentActivity); return activity ? reportIntentLabel(activity) : null; }
function reportIntentLabel(activity: AssistantActivity): string {
  const input = isObjectRecord(activity.input) ? activity.input : null;
  const output = isObjectRecord(activity.output) ? activity.output : null;
  return readNonEmptyString(input?.intent)
    ?? readNonEmptyString(output?.detailedContent)
    ?? (readNonEmptyString(output?.content) === "Intent logged" ? null : readNonEmptyString(output?.content))
    ?? "Working";
}
function readNonEmptyString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function ToolActivity(p: { activity: AssistantActivity }) { return <div className="tool-activity">{p.activity.input !== undefined && p.activity.input !== null ? <ToolValueSection label="Input" value={p.activity.input} /> : null}{p.activity.output !== undefined && p.activity.output !== null ? <ToolValueSection label="Result" value={p.activity.output} /> : null}{p.activity.error ? <ToolValueSection label="Error" value={p.activity.error} /> : null}{p.activity.input === undefined && p.activity.output === undefined && !p.activity.error ? <p>Tool is running…</p> : null}</div>; }
function ToolValueSection(p: { label: string; value: unknown }) { const structured = structuredActivityValue(p.value); return <div><strong>{p.label}</strong>{structured ? <StructuredActivityValue value={structured.value} raw={p.value} /> : <CodeBlock><code>{formatActivityValue(p.value)}</code></CodeBlock>}</div>; }
function StructuredActivityValue(p: { value: Record<string, unknown> | unknown[]; raw: unknown }) { return <div className="structured-activity-value">{renderStructuredValue(p.value)}<details className="activity-raw"><summary>Raw JSON</summary><CodeBlock><code>{formatActivityValue(p.raw)}</code></CodeBlock></details></div>; }
function renderStructuredValue(value: unknown, depth = 0): React.ReactNode {
  if (Array.isArray(value)) return <dl className="structured-fields structured-array">{value.length === 0 ? <div className="structured-empty">No items</div> : value.slice(0, 12).map((item, index) => <div key={index} className="structured-field"><dt>Item {index + 1}</dt><dd>{renderStructuredFieldValue(item, depth)}</dd></div>)}{value.length > 12 ? <div className="structured-more">+{value.length - 12} more</div> : null}</dl>;
  if (isObjectRecord(value)) { const entries = Object.entries(value); return <dl className="structured-fields">{entries.length === 0 ? <div className="structured-empty">No fields</div> : entries.slice(0, 16).map(([key, item]) => <div key={key} className="structured-field"><dt>{humanizeFieldName(key)}</dt><dd>{renderStructuredFieldValue(item, depth)}</dd></div>)}{entries.length > 16 ? <div className="structured-more">+{entries.length - 16} more fields</div> : null}</dl>; }
  return renderStructuredScalar(value);
}
function renderStructuredFieldValue(value: unknown, depth: number): React.ReactNode {
  if ((Array.isArray(value) || isObjectRecord(value)) && depth < 1) return renderStructuredValue(value, depth + 1);
  if (Array.isArray(value)) return <span className="structured-scalar">{value.length} items</span>;
  if (isObjectRecord(value)) return <span className="structured-scalar">{Object.keys(value).length} fields</span>;
  return renderStructuredScalar(value);
}
function renderStructuredScalar(value: unknown): React.ReactNode {
  if (value === null) return <span className="structured-scalar muted">null</span>;
  if (typeof value === "boolean") return <span className={`structured-scalar boolean ${value ? "true" : "false"}`}>{String(value)}</span>;
  if (typeof value === "number") return <span className="structured-scalar number">{String(value)}</span>;
  if (typeof value === "string") return <span className="structured-scalar string">{value || "empty string"}</span>;
  if (typeof value === "bigint") return <span className="structured-scalar number">{value.toString()}</span>;
  if (typeof value === "undefined") return <span className="structured-scalar muted">undefined</span>;
  if (typeof value === "symbol") return <span className="structured-scalar">{value.description ?? "symbol"}</span>;
  return <span className="structured-scalar">{formatActivityValue(value)}</span>;
}
function structuredActivityValue(value: unknown): { value: Record<string, unknown> | unknown[] } | null {
  if (Array.isArray(value) || isObjectRecord(value)) return { value };
  if (typeof value !== "string") return null;
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) || isObjectRecord(parsed) ? { value: parsed } : null;
}
function parseJsonValue(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}
function humanizeFieldName(value: string): string { return value.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/\b\w/g, (char) => char.toUpperCase()); }
function SubagentActivity(p: { activity: AssistantActivity }) { const detail = p.activity.details && Object.keys(p.activity.details).length > 0 ? formatActivityValue(p.activity.details) : ""; return <div className="subagent-activity">{detail ? <pre className="subagent-detail">{detail}</pre> : null}{p.activity.content?.trim() ? <Markdown>{p.activity.content}</Markdown> : null}{p.activity.error ? <div><strong>Error</strong><CodeBlock><code>{p.activity.error}</code></CodeBlock></div> : null}{p.activity.steps?.length ? <ActivityList activities={p.activity.steps} streaming={false} nested /> : null}{!detail && !p.activity.content && !p.activity.error && !p.activity.steps?.length ? <p>Subagent is running…</p> : null}</div>; }
function TaskListActivity(p: { activity: AssistantActivity }) { const items = p.activity.items?.length ? p.activity.items : parseTaskListItems(p.activity.content ?? ""); return items.length ? <TaskListCard title={p.activity.title} items={items} source={typeof p.activity.details?.source === "string" ? p.activity.details.source : undefined} /> : <Markdown>{p.activity.content ?? ""}</Markdown>; }
function InteractionDock(p: { interactions: PendingInteraction[]; onResolve: (interaction: PendingInteraction, resolution: { action: string; answer?: string; wasFreeform?: boolean; content?: unknown }) => void }) {
  if (p.interactions.length === 0) return null;
  return <div className="interaction-dock" aria-label="Agent requests">{p.interactions.map((interaction) => <InteractionCard key={interaction.id} interaction={interaction} onResolve={(resolution) => p.onResolve(interaction, resolution)} />)}</div>;
}
function InteractionCard(p: { interaction: PendingInteraction; onResolve: (resolution: { action: string; answer?: string; wasFreeform?: boolean; content?: unknown }) => void }) {
  const [answer, setAnswer] = useState("");
  const [jsonContent, setJsonContent] = useState("{}");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const detail = interactionDetail(p.interaction);
  function submitJson(): void {
    const parsed = parseJsonForUser(jsonContent);
    if (!parsed.ok) { setJsonError(parsed.error); return; }
    p.onResolve({ action: "accept", content: parsed.value });
  }
  return <section className={`interaction-card ${p.interaction.kind}`}><div className="interaction-head"><span className="activity-icon">{p.interaction.kind === "permission" ? <IconTerminal width={14}/> : <IconSparkle width={14}/>}</span><div><strong>{p.interaction.title}</strong><p>{p.interaction.message}</p>{p.interaction.kind === "permission" ? <small>Review the exact scope below. Allow once applies only to this request.</small> : null}</div></div>{detail ? <pre className="interaction-detail">{detail}</pre> : null}{p.interaction.kind === "permission" ? <div className="card-actions"><button className="btn btn-sm btn-primary" onClick={() => p.onResolve({ action: "approve" })}>Allow once</button><button className="btn btn-sm btn-danger" onClick={() => p.onResolve({ action: "deny" })}>Deny</button></div> : null}{p.interaction.kind === "user-input" ? <div className="interaction-form">{p.interaction.choices?.length ? <div className="choice-row">{p.interaction.choices.map((choice) => <button key={choice} className="btn btn-sm" onClick={() => p.onResolve({ action: "submit", answer: choice, wasFreeform: false })}>{choice}</button>)}</div> : null}{p.interaction.allowFreeform !== false ? <form className="row" onSubmit={(e) => { e.preventDefault(); p.onResolve({ action: "submit", answer, wasFreeform: true }); }}><input aria-label="Agent answer" placeholder="Answer the agent" value={answer} onChange={(e) => setAnswer(e.target.value)} /><button className="btn btn-sm btn-primary" disabled={!answer.trim()}>Send</button></form> : null}<button className="btn btn-sm btn-ghost" onClick={() => p.onResolve({ action: "cancel", answer: "", wasFreeform: true })}>Cancel</button></div> : null}{p.interaction.kind === "elicitation" ? <form className="interaction-form" onSubmit={(e) => { e.preventDefault(); submitJson(); }}><FormField label="Structured response" hint="Must be valid JSON. The agent supplied the requested schema above."><textarea rows={4} value={jsonContent} onChange={(e) => { setJsonContent(e.target.value); setJsonError(null); }} /></FormField>{jsonError ? <p className="field-error">{jsonError}</p> : null}<div className="card-actions"><button className="btn btn-sm btn-primary">Submit</button><button type="button" className="btn btn-sm" onClick={() => p.onResolve({ action: "decline" })}>Decline</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => p.onResolve({ action: "cancel" })}>Cancel</button></div></form> : null}</section>;
}
function Thinking() { return <article className="msg assistant"><span className="msg-avatar"><IconCopilot width={18} height={18}/></span><div className="msg-body"><StreamingCursor /></div></article>; }
function RunningActionButton(p: { label: string; tooltip: string; icon: React.ReactNode; variant?: "primary" | "danger"; disabled?: boolean; onClick: () => void }) {
  const [showLongPressTooltip, setShowLongPressTooltip] = useState(false);
  const longPressTimerRef = useRef<number | null>(null);
  const hideTooltipTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  useEffect(() => () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    if (hideTooltipTimerRef.current !== null) window.clearTimeout(hideTooltipTimerRef.current);
  }, []);
  function clearLongPressTimer(): void {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }
  function hideLongPressTooltip(delay = 700): void {
    if (hideTooltipTimerRef.current !== null) window.clearTimeout(hideTooltipTimerRef.current);
    hideTooltipTimerRef.current = window.setTimeout(() => setShowLongPressTooltip(false), delay);
  }
  function startLongPress(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.pointerType === "mouse" || p.disabled) return;
    clearLongPressTimer();
    if (hideTooltipTimerRef.current !== null) window.clearTimeout(hideTooltipTimerRef.current);
    longPressTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = true;
      setShowLongPressTooltip(true);
    }, 450);
  }
  function finishLongPress(): void {
    clearLongPressTimer();
    if (showLongPressTooltip) hideLongPressTooltip();
  }
  function click(event: React.MouseEvent<HTMLButtonElement>): void {
    if (suppressClickRef.current && event.detail > 0) {
      event.preventDefault();
      suppressClickRef.current = false;
      return;
    }
    suppressClickRef.current = false;
    p.onClick();
  }
  return <button type="button" aria-label={p.label} className={`composer-running-button ${p.variant ?? "primary"}${showLongPressTooltip ? " show-tooltip" : ""}`} disabled={p.disabled} onClick={click} onPointerDown={startLongPress} onPointerUp={finishLongPress} onPointerCancel={finishLongPress} onPointerLeave={finishLongPress}><span className="running-button-icon">{p.icon}</span><span className="running-button-label">{p.label.replace(" response", "").replace(" message", "")}</span><span className="composer-action-tooltip" role="tooltip"><strong>{p.label}</strong><span>{p.tooltip}</span></span></button>;
}
type ComposerPicker = "menu" | "project" | "skills" | "workspace" | "permissions";
const Composer = React.forwardRef<ComposerHandle, { busy: boolean; project: Project | null; projects: Project[]; workspace: Workspace | null; workspaces: Workspace[]; skills: Skill[]; selectedSkills: Skill[]; selectedSkillIds: string[]; permissionMode: PermissionMode; setPermissionMode: (mode: PermissionMode) => void; onDraftPreviewChange: (v: string) => void; onSubmit: (content: string, attachments: MessageAttachment[]) => void; onSteer: (content: string, attachments: MessageAttachment[]) => void; onStop: () => void; onOpenTab: (t: Tab) => void; onSelectProject: (id: string | null) => void; onSelectWorkspace: (id: string | null) => void; onSelectSkills: (ids: string[]) => void }>(function Composer(p, ref) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [openPicker, setOpenPicker] = useState<ComposerPicker | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const pickerRef = useDismissablePopup<HTMLDivElement>(Boolean(openPicker), () => setOpenPicker(null));
  const slashQuery = slashCommandQuery(value);
  const slashCommands = useMemo(() => buildSlashCommands(p.skills), [p.skills]);
  const slashMatches = useMemo(() => slashQuery === null ? [] : slashCommands.filter((command) => command.command.includes(slashQuery) || command.title.toLowerCase().includes(slashQuery)).slice(0, 8), [slashCommands, slashQuery]);
  const showSlashCommands = slashQuery !== null && slashMatches.length > 0;
  useEffect(() => resizeComposerTextarea(textareaRef.current), [value]);
  useEffect(() => { const id = window.setTimeout(() => p.onDraftPreviewChange(value), 140); return () => window.clearTimeout(id); }, [p, value]);
  React.useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus(), setValue: (next) => { setValue(next); p.onDraftPreviewChange(next); }, clear: () => { setValue(""); setAttachments([]); setAttachmentError(null); p.onDraftPreviewChange(""); } }), [p]);
  useEffect(() => { setSlashIndex(0); }, [slashQuery, slashMatches.length]);
  function setTextareaRef(node: HTMLTextAreaElement | null): void { textareaRef.current = node; }
  function choosePermissionMode(mode: PermissionMode): void { p.setPermissionMode(mode); setOpenPicker(null); }
  function togglePicker(next: ComposerPicker): void { setOpenPicker((current) => current === next ? null : next); }
  function chooseProject(id: string | null): void { p.onSelectProject(id); setOpenPicker(null); }
  function chooseWorkspace(id: string | null): void { p.onSelectWorkspace(id); setOpenPicker(null); }
  function toggleSkill(id: string): void { p.onSelectSkills(p.selectedSkillIds.includes(id) ? p.selectedSkillIds.filter((skillId) => skillId !== id) : [...p.selectedSkillIds, id]); }
  function openNestedPicker(next: ComposerPicker): void { setOpenPicker(next); }
  function updateValue(next: string): void { setValue(next); }
  function clearValue(): void { setValue(""); setAttachments([]); setAttachmentError(null); p.onDraftPreviewChange(""); }
  async function addFiles(files: FileList | File[]): Promise<void> {
    setAttachmentError(null);
    const nextFiles = [...files];
    try {
      setAttachments([...attachments, ...(await Promise.all(nextFiles.map(fileToAttachment)))]);
    } catch (e) {
      setAttachmentError(toErr(e));
    }
  }
  function removeAttachment(id: string): void { setAttachments((current) => current.filter((attachment) => attachment.id !== id)); }
  function paste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const files = [...e.clipboardData.files];
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }
  function chooseSlash(command: SlashCommand): void { updateValue(command.body); p.onDraftPreviewChange(command.body); textareaRef.current?.focus(); }
  function keyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    const submitOnEnter = e.key === "Enter" && !e.shiftKey && !isMobileViewport();
    if (showSlashCommands) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex((index) => (index + 1) % slashMatches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIndex((index) => (index - 1 + slashMatches.length) % slashMatches.length); return; }
      if (e.key === "Tab" || submitOnEnter) { e.preventDefault(); const command = slashMatches[slashIndex]; if (command) chooseSlash(command); return; }
      if (e.key === "Escape") { e.preventDefault(); clearValue(); return; }
    }
    if (submitOnEnter) { e.preventDefault(); submitMessage(); }
  }
  function submitSteer(): void { const content = value.trim(); if (!content && attachments.length === 0) return; const submittedAttachments = attachments; clearValue(); p.onSteer(content, submittedAttachments); }
  function submitMessage(): void { const content = value.trim(); if (!content && attachments.length === 0) return; const submittedAttachments = attachments; clearValue(); p.onSubmit(content, submittedAttachments); }
  return <div className="composer-shell"><form className="composer" onSubmit={(e) => { e.preventDefault(); submitMessage(); }}>{showSlashCommands ? <div className="slash-command-menu" role="listbox" aria-label="Slash commands">{slashMatches.map((command, index) => <button key={command.command} type="button" role="option" aria-selected={index === slashIndex} className={`slash-command-option${index === slashIndex ? " selected" : ""}`} onMouseEnter={() => setSlashIndex(index)} onClick={() => chooseSlash(command)}><span className="slash-command-name">/{command.command}</span><span className="slash-command-copy"><strong>{command.title}</strong><small>{command.description}</small></span></button>)}</div> : null}{attachments.length > 0 ? <AttachmentTray attachments={attachments} onRemove={removeAttachment} /> : null}{attachmentError ? <p className="attachment-error">{attachmentError}</p> : null}  <div ref={pickerRef} className="composer-input-row"><input ref={fileInputRef} type="file" multiple aria-label="Attach files" style={{display:"none"}} onChange={(e)=>{const files=e.currentTarget.files;if(files)void addFiles(files);e.currentTarget.value="";}}/><button type="button" aria-label="Open composer options" title="Add context or attachments" aria-expanded={openPicker === "menu"} className="composer-plus-button" onClick={() => togglePicker("menu")}><IconPlus width={16}/></button>{p.project ? <button type="button" className="composer-active-chip" aria-label={`Project: ${p.project.name}`} title={p.project.name} onClick={() => togglePicker("project")}><IconFolder width={15}/></button> : null}{p.permissionMode === "yolo" ? <button type="button" className="composer-active-chip danger" aria-label="Tool auto-approval is on" title="Tool auto-approval is on" onClick={() => togglePicker("permissions")}><IconPlug width={15}/></button> : null}<textarea ref={setTextareaRef} aria-label={p.busy ? "Steer or queue a follow-up" : "Message composer"} value={value} placeholder={p.busy ? "Steer or queue a follow-up" : "Ask CopilotChat"} rows={1} onChange={(e) => { updateValue(e.target.value); resizeComposerTextarea(e.currentTarget); }} onKeyDown={keyDown} onPaste={paste}/>{p.busy ? <div className="composer-running-actions"><RunningActionButton label="Steer response" tooltip="Send this text and any attachments into the response that is currently running." icon={<IconSend width={15}/>} disabled={!value.trim() && attachments.length === 0} onClick={submitSteer} /><RunningActionButton label="Queue message" tooltip="Run this text and any attachments as the next user message after the current response finishes." icon={<IconPlus width={15}/>} disabled={!value.trim() && attachments.length === 0} onClick={submitMessage} /><RunningActionButton label="Stop" tooltip="Stop the current response." icon={<IconStop width={15}/>} variant="danger" onClick={p.onStop} /></div> : <button type="submit" aria-label="Send" title="Send" className="composer-send" disabled={!value.trim() && attachments.length === 0}><IconSend/></button>}{openPicker ? <div id={openPicker === "permissions" ? "composer-permissions" : undefined} className={`composer-popover ${openPicker}-popover`} role="dialog" aria-label={composerPickerTitle(openPicker)}><ComposerPickerContent picker={openPicker} busy={p.busy} projects={p.projects} activeProjectId={p.project?.id ?? null} workspaces={p.workspaces} activeWorkspaceId={p.workspace?.id ?? null} skills={p.skills} selectedSkillIds={p.selectedSkillIds} permissionMode={p.permissionMode} selectedSkillCount={p.selectedSkills.length} activeProjectName={p.project?.name ?? null} activeWorkspaceName={p.workspace?.name ?? null} onAttach={() => { fileInputRef.current?.click(); setOpenPicker(null); }} onOpenPicker={openNestedPicker} onSelectProject={chooseProject} onSelectWorkspace={chooseWorkspace} onToggleSkill={toggleSkill} onPermissionMode={choosePermissionMode} onManage={(tab) => { setOpenPicker(null); p.onOpenTab(tab); }} /></div> : null}</div></form></div>;
});
function AttachmentTray(p: { attachments: MessageAttachment[]; onRemove?: (id: string) => void }) { return <div className="attachment-tray" aria-label="Attached files">{p.attachments.map((attachment) => { const src = isImageAttachment(attachment) ? attachmentDataUrl(attachment) : null; return <div key={attachment.id} className={`attachment-chip${isImageAttachment(attachment) ? " image" : ""}`}>{src ? <img alt="" src={src} /> : <span className="attachment-file-icon"><IconUpload width={15}/></span>}<span className="attachment-copy"><strong>{attachment.name}</strong><small>{attachment.mimeType} · {formatBytes(attachment.size)}</small></span>{p.onRemove ? <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => p.onRemove?.(attachment.id)}><IconClose width={14}/></button> : null}</div>; })}</div>; }
function composerPickerTitle(picker: ComposerPicker): string { return picker === "menu" ? "Composer options" : picker === "project" ? "Choose project" : picker === "skills" ? "Choose skills" : picker === "workspace" ? "Choose workspace" : "Tool permissions"; }
function ComposerPickerContent(p: { picker: ComposerPicker; busy: boolean; projects: Project[]; activeProjectId: string | null; workspaces: Workspace[]; activeWorkspaceId: string | null; skills: Skill[]; selectedSkillIds: string[]; permissionMode: PermissionMode; selectedSkillCount: number; activeProjectName: string | null; activeWorkspaceName: string | null; onAttach: () => void; onOpenPicker: (picker: ComposerPicker) => void; onSelectProject: (id: string | null) => void; onSelectWorkspace: (id: string | null) => void; onToggleSkill: (id: string) => void; onPermissionMode: (mode: PermissionMode) => void; onManage: (tab: Tab) => void }) {
  if (p.picker === "menu") return <><div className="picker-head"><strong>Composer options</strong></div><div className="picker-list"><button type="button" className="picker-option" onClick={p.onAttach}><span>Attach files or images</span><small>{p.busy ? "Attach context for steering or the next queued message." : "Upload files, images, screenshots, or paste images into the composer."}</small></button><button type="button" className="picker-option" disabled={p.busy} onClick={() => p.onOpenPicker("project")}><span>Project</span><small>{p.busy ? "Project context is locked while this response runs." : p.activeProjectName ?? "General chat, no project context"}</small></button><button type="button" className="picker-option" onClick={() => p.onOpenPicker("skills")}><span>Skills</span><small>{p.selectedSkillCount ? `${p.selectedSkillCount} selected for the next turn` : "Choose reusable behavior for the next turn"}</small></button><button type="button" className="picker-option" disabled={p.busy} onClick={() => p.onOpenPicker("workspace")}><span>Workspace</span><small>{p.busy ? "Workspace context is locked while this response runs." : p.activeWorkspaceName ?? "No local folder attached"}</small></button><button type="button" className="picker-option" onClick={() => p.onOpenPicker("permissions")}><span>Tool permissions</span><small>{p.permissionMode === "yolo" ? "Auto-approve is on" : "Ask before tool use"}</small></button></div></>;
  if (p.picker === "project") return <><div className="picker-head"><strong>Project</strong></div><div className="picker-list"><button type="button" className={`picker-option${p.activeProjectId === null ? " selected" : ""}`} onClick={() => p.onSelectProject(null)}><span>General</span><small>No project context</small></button>{p.projects.map((project) => <button type="button" key={project.id} className={`picker-option${p.activeProjectId === project.id ? " selected" : ""}`} onClick={() => p.onSelectProject(project.id)}><span>{project.name}</span><small>{previewText(project.instructions || project.memory, "Project context")}</small></button>)}</div></>;
  if (p.picker === "workspace") return <><div className="picker-head"><strong>Workspace</strong><button type="button" className="btn btn-sm btn-ghost" onClick={() => p.onManage("code")}>Manage</button></div><div className="picker-list"><button type="button" className={`picker-option${p.activeWorkspaceId === null ? " selected" : ""}`} onClick={() => p.onSelectWorkspace(null)}><span>No workspace</span><small>Run without local cowork context</small></button>{p.workspaces.map((workspace) => <button type="button" key={workspace.id} className={`picker-option${p.activeWorkspaceId === workspace.id ? " selected" : ""}`} onClick={() => p.onSelectWorkspace(workspace.id)}><span>{workspace.name}</span><small>{workspace.rootPath}</small></button>)}</div></>;
  if (p.picker === "skills") return <><div className="picker-head"><strong>Skills</strong><button type="button" className="btn btn-sm btn-ghost" onClick={() => p.onManage("skills")}>Manage</button></div><div className="picker-list">{p.skills.length === 0 ? <p className="section-help">No skills installed.</p> : p.skills.map((skill) => <button type="button" key={skill.id} disabled={!skill.enabled} className={`picker-option${p.selectedSkillIds.includes(skill.id) ? " selected" : ""}`} onClick={() => p.onToggleSkill(skill.id)}><span>{skill.manifest.name}</span><small>{skill.enabled ? skill.manifest.description : "Disabled"}</small></button>)}</div></>;
  return <><strong>Tool permissions</strong><p>Controls how this chat handles tool approval requests.</p><div className="settings-note"><p><strong>Auto-approve is powerful.</strong> Use it only for trusted chats and workspaces; shell and write permissions can change local files.</p></div><div className="segmented-control vertical"><button type="button" aria-label="Ask before each tool use" className={p.permissionMode === "ask" ? "on" : ""} onClick={() => p.onPermissionMode("ask")}><strong>Ask each time</strong><span>Review every tool request inline.</span></button><button type="button" aria-label="Auto-approve tool requests" className={p.permissionMode === "yolo" ? "on danger-mode" : ""} onClick={() => p.onPermissionMode("yolo")}><strong>Auto-approve tools</strong><span>Allow upcoming tool requests without another prompt.</span></button></div></>;
}
function Drawer(p: { active: Tab; onChangeTab: (t: Tab) => void; onClose: () => void; children: React.ReactNode }) { const activeTab = TABS.find((t) => t.id === p.active); function key(e: React.KeyboardEvent<HTMLButtonElement>, i: number) { if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return; e.preventDefault(); const n = (i + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length; const tab = TABS[n]; if (!tab) return; p.onChangeTab(tab.id); window.requestAnimationFrame(() => e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[n]?.focus()); } return <><div className="scrim" onClick={p.onClose}/><aside className="drawer" role="dialog" aria-modal="true" aria-label={activeTab?.label}><div className="drawer-head"><div><h2>{activeTab?.label}</h2><p>{DRAWER_DESCRIPTIONS[p.active]}</p></div><button className="icon-button" aria-label="Close" onClick={p.onClose}><IconClose/></button></div><div className="drawer-tabs" role="tablist">{TABS.map((tab,i) => <button key={tab.id} role="tab" aria-selected={tab.id===p.active} tabIndex={tab.id===p.active?0:-1} className={`drawer-tab${tab.id===p.active?" active":""}`} onClick={() => p.onChangeTab(tab.id)} onKeyDown={(e)=>key(e,i)}>{tab.icon}<span>{tab.label}</span></button>)}</div><div className="drawer-body">{p.children}</div></aside></>; }
function DrawerContent(p: { tab: Tab; state: AppState; theme: Theme; setTheme: (t: Theme) => void; textScale: number; setTextScale: (scale: number) => void; apiToken: string; setApiToken: (t: string) => void; selectedSkillIds: string[]; setSelectedSkillIds: (ids: string[]) => void; activeProjectId: string | null; onSelectProject: (id: string | null) => void; activeWorkspaceId: string | null; setActiveWorkspaceId: (id: string | null) => void; refresh: () => Promise<void>; showToast: (s: string) => void; clearAllData: () => Promise<void>; onStartGuidedImport: (file: File) => Promise<void> }) { if (p.tab === "skills") return <SkillsPanel {...p}/>; if (p.tab === "tools") return <McpPanel servers={p.state.mcpServers} refresh={p.refresh} showToast={p.showToast}/>; if (p.tab === "code") return <WorkspacesPanel workspaces={p.state.workspaces} activeWorkspaceId={p.activeWorkspaceId} setActiveWorkspaceId={p.setActiveWorkspaceId} refresh={p.refresh} showToast={p.showToast}/>; return <PreferencesPanel provider={p.state.provider} authMode={p.state.authMode} owner={p.state.owner.login} archivedChats={p.state.archivedChats} theme={p.theme} setTheme={p.setTheme} textScale={p.textScale} setTextScale={p.setTextScale} apiToken={p.apiToken} setApiToken={p.setApiToken} refresh={p.refresh} showToast={p.showToast} clearAllData={p.clearAllData} onStartGuidedImport={p.onStartGuidedImport}/>; }
function ProjectChatReferences(p:{project:Project;state:AppState;refresh:()=>Promise<void>;showToast:(s:string)=>void}) {
  const [query,setQuery]=useState(""),[results,setResults]=useState<ProjectChatSearchResult[]>([]);
  const refs=p.state.projectChatReferences.filter((reference)=>reference.projectId===p.project.id);
  async function search(){setResults(await api<ProjectChatSearchResult[]>(`/api/projects/${p.project.id}/search?q=${encodeURIComponent(query)}`));}
  async function pin(result:ProjectChatSearchResult){await api<ProjectChatReference>("/api/project-chat-references",{method:"POST",body:{projectId:p.project.id,messageId:result.messageId}}); p.showToast("Chat reference added"); await p.refresh();}
  return <div className="project-context-block"><strong>Referenced chat context</strong><div className="row"><FormField label="Search project chats"><input placeholder="Search this project's chats" value={query} onChange={(e)=>setQuery(e.target.value)}/></FormField><button className="btn btn-sm" disabled={!query.trim()} onClick={()=>void search()}>Search</button></div>{results.map((result)=><div className="mini-card" key={result.messageId}><strong>{result.title}</strong><p>{result.excerpt}</p><button className="btn btn-sm" onClick={()=>void pin(result)}>Reference</button></div>)}{refs.map((reference)=><div className="mini-card" key={reference.id}><strong>{reference.title}</strong><p>{reference.excerpt}</p><ConfirmButton label="Remove" confirmLabel="Confirm remove" onConfirm={async()=>{await api<void>(`/api/project-chat-references/${reference.id}`,{method:"DELETE",raw:true}); await p.refresh();}}/></div>)}</div>;
}
function SkillsPanel(p: { state: AppState; selectedSkillIds: string[]; setSelectedSkillIds: (ids: string[]) => void; refresh: () => Promise<void>; showToast: (s:string)=>void }) {
  const [show,setShow]=useState(false),[name,setName]=useState(""),[desc,setDesc]=useState(""),[ins,setIns]=useState(""),[rules,setRules]=useState(""),[perms,setPerms]=useState<string[]>([]);
  function toggle(id:string){p.setSelectedSkillIds(p.selectedSkillIds.includes(id)?p.selectedSkillIds.filter(x=>x!==id):[...p.selectedSkillIds,id]);}
  async function create(){if(!name.trim()||!ins.trim())return; await api<Skill>("/api/skills",{method:"POST",body:{manifest:{id:slugify(name),name,description:desc||`${name} workflow`,version:"1.0.0",instructions:ins,prompts:[],workflow:[],artifactTemplates:[],mcpDependencies:[],toolDependencies:[],activationRules:parseRules(rules),permissions:perms}}}); setShow(false); setName(""); setDesc(""); setIns(""); setRules(""); setPerms([]); await p.refresh(); p.showToast("Skill installed");}
  return <><div className="row"><p className="section-help">Installed skills auto-trigger from activation rules or when you mention them by name. Click a skill to explicitly include it in the next turn.</p><button className="btn btn-sm" onClick={()=>setShow(!show)}>{show?"Cancel":"New skill"}</button></div>{show?<form className="card skill-form" onSubmit={(e)=>{e.preventDefault();void create();}}><FormField label="Skill name"><input placeholder="Code review" value={name} onChange={e=>setName(e.target.value)}/></FormField><FormField label="Short description"><input placeholder="A short summary" value={desc} onChange={e=>setDesc(e.target.value)}/></FormField><FormField label="Instructions"><textarea rows={4} placeholder="Tell the assistant how to act when this skill is on." value={ins} onChange={e=>setIns(e.target.value)}/></FormField><FormField label="Activation rules" hint="One per line, for example: User asks for a review."><textarea rows={3} placeholder="User asks for a review" value={rules} onChange={e=>setRules(e.target.value)}/></FormField><fieldset className="permission-fieldset"><legend>Tool permissions this skill may request</legend><p>Leave unchecked unless the workflow genuinely needs that capability.</p>{PERMISSIONS.map(pm=><label key={pm} className="checkbox-row"><input type="checkbox" checked={perms.includes(pm)} onChange={()=>setPerms(perms.includes(pm)?perms.filter(x=>x!==pm):[...perms,pm])}/>{permissionLabel(pm)}</label>)}</fieldset><button className="btn btn-primary" disabled={!name.trim()||!ins.trim()}>Install skill</button></form>:null}<div className="list">{p.state.skills.map(skill=><div key={skill.id} className={`toggle-card${p.selectedSkillIds.includes(skill.id)?" on":""}`}><button className="toggle-card-main" disabled={!skill.enabled} onClick={()=>toggle(skill.id)}><div className="toggle-card-h"><strong>{skill.manifest.name}</strong><span className="toggle-card-check"><IconCheck width={14}/></span></div><span>{skill.manifest.description}</span></button><div className="card-foot"><span className="tag">{skill.builtIn?"Built-in":"Custom"}</span><span className={`tag${skill.enabled?" success":" warning"}`}>{skill.enabled?"installed":"disabled"}</span>{p.selectedSkillIds.includes(skill.id)?<span className="tag success">explicit next turn</span>:null}{skill.manifest.activationRules.map(rule=><span key={rule} className="tag">{rule}</span>)}{skill.manifest.permissions.map(pm=><span key={pm} className="tag">{permissionLabel(pm)}</span>)}</div><div className="card-actions"><button className="btn btn-sm" onClick={async()=>{await api<Skill>(`/api/skills/${skill.id}`,{method:"PATCH",body:{enabled:!skill.enabled}}); await p.refresh();}}>{skill.enabled?"Disable":"Install"}</button>{!skill.builtIn?<ConfirmButton label="Delete" confirmLabel="Confirm delete" onConfirm={async()=>{await api<void>(`/api/skills/${skill.id}`,{method:"DELETE",raw:true}); await p.refresh();}}/>:null}</div></div>)}</div></>;
}
function McpPanel(p:{servers:McpServer[];refresh:()=>Promise<void>;showToast:(s:string)=>void}){const[transport,setTransport]=useState<"stdio"|"http"|"sse">("stdio"),[name,setName]=useState(""),[command,setCommand]=useState(""),[url,setUrl]=useState(""),[tools,setTools]=useState("*"); async function add(){if(!name.trim())return; await api<McpServer>("/api/mcp-servers",{method:"POST",body:{name,transport,command:transport==="stdio"?command:null,args:[],url:transport==="stdio"?null:url,tools:parseTools(tools),enabled:true}}); setName(""); setCommand(""); setUrl(""); await p.refresh(); p.showToast("MCP server added");} return <><p className="section-help">Configure MCP servers and limit which tools they can expose to chats.</p><form className="card setup-form" onSubmit={e=>{e.preventDefault();void add();}}><FormField label="Server name"><input placeholder="github" value={name} onChange={e=>setName(e.target.value)}/></FormField><FormField label="Transport"><select value={transport} onChange={e=>setTransport(e.target.value as "stdio"|"http"|"sse")}><option value="stdio">Local (stdio)</option><option value="http">HTTP</option><option value="sse">SSE</option></select></FormField>{transport==="stdio"?<FormField label="Command" hint="Commands run without a shell and stay scoped by the server safety rules."><input placeholder="npx -y @some/mcp-server" value={command} onChange={e=>setCommand(e.target.value)}/></FormField>:<FormField label="Server URL"><input placeholder="https://api.example.com/mcp" value={url} onChange={e=>setUrl(e.target.value)}/></FormField>}<FormField label="Allowed tools" hint="Use * for all tools, or list names separated by commas."><input placeholder="tool-a, tool-b, or *" value={tools} onChange={e=>setTools(e.target.value)}/></FormField><button className="btn btn-primary" disabled={!name.trim()}>Add MCP server</button></form>{p.servers.map(server=><div className="card" key={server.id}><div className="card-h"><strong>{server.name}</strong><span className={`tag${server.enabled?" success":" warning"}`}>{server.transport} · {server.enabled?"enabled":"disabled"}</span></div><code>{server.transport==="stdio"?server.command:server.url}</code><div className="card-foot">{(server.tools.length?server.tools:["no tools exposed"]).map(t=><span key={t} className="tag">{t}</span>)}</div><div className="card-actions"><button className="btn btn-sm" onClick={async()=>{await api<McpServer>(`/api/mcp-servers/${server.id}`,{method:"PATCH",body:{enabled:!server.enabled}}); await p.refresh();}}>{server.enabled?"Disable":"Enable"}</button><ConfirmButton label="Remove" confirmLabel="Confirm remove" onConfirm={async()=>{await api<void>(`/api/mcp-servers/${server.id}`,{method:"DELETE",raw:true}); await p.refresh();}}/></div></div>)}</>;}
function WorkspacesPanel(p:{workspaces:Workspace[];activeWorkspaceId:string|null;setActiveWorkspaceId:(id:string|null)=>void;refresh:()=>Promise<void>;showToast:(s:string)=>void}){const[name,setName]=useState(""),[rootPath,setRootPath]=useState(""); async function reg(){if(!name||!rootPath)return; await api<Workspace>("/api/workspaces",{method:"POST",body:{name,rootPath}}); setName(""); setRootPath(""); await p.refresh(); p.showToast("Workspace registered");} return <><p className="section-help">Connect local folders for cowork mode. Registered paths are the only places workspace commands can run.</p><form className="card setup-form" onSubmit={e=>{e.preventDefault();void reg();}}><FormField label="Workspace name"><input placeholder="My repo" value={name} onChange={e=>setName(e.target.value)}/></FormField><FormField label="Folder path"><input placeholder="/Users/you/Code/project" value={rootPath} onChange={e=>setRootPath(e.target.value)}/></FormField><button className="btn btn-primary" disabled={!name.trim()||!rootPath.trim()}>Register workspace</button></form>{p.workspaces.length===0?<p className="settings-note">No workspaces yet. Register a local folder to let CopilotChat inspect files and run approved commands there.</p>:p.workspaces.map(w=><WorkspaceCard key={w.id} workspace={w} active={p.activeWorkspaceId===w.id} setActiveWorkspaceId={p.setActiveWorkspaceId} refresh={p.refresh}/>)}</>;}
function WorkspaceCard(p:{workspace:Workspace;active:boolean;setActiveWorkspaceId:(id:string|null)=>void;refresh:()=>Promise<void>}){const[command,setCommand]=useState("ls"),[output,setOutput]=useState(""); async function run(){const r=await api<{output:{stdout?:string;stderr?:string};error:string|null}>(`/api/workspaces/${p.workspace.id}/commands`,{method:"POST",body:{command}}); setOutput([r.output.stdout,r.output.stderr,r.error].filter(Boolean).join("\n")||"(no output)");} return <div className="card"><div className="card-h"><strong>{p.workspace.name}</strong><span className={`tag${p.active?" success":""}`}>{p.active?"active":p.workspace.enabled?"enabled":"disabled"}</span></div><code>{p.workspace.rootPath}</code><div className="card-actions"><button className="btn btn-sm" disabled={!p.workspace.enabled} onClick={()=>p.setActiveWorkspaceId(p.active?null:p.workspace.id)}>{p.active?"Stop using":"Use in chat"}</button><button className="btn btn-sm" onClick={async()=>{await api<Workspace>(`/api/workspaces/${p.workspace.id}`,{method:"PATCH",body:{enabled:!p.workspace.enabled}}); await p.refresh();}}>{p.workspace.enabled?"Disable":"Enable"}</button><ConfirmButton label="Remove" confirmLabel="Confirm remove" onConfirm={async()=>{await api<void>(`/api/workspaces/${p.workspace.id}`,{method:"DELETE",raw:true}); await p.refresh();}}/></div><form className="row command-row" onSubmit={e=>{e.preventDefault();void run();}}><FormField label="Test command"><input placeholder="Command" value={command} onChange={e=>setCommand(e.target.value)}/></FormField><button className="btn btn-sm" disabled={!p.workspace.enabled||!command.trim()}>Run</button></form>{output?<pre className="terminal">{output}</pre>:null}</div>;}
function ImportsPanel(p:{onStartGuidedImport:(file:File)=>Promise<void>}){const[loading,setLoading]=useState(false); async function start(file:File){setLoading(true); try{await p.onStartGuidedImport(file);} finally{setLoading(false);}} return <><p className="section-help">Choose a Claude, ChatGPT, or Gemini export. CopilotChat will start a guided import chat that previews the file, asks for project conversation screenshots or pasted title lists when helpful, and imports only after confirmation.</p><label className={`card import-start-card${loading?" loading":""}`}><IconUpload width={22}/><strong>{loading?"Starting guided import…":"Start guided import"}</strong><span>Creates a draft and opens an import assistant chat.</span><input type="file" accept=".json,.txt,.zip" disabled={loading} style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0]; if(f) void start(f); e.currentTarget.value="";}}/></label></>;}
function PreferencesPanel(p:{provider:ProviderStatus;authMode:AppState["authMode"];owner:string;archivedChats:Chat[];theme:Theme;setTheme:(t:Theme)=>void;textScale:number;setTextScale:(scale:number)=>void;apiToken:string;setApiToken:(t:string)=>void;refresh:()=>Promise<void>;showToast:(s:string)=>void;clearAllData:()=>Promise<void>;onStartGuidedImport:(file:File)=>Promise<void>}) {
  const [token,setToken]=useState(p.apiToken);
  const textPercent = Math.round(p.textScale * 100);
  return <div className="settings-panel"><AuthSetupCard provider={p.provider} authMode={p.authMode}/><section className="settings-section"><div className="settings-section-title"><div><strong>Preferences</strong><span>Personal app behavior and display choices.</span></div></div><div className="settings-card"><div className="settings-row"><div className="settings-row-main"><strong>Theme</strong><span>Choose a color scheme or follow your system setting.</span></div><div className="segmented-control"><button className={p.theme==="system"?"on":""} onClick={()=>p.setTheme("system")}>System</button><button className={p.theme==="light"?"on":""} onClick={()=>p.setTheme("light")}>Light</button><button className={p.theme==="dark"?"on":""} onClick={()=>p.setTheme("dark")}>Dark</button></div></div></div><div className="settings-card"><label className="text-scale-control"><span>Text size <strong>{textPercent}%</strong></span><input aria-label="Text size" type="range" min="85" max="120" step="5" value={textPercent} onChange={(e)=>p.setTextScale(clampTextScale(Number(e.currentTarget.value) / 100))}/></label><div className="settings-actions"><button className="btn btn-sm" onClick={()=>p.setTextScale(DEFAULT_TEXT_SCALE)}>Reset text size</button></div></div></section><section className="settings-section"><div className="settings-section-title"><div><strong>Account & provider</strong><span>Authentication and provider-level connection state.</span></div></div><div className="settings-card"><div className="settings-row"><div className="settings-row-main"><strong>Signed in as {p.owner}</strong><span>{p.provider.details}</span></div><span className={`tag${p.provider.available?" success":" warning"}`}>{p.provider.id}</span></div></div><div className="settings-card"><div className="settings-row"><div className="settings-row-main"><strong>API token</strong><span>Optional token used for remote installs and authenticated API calls.</span></div><button className="btn btn-sm" onClick={()=>{p.setApiToken(token);p.showToast("API token saved");}}>Save</button></div><FormField label="API token"><input placeholder="Optional token for remote installs" value={token} onChange={e=>setToken(e.target.value)}/></FormField></div></section><section className="settings-section"><div className="settings-section-title"><div><strong>Import data</strong><span>Bring in conversations and project context from other assistants.</span></div></div><ImportsPanel onStartGuidedImport={p.onStartGuidedImport}/></section><section className="settings-section"><div className="settings-section-title"><div><strong>Local app data</strong><span>Device-level browser permissions and chat history maintenance.</span></div></div><div className="settings-card"><div className="settings-row"><div className="settings-row-main"><strong>Notifications</strong><span>Allow local browser notifications for long-running work.</span></div><button className="btn btn-sm" onClick={()=>void Notification.requestPermission().then(s=>p.showToast(`Notifications: ${s}`))}><IconBell width={14}/>Enable</button></div></div><div className="settings-card"><div className="settings-row"><div className="settings-row-main"><strong>Archived chats</strong><span>Restore or permanently delete archived conversations.</span></div><span className="tag">{p.archivedChats.length}</span></div>{p.archivedChats.length===0?<p className="section-help">No archived chats.</p>:<div className="archive-list">{p.archivedChats.map(c=><div className="archive-row" key={c.id}><strong>{c.title}</strong><div className="card-actions"><button className="btn btn-sm" onClick={async()=>{await api<Chat>(`/api/chats/${c.id}`,{method:"PATCH",body:{archived:false}},p.apiToken); await p.refresh();}}>Restore</button><ConfirmButton label="Delete" confirmLabel="Confirm delete" onConfirm={async()=>{await api<void>(`/api/chats/${c.id}`,{method:"DELETE",raw:true},p.apiToken); await p.refresh();}}/></div></div>)}</div>}</div><div className="settings-card danger-zone"><div className="settings-row"><div className="settings-row-main"><strong>Clear all local data</strong><span>Deletes chats, projects, artifacts, skills, MCP servers, workspaces, tool history, and isolated chat workspaces. Account/auth setup is kept.</span></div><button className="btn btn-sm btn-danger" onClick={()=>void p.clearAllData()}>Clear all data</button></div></div></section></div>;
}
function AuthSetupCard(p:{provider:ProviderStatus;authMode:AppState["authMode"]}){const command="copilot login\n# or\ngh auth login\n# then restart the dev server\npnpm dev"; const infinite=p.provider.capabilities.includes("infinite-sessions"); const localSetup=p.authMode==="local"; const githubReauth=p.authMode==="github"&&p.provider.id==="sdk"; return <div className={`card auth-card${p.provider.available?" ready":" warning"}`}><div className="card-h"><strong>{p.provider.available?"Copilot is connected":"Connect Copilot"}</strong><span className={`tag${p.provider.available?" success":" warning"}`}>{p.provider.available?"ready":"setup needed"}</span></div><p className="section-help">{p.provider.available?`Dynamic model discovery is working${infinite?", and SDK infinite chats are enabled.":"."}`:p.provider.details||"No Copilot provider is available yet."}</p>{!p.provider.available&&localSetup?<pre className="command-block"><code>{command}</code></pre>:null}{!p.provider.available&&githubReauth?<div className="settings-actions"><a className="btn btn-primary" href="/api/auth/github/login">Sign in again</a></div>:null}</div>;}
function Toast(p:{text:string;onDone:()=>void}){useEffect(()=>{const id=setTimeout(p.onDone,2200);return()=>clearTimeout(id);},[p]);return <div className="toast">{p.text}</div>;}
type LatestRef<T> = { current: T };
type BackGuardOptions = { drawerRef: LatestRef<Tab | null>; sidebarOpenRef: LatestRef<boolean>; busyRef: LatestRef<boolean>; stopResponseRef: LatestRef<() => void>; currentPath: () => string; closeDrawer: () => void; closeSidebar: () => void; toast: (text: string) => void };
function installBackGuard(options: BackGuardOptions): () => void {
  let allowingLeave = false;
  let lastLeavePromptAt = 0;
  function pushGuard(): void { try { history.pushState({ copilotChatBackGuard: true }, "", options.currentPath()); } catch { return; } }
  try { history.replaceState({ copilotChatBackGuard: true }, "", options.currentPath()); pushGuard(); } catch { return () => {}; }
  function stayInApp(message: string): void { options.toast(message); pushGuard(); }
  function onPopState(): void {
    if (allowingLeave) return;
    if (options.drawerRef.current) { options.closeDrawer(); stayInApp("Closed panel"); return; }
    if (options.sidebarOpenRef.current) { options.closeSidebar(); stayInApp("Closed sidebar"); return; }
    if (options.busyRef.current) { options.stopResponseRef.current(); stayInApp("Stopped response"); return; }
    const now = Date.now();
    if (now - lastLeavePromptAt < 1800) { allowingLeave = true; setTimeout(() => { allowingLeave = false; }, 600); history.back(); return; }
    lastLeavePromptAt = now;
    stayInApp("Press Back again to leave CopilotChat");
  }
  window.addEventListener("popstate", onPopState);
  return () => window.removeEventListener("popstate", onPopState);
}
function appRouteFromLocation(): AppRoute { return appRouteFromPath(location.pathname); }
function appRouteFromPath(path: string): AppRoute {
  if (path.startsWith(CHAT_ROUTE_PREFIX)) {
    const chatId = routeSegment(path, CHAT_ROUTE_PREFIX);
    if (chatId) return { kind: "chat", chatId };
  }
  if (path.startsWith(PROJECT_ROUTE_PREFIX)) {
    const projectId = routeSegment(path, PROJECT_ROUTE_PREFIX);
    if (projectId) return { kind: "project", projectId };
  }
  return { kind: "home" };
}
function routeSegment(path: string, prefix: string): string | null { const segment = path.slice(prefix.length).split("/")[0]; if (!segment) return null; try { return decodeURIComponent(segment); } catch { return segment; } }
function appPathForSelection(chatId: string | null, projectId: string | null): string { if (chatId) return `${CHAT_ROUTE_PREFIX}${encodeURIComponent(chatId)}`; return projectId ? `${PROJECT_ROUTE_PREFIX}${encodeURIComponent(projectId)}` : "/"; }
function syncAppUrl(path: string): void { if (location.pathname === path) return; history.replaceState({ copilotChatBackGuard: true }, "", path); }
async function api<T>(url:string,init:{method?:string;body?:unknown;raw?:boolean}={},token=localStorage.getItem(API_TOKEN_KEY)??""):Promise<T>{const method=init.method??"GET";const headers:Record<string,string>={};if(init.body!==undefined)headers["Content-Type"]="application/json";if(["POST","PATCH","DELETE"].includes(method))headers["X-CopilotChat-CSRF"]="1";if(token)headers.Authorization=`Bearer ${token}`;const res=await fetch(url,{method,headers:Object.keys(headers).length?headers:undefined,body:init.body!==undefined?JSON.stringify(init.body):undefined});if(!res.ok)throw new Error(httpErrorMessage(res.status,await res.text()));return init.raw?undefined as T:await res.json() as T;}
async function* streamSse(url:string,body:unknown,signal:AbortSignal,token:string,method="POST"):AsyncIterable<SseEvent>{const headers:Record<string,string>={};if(body!==undefined)headers["Content-Type"]="application/json";if(["POST","PATCH","DELETE"].includes(method))headers["X-CopilotChat-CSRF"]="1";if(token)headers.Authorization=`Bearer ${token}`;const res=await fetch(url,{method,headers:Object.keys(headers).length?headers:undefined,body:body!==undefined?JSON.stringify(body):undefined,signal});if(!res.ok||!res.body)throw new Error(httpErrorMessage(res.status,await res.text()));const reader=res.body.getReader();const dec=new TextDecoder();let buf="";while(true){const{done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split("\n\n");buf=parts.pop()??"";for(const part of parts){const ev=parseSse(part);if(ev)yield ev;}}}
function parseSse(chunk:string):SseEvent|null{const lines=chunk.split("\n");const event=lines.find(l=>l.startsWith("event:"))?.slice(6).trim();const data=lines.find(l=>l.startsWith("data:"))?.slice(5).trim();return event&&data?{event,data:JSON.parse(data) as unknown}:null;}
function readTheme(): Theme { const saved = localStorage.getItem("copilotchat.theme"); return saved === "system" || saved === "light" || saved === "dark" ? saved : "system"; }
function readSystemTheme(): ResolvedTheme { return window.matchMedia(SYSTEM_THEME_QUERY).matches ? "dark" : "light"; }
function readContextTier(): ContextTier { return localStorage.getItem(CONTEXT_TIER_KEY) === "long_context" ? "long_context" : "default"; }
function isMobileViewport(): boolean { return window.matchMedia("(max-width: 880px)").matches; }
function readTextScale(): number { const saved = localStorage.getItem(TEXT_SCALE_KEY); if (!saved) return DEFAULT_TEXT_SCALE; const parsed = Number(saved); return Number.isFinite(parsed) ? clampTextScale(parsed) : DEFAULT_TEXT_SCALE; }
function clampTextScale(value: number): number { return Math.round(Math.min(1.2, Math.max(0.85, value)) * 20) / 20; }
function readSeenChatUpdates(): Record<string, string> { const saved = localStorage.getItem(CHAT_SEEN_KEY); if (!saved) return {}; try { const parsed = JSON.parse(saved) as unknown; return isObjectRecord(parsed) ? Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<string, string> : {}; } catch { return {}; } }
function writeSeenChatUpdates(value: Record<string, string>): Record<string, string> { localStorage.setItem(CHAT_SEEN_KEY, JSON.stringify(value)); return value; }
async function registerServiceWorker(){if("serviceWorker" in navigator)try{await navigator.serviceWorker.register("/sw.js");}catch{return;}}
function notify(title:string,body:string){if(typeof Notification==="undefined"||Notification.permission!=="granted"||document.visibilityState!=="hidden")return;if(navigator.serviceWorker.controller)navigator.serviceWorker.controller.postMessage({type:"notify",title,body});else new Notification(title,{body});}
function fileToBase64(file:File):Promise<string>{return new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(new Error("Failed to read file."));r.onload=()=>typeof r.result==="string"?resolve(r.result.slice(r.result.indexOf(",")+1)):reject(new Error("Failed to read file."));r.readAsDataURL(file);});}
async function fileToAttachment(file: File): Promise<MessageAttachment> { return { id: crypto.randomUUID(), name: file.name || "Pasted image", mimeType: file.type || "application/octet-stream", size: file.size, data: await fileToBase64(file) }; }
function messageAttachments(message: ChatMessage): MessageAttachment[] { const value = message.metadata.attachments; if (!Array.isArray(value)) return []; return value.filter(isMessageAttachment); }
function isMessageAttachment(value: unknown): value is MessageAttachment { return isObjectRecord(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.mimeType === "string" && typeof value.size === "number" && (value.data === undefined || typeof value.data === "string"); }
function isImageAttachment(attachment: MessageAttachment): boolean { return attachment.mimeType.startsWith("image/"); }
function attachmentDataUrl(attachment: MessageAttachment): string | null { return attachment.data ? `data:${attachment.mimeType};base64,${attachment.data}` : null; }
function formatBytes(value: number): string { if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`; if (value >= 1024) return `${Math.round(value / 1024)} KB`; return `${Math.max(0, Math.round(value))} B`; }
function guidedImportPrompt(draft: ImportDraft): string { return ["Use Import assistant to guide this import.", "", `Import draft ID: ${draft.id}`, `File: ${draft.fileName}`, `Requested source: ${draft.source}`, `Encoding: ${draft.encoding}`, "", "First call preview_import_draft. Then explain what will import and request screenshots or copied text of Claude/ChatGPT project conversation lists when that would help verify project membership. If screenshots are not readable in this chat, request pasted visible project names and conversation titles. Only call apply_import_draft after I explicitly confirm."].join("\n"); }
function copyText(text:string):Promise<void>{return navigator.clipboard.writeText(text);}
function textFromNode(node:React.ReactNode):string{if(node===null||node===undefined||typeof node==="boolean")return"";if(typeof node==="string"||typeof node==="number")return String(node);if(Array.isArray(node))return node.map(textFromNode).join("");if(React.isValidElement<{children?:React.ReactNode}>(node))return textFromNode(node.props.children);return"";}
function readActivities(value: unknown): AssistantActivity[] { if (!Array.isArray(value)) return []; return value.map(readActivity).filter((activity): activity is AssistantActivity => Boolean(activity)); }
function readActivity(value: unknown, index: number): AssistantActivity | null { if (!isObjectRecord(value)) return null; const type = value.type === "tool" ? "tool" : value.type === "reasoning" ? "reasoning" : value.type === "subagent" ? "subagent" : value.type === "task-list" ? "task-list" : null; if (!type) return null; const id = typeof value.id === "string" && value.id ? value.id : `${type}-${index}`; const title = typeof value.title === "string" && value.title ? value.title : type === "tool" ? "Tool" : type === "subagent" ? "Subagent" : type === "task-list" ? "Task list" : "Thinking"; const status = value.status === "running" || value.status === "failed" || value.status === "succeeded" ? value.status : "succeeded"; return { id, type, title, status, content: typeof value.content === "string" ? value.content : undefined, items: readTaskListItems(value.items), input: value.input, output: value.output, error: typeof value.error === "string" ? value.error : null, details: isObjectRecord(value.details) ? value.details : undefined, steps: readActivities(value.steps) }; }
function readTaskListItems(value: unknown): TaskListItem[] | undefined { if (!Array.isArray(value)) return undefined; const items = value.map((item): TaskListItem | null => { if (!isObjectRecord(item)) return null; const title = typeof item.title === "string" ? item.title : typeof item.content === "string" ? item.content : ""; if (!title.trim()) return null; return { title: title.trim(), completed: item.completed === true || item.checked === true || item.status === "completed" || item.status === "done", depth: typeof item.depth === "number" ? item.depth : undefined }; }).filter((item): item is TaskListItem => Boolean(item)); return items.length ? items : undefined; }
function readInteractions(value: unknown): PendingInteraction[] { if (!Array.isArray(value)) return []; return value.map(readInteraction).filter((interaction): interaction is PendingInteraction => Boolean(interaction)); }
function readInteraction(value: unknown, index: number): PendingInteraction | null { if (!isObjectRecord(value)) return null; const kind = value.kind === "permission" || value.kind === "user-input" || value.kind === "elicitation" ? value.kind : null; if (!kind) return null; const choices = Array.isArray(value.choices) ? value.choices.map(String) : undefined; return { id: typeof value.id === "string" && value.id ? value.id : `${kind}-${index}`, kind, title: typeof value.title === "string" ? value.title : kind === "permission" ? "Permission request" : "Agent request", message: typeof value.message === "string" ? value.message : "", choices, allowFreeform: value.allowFreeform !== false, request: value.request, requestedSchema: value.requestedSchema }; }
function readPendingTurns(value: unknown): PendingTurn[] { if (!Array.isArray(value)) return []; return value.map(readPendingTurn).filter((turn): turn is PendingTurn => Boolean(turn)); }
function readPendingTurn(value: unknown, index: number): PendingTurn | null { if (!isObjectRecord(value)) return null; const mode = value.mode === "steer" ? "steer" : value.mode === "queue" ? "queue" : null; if (!mode) return null; const status = value.status === "sent" || value.status === "running" || value.status === "done" || value.status === "failed" ? value.status : "queued"; return { id: typeof value.id === "string" && value.id ? value.id : `${mode}-${index}`, mode, content: typeof value.content === "string" ? value.content : "", status, createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString() }; }
function upsertPendingTurn(turns: PendingTurn[], next: PendingTurn): PendingTurn[] { return turns.some((turn) => turn.id === next.id) ? turns.map((turn) => turn.id === next.id ? next : turn) : [...turns, next]; }
function formatActivityValue(value: unknown): string { if (typeof value === "string") return value; return JSON.stringify(value, null, 2) ?? String(value); }
function interactionDetail(interaction: PendingInteraction): string { if (interaction.kind === "permission" && isObjectRecord(interaction.request)) return permissionInteractionDetail(interaction.request); if (interaction.kind === "elicitation" && interaction.requestedSchema) return formatActivityValue(interaction.requestedSchema); return ""; }
function permissionInteractionDetail(request: Record<string, unknown>): string {
  const fields: Array<[string, unknown]> = [
    ["Kind", request.kind],
    ["Tool", request.toolName],
    ["Tool call", request.toolCallId],
    ["URL", request.url],
    ["File", request.fileName],
    ["Command", request.fullCommandText],
  ];
  const lines = fields.flatMap(([label, value]) => typeof value === "string" && value.trim() ? [`${label}: ${value}`] : []);
  if (isObjectRecord(request.details) && Object.keys(request.details).length > 0) lines.push(`Details:\n${formatActivityValue(request.details)}`);
  if (request.raw !== undefined && request.raw !== null) lines.push(`Raw request:\n${formatActivityValue(request.raw)}`);
  return lines.join("\n\n");
}
function parseJsonForUser(value: string): { ok: true; value: unknown } | { ok: false; error: string } { try { return { ok: true, value: JSON.parse(value) as unknown }; } catch (e) { return { ok: false, error: e instanceof SyntaxError ? e.message : "Response must be valid JSON." }; } }
function isObjectRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function slugify(s:string){return s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||`item-${Date.now()}`;}
function parseTools(v:string){return v.split(",").map(t=>t.trim()).filter(Boolean);}
function parseRules(v:string): string[] { return v.split(/\n|,/).map((rule) => rule.trim()).filter(Boolean); }
function permissionLabel(value: string): string { return value === "filesystem:read" ? "Read files" : value === "filesystem:write" ? "Write files" : value === "network" ? "Network" : value === "shell" ? "Shell commands" : value === "mcp" ? "MCP tools" : value === "github" ? "GitHub" : value === "artifacts" ? "Artifacts" : humanizeFieldName(value); }
function formatProjectDate(value: string): string { return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
function formatMessageTime(value: string): string { return formatDate(value, { hour: "numeric", minute: "2-digit" }); }
function formatMessageDateTime(value: string): string { return formatDate(value, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
function formatDate(value: string, options: Intl.DateTimeFormatOptions): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, options); }
function messageDayKey(value: string): string { const date = new Date(value); if (Number.isNaN(date.getTime())) return ""; const year = date.getFullYear(); const month = String(date.getMonth() + 1).padStart(2, "0"); const day = String(date.getDate()).padStart(2, "0"); return `${year}-${month}-${day}`; }
function formatMessageDateBarrier(value: string): string { const date = new Date(value); if (Number.isNaN(date.getTime())) return ""; const today = new Date(); const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1); if (messageDayKey(value) === messageDayKey(today.toISOString())) return "Today"; if (messageDayKey(value) === messageDayKey(yesterday.toISOString())) return "Yesterday"; return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" }); }
function previewText(value: string | null | undefined, fallback: string): string { const compact = value?.replace(/\s+/g, " ").trim() ?? ""; return compact ? compact : fallback; }
function slashCommandQuery(value: string): string | null { const match = /^\/([a-z0-9-]*)$/i.exec(value.trim()); return match ? (match[1] ?? "").toLowerCase() : null; }
function buildSlashCommands(skills: Skill[]): SlashCommand[] {
  const commands = new Map<string, SlashCommand>();
  const add = (command: SlashCommand) => {
    let key = command.command;
    let suffix = 2;
    while (commands.has(key)) key = `${command.command}-${suffix++}`;
    commands.set(key, { ...command, command: key });
  };
  for (const skill of skills.filter((skill) => skill.enabled)) {
    const skillCommand = slashCommandSlug(skill.id || skill.manifest.name);
    add({ command: skillCommand, title: skill.manifest.name, description: skill.manifest.description, body: `Use ${skill.manifest.name}: ` });
    for (const prompt of skill.manifest.prompts) {
      add({ command: slashCommandSlug(prompt.id || prompt.title), title: prompt.title, description: `${skill.manifest.name}: ${previewText(prompt.body, "Run this prompt.")}`, body: prompt.body });
    }
  }
  return [...commands.values()].sort((a, b) => a.command.localeCompare(b.command));
}
function slashCommandSlug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "command"; }
function toErr(e:unknown){return e instanceof Error?e.message:String(e);}
function httpErrorMessage(status: number, body: string): string {
  const text = readableErrorText(body);
  if (status === 401) return text.includes("Login required") ? "Login required" : "Unauthorized. Check your CopilotChat API token or sign in again.";
  if (status === 403) return "Permission denied. Check the workspace, tool, or account permissions and try again.";
  if (status === 404) return "That item is no longer available. Refreshing will update the workspace.";
  if (status === 413) return "That request is too large. Remove some attachments or context and try again.";
  if (status === 429) return "The provider is rate limiting requests. Wait a moment, then try again.";
  if (status >= 500) return "CopilotChat hit a server error. Your local data is still safe; try again in a moment.";
  return text || `Request failed with status ${status}.`;
}
function readableErrorText(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isObjectRecord(parsed)) {
      const message = readNonEmptyString(parsed.message) ?? readNonEmptyString(parsed.error) ?? readNonEmptyString(parsed.details);
      if (message) return message;
    }
  } catch {
    // Plain text response.
  }
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? "The server returned an unexpected response." : trimmed;
}
function friendlyError(raw: string): { title: string; message: string; action: string } {
  const message = readableErrorText(raw);
  if (/login required|unauthorized|auth/i.test(message)) return { title: "Authentication needs attention", message: "CopilotChat could not confirm your current credentials. Open Preferences if the provider still shows Setup.", action: "Retry" };
  if (/permission|forbidden|denied/i.test(message)) return { title: "Permission blocked this action", message: "The requested workspace, tool, or account permission is not available yet.", action: "Refresh" };
  if (/not found/i.test(message)) return { title: "That item moved or was deleted", message: "The app can refresh local state so the sidebar and current view match the server.", action: "Refresh" };
  if (/too large|413/i.test(message)) return { title: "Too much context for this request", message: "Remove large attachments or some context, then send the message again.", action: "Refresh" };
  if (/rate limit|429/i.test(message)) return { title: "Provider is rate limiting", message: "Wait a moment before retrying. The current chat and draft stay in place.", action: "Refresh" };
  return { title: "Something interrupted the request", message: message || "The app could not complete that action. Refresh local state and try again.", action: "Refresh" };
}
function isEditableTarget(target: EventTarget | null): boolean { return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)); }
function effortLabel(id: ReasoningEffort): string { return id === "default" ? "Auto" : id.charAt(0).toUpperCase() + id.slice(1); }
function reasoningEffortChoices(model: ProviderModel | null | undefined): ReasoningEffort[] { if (!model?.supportsReasoningEffort) return ["default"]; const supported = model.supportedReasoningEfforts.filter((effort): effort is ReasoningEffort => EFFORT_OPTIONS.includes(effort as ReasoningEffort)); return Array.from(new Set<ReasoningEffort>(["default", ...supported])); }
function contextTierLabel(tier: ContextTier, model: ProviderModel | null): string { const tokens = tier === "long_context" ? model?.longContextMaxPromptTokens : model?.maxPromptTokens ?? model?.contextWindowTokens; const label = tier === "long_context" ? "Long" : "Standard"; return tokens ? `${label} (${formatTokens(tokens)})` : label; }
function modelContextLabel(model: ProviderModel): string { const standard = model.maxPromptTokens ?? model.contextWindowTokens; if (!standard) return "Context limit unavailable"; return model.supportsLongContext && model.longContextMaxPromptTokens ? `${formatTokens(standard)} / ${formatTokens(model.longContextMaxPromptTokens)}` : `${formatTokens(standard)} context`; }
function modelSelectionSummary(model: ProviderModel | null, effort: ReasoningEffort, tier: ContextTier): string { if (!model) return ""; const parts = [model.supportsReasoningEffort ? `${effortLabel(effort)} effort` : "", model.supportsLongContext ? contextTierLabel(tier, model) : modelContextLabel(model)]; return parts.filter(Boolean).join(" / "); }
function contextRingBackground(status: ContextStatus): string { const percent = status.limitTokens ? Math.min(100, (status.estimatedTokens / status.limitTokens) * 100) : status.percent ?? 0; const visualPercent = status.estimatedTokens > 0 ? Math.max(2, percent) : percent; const degrees = Math.max(0, Math.min(100, visualPercent)) * 3.6; const color = status.state === "full" ? "var(--danger)" : status.state === "warn" ? "var(--warning)" : status.state === "unknown" ? "var(--border-strong)" : "var(--accent)"; return `conic-gradient(${color} ${degrees}deg, var(--surface-muted) 0deg)`; }
function contextRingLabel(status: ContextStatus): string { if (!status.limitTokens) return "?"; if (status.estimatedTokens === 0) return "0"; const percent = (status.estimatedTokens / status.limitTokens) * 100; return percent < 1 ? "<1%" : `${Math.min(100, Math.round(percent))}%`; }
function useDismissablePopup<T extends HTMLElement>(active: boolean, onDismiss: () => void): React.RefObject<T | null> { const ref = useRef<T | null>(null); useEffect(() => { if (!active) return; function pointerDown(event: PointerEvent): void { const target = event.target; if (!(target instanceof Node)) return; if (ref.current?.contains(target)) return; onDismiss(); } function keyDown(event: KeyboardEvent): void { if (event.key === "Escape") onDismiss(); } document.addEventListener("pointerdown", pointerDown, true); document.addEventListener("keydown", keyDown, true); return () => { document.removeEventListener("pointerdown", pointerDown, true); document.removeEventListener("keydown", keyDown, true); }; }, [active, onDismiss]); return ref; }
function resizeComposerTextarea(textarea: HTMLTextAreaElement | null): void { if (!textarea) return; textarea.style.height = "0px"; textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 44), 180)}px`; }
function isAtLiveEdge(element: HTMLElement): boolean { return element.scrollHeight - element.scrollTop - element.clientHeight <= LIVE_SCROLL_THRESHOLD; }
function cleanName(s:string){const t=s.trim();return !t||t.toLowerCase()==="local"||t.toLowerCase()==="local user"?"":t.split(/\s+/)[0]??"";}
function buildContextStatus(messages:ChatMessage[],streamingText:string,draft:string,project:Project|null,workspace:Workspace|null,skills:Skill[],model:ProviderModel|null,tier:ContextTier):ContextStatus{const contextText=[...messages.map(m=>m.content),streamingText,draft,project?.instructions??"",workspace?.rootPath??"",...skills.map(s=>`${s.manifest.name}\n${s.manifest.description}\n${s.manifest.instructions}`)].filter(Boolean).join("\n\n");const estimatedTokens=Math.max(0,Math.ceil(contextText.length/4));const displayTokens=estimatedTokens===0?0:Math.max(1000,estimatedTokens);const limitTokens=tier==="long_context"?(model?.longContextMaxPromptTokens??model?.maxPromptTokens??model?.contextWindowTokens):(model?.maxPromptTokens??model?.contextWindowTokens);const tierLabel=tier==="long_context"?"Long context":"Standard context";if(!limitTokens)return{estimatedTokens,limitTokens:null,percent:null,label:`${formatTokens(displayTokens)} used`,detail:`${tierLabel}. Estimated ${estimatedTokens.toLocaleString()} tokens. The limit is not reported for this model.`,state:"unknown"};const actualPercent=(estimatedTokens/limitTokens)*100;const percent=Math.min(100,Math.round(actualPercent));const state=percent>=85?"full":percent>=65?"warn":"ok";return{estimatedTokens,limitTokens,percent,label:`${formatTokens(displayTokens)} / ${formatTokens(limitTokens)}`,detail:`${tierLabel}. Estimated ${estimatedTokens.toLocaleString()} of ${limitTokens.toLocaleString()} context tokens used (${formatPercent(actualPercent)}).`,state};}
function formatTokens(value:number):string{if(value>=1000000)return`${trimNumber(value/1000000)}M`;if(value>=1000)return`${trimNumber(value/1000)}k`;return String(value);}
function trimNumber(value:number):string{return value>=10?String(Math.round(value)):value.toFixed(1).replace(/\.0$/,"");}
function formatPercent(value:number):string{return value>0&&value<1?"<1%":`${trimNumber(Math.min(100,value))}%`;}
function groupChatsByDate(chats:Chat[]){const now=Date.now();const today:Chat[]=[];const yesterday:Chat[]=[];const week:Chat[]=[];const older:Chat[]=[];for(const c of sortFavoritesFirst(chats)){const d=(now-new Date(c.updatedAt).getTime())/86400000;if(d<1)today.push(c);else if(d<2)yesterday.push(c);else if(d<7)week.push(c);else older.push(c);}return [{label:"Today",chats:today},{label:"Yesterday",chats:yesterday},{label:"Previous 7 days",chats:week},{label:"Older",chats:older}].filter(g=>g.chats.length);}
function sortFavoritesFirst<T extends { favorite?: boolean; updatedAt: string }>(items: T[]): T[] { return [...items].sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()); }
const root=document.getElementById("root"); if(!root) throw new Error("Missing root"); createRoot(root).render(<React.StrictMode><App/></React.StrictMode>);
