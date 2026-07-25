import type { ImportedConversation, ImportedProject, ImportPreview, ImportSource } from "@copilotchat/shared";
import JSZip from "jszip";

type UnknownRecord = Record<string, unknown>;
type AssistantActivity = { id: string; type: "reasoning" | "tool" | "subagent" | "task-list"; title: string; status: "running" | "succeeded" | "failed"; content?: string; input?: unknown; output?: unknown; error?: string | null; details?: Record<string, unknown>; steps?: AssistantActivity[] };
type ClaudeProjectHint = { sourceId: string; name: string; normalizedName: string; isStarterProject: boolean; topicPhrases: string[]; negativePhrases: string[] };
type ArchiveReadState = { totalBytes: number; maxBytes: number };
export type ImportPayloadLimits = { archiveEntryLimit?: number; archiveUncompressedLimit?: number };
const importedContentLimit = 20_000;
const importedValueDepthLimit = 5;
const importedValueArrayLimit = 80;
const importedValueObjectKeyLimit = 80;
const archiveEntryLimit = 10_000;
const archiveUncompressedLimit = 256 * 1024 * 1024;

export function previewImport(requestedSource: ImportSource, fileName: string, content: string): ImportPreview {
  const json = parseJson(content);
  const source = requestedSource === "auto" ? detectSource(fileName, json) : requestedSource;
  if (source === "chatgpt") return parseChatGpt(json);
  if (source === "claude") return parseClaude(json);
  if (source === "gemini") return parseGemini(json);
  throw new Error(`Unsupported import source: ${String(source)}`);
}

export async function previewImportPayload(requestedSource: ImportSource, fileName: string, content: string | Uint8Array, encoding: "text" | "base64" = "text", limits: ImportPayloadLimits = {}): Promise<ImportPreview> {
  if (!fileName.toLowerCase().endsWith(".zip")) return previewImport(requestedSource, fileName, typeof content === "string" ? content : new TextDecoder().decode(content));
  if (encoding !== "base64") throw new Error("ZIP imports must be uploaded as base64 payloads.");
  const entryLimit = limits.archiveEntryLimit ?? archiveEntryLimit;
  const uncompressedLimit = limits.archiveUncompressedLimit ?? archiveUncompressedLimit;
  const archiveBytes = typeof content === "string" ? base64ToBytes(content) : content;
  validateZipEntryCount(archiveBytes, entryLimit);
  const zip = await JSZip.loadAsync(archiveBytes);
  validateImportArchive(zip, entryLimit, uncompressedLimit);
  const archiveReadState: ArchiveReadState = { totalBytes: 0, maxBytes: uncompressedLimit };
  if (requestedSource === "auto" || requestedSource === "claude") {
    const claudeArchive = await parseClaudeArchive(zip, archiveReadState);
    if (claudeArchive) return claudeArchive;
  }
  const previews: ImportPreview[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !isSupportedArchiveEntry(entry.name)) continue;
    previews.push(previewImport(requestedSource, entry.name, await readArchiveEntryText(entry, archiveReadState)));
  }
  if (previews.length === 0) throw new Error("Archive did not contain a supported ChatGPT, Claude, or Gemini export file.");
  return { source: requestedSource === "auto" ? previews[0]?.source ?? "chatgpt" : requestedSource, conversations: previews.flatMap((p) => p.conversations), projects: previews.flatMap((p) => p.projects), warnings: previews.flatMap((p) => p.warnings) };
}

function parseJson(content: string): unknown { try { return JSON.parse(content) as unknown; } catch (error) { throw new Error(`Import file is not valid JSON: ${(error as Error).message}`, { cause: error }); } }
function detectSource(fileName: string, json: unknown): Exclude<ImportSource, "auto"> { const lower = fileName.toLowerCase(); if (lower.includes("claude")) return "claude"; if (lower.includes("gemini") || lower.includes("bard") || lower.includes("myactivity")) return "gemini"; const first = asArray(json)[0]; if (isRecord(first) && ("chat_messages" in first || "uuid" in first)) return "claude"; if (isRecord(first) && typeof first.header === "string" && (first.header.includes("Gemini") || first.header.includes("Bard"))) return "gemini"; if (isRecord(json) && ("conversations" in json || "ordered_conversation" in json)) return "gemini"; return "chatgpt"; }
function parseChatGpt(json: unknown): ImportPreview { const warnings: string[] = []; const conversations = asArray(json).map((record, index): ImportedConversation => { const item = asRecord(record); const messages = orderChatGptMessages(asRecord(item.mapping), stringOrNull(item.current_node)).map((message) => { const author = asRecord(message.author); const content = asRecord(message.content); const metadata = asRecord(message.metadata); const role = stringFromUnknown(author.role, "user"); if (shouldSkipChatGptMessage(role, content, metadata)) return null; return { role: normalizeRole(role), content: normalizeContent(content), createdAt: numberToIso(message.create_time), metadata: { sourceStatus: message.status, sourceRecipient: message.recipient, model: metadata.model_slug } }; }).filter((m): m is NonNullable<typeof m> => m !== null).filter((m) => m.content.trim()); if (messages.length === 0) warnings.push(`ChatGPT conversation ${index + 1} had no readable messages.`); return { source: "chatgpt", sourceId: stringOrNull(item.id), projectSourceId: null, title: stringFromUnknown(item.title, `Imported ChatGPT chat ${index + 1}`), createdAt: numberToIso(item.create_time), updatedAt: numberToIso(item.update_time), messages, artifacts: [], reusableHelpers: extractReusableHelpers(item, "chatgpt"), metadata: { sourceFileShape: "chatgpt-conversations" } }; }); return { source: "chatgpt", conversations, projects: [], warnings }; }
function parseClaude(json: unknown): ImportPreview { const records = asArray(isRecord(json) && Array.isArray(json.conversations) ? json.conversations : json); const warnings: string[] = []; const conversations = parseClaudeConversations(records, warnings); return { source: "claude", conversations, projects: [], warnings }; }
function parseGemini(json: unknown): ImportPreview { const root = asRecord(json); const records = asArray(root.conversations ?? root.ordered_conversation ?? json); if (records.some(isGeminiActivityRecord)) return parseGeminiActivity(records); const warnings: string[] = []; const conversations = records.map((record, index): ImportedConversation => { const item = asRecord(record); const messages = asArray(item.messages ?? item.turns ?? item.entries).map((message) => { const value = asRecord(message); return { role: normalizeRole(stringFromUnknown(value.role ?? value.author ?? value.speaker, "user")), content: normalizeContent(value.content ?? value.text ?? value.parts), createdAt: stringOrNull(value.created_at ?? value.createdAt ?? value.timestamp), metadata: { sourceId: value.id } }; }).filter((m) => m.content.trim()); if (messages.length === 0) warnings.push(`Gemini conversation ${index + 1} had no readable messages.`); return { source: "gemini", sourceId: stringOrNull(item.id ?? item.conversation_id), projectSourceId: null, title: stringFromUnknown(item.title ?? item.name, `Imported Gemini chat ${index + 1}`), createdAt: stringOrNull(item.created_at ?? item.createdAt), updatedAt: stringOrNull(item.updated_at ?? item.updatedAt), messages, artifacts: [], reusableHelpers: extractReusableHelpers(item, "gemini"), metadata: { sourceFileShape: "gemini-takeout" } }; }); return { source: "gemini", conversations, projects: [], warnings }; }
async function parseClaudeArchive(zip: JSZip, archiveReadState: ArchiveReadState): Promise<ImportPreview | null> {
  const conversationsEntry = zip.file(/(^|\/)conversations\.json$/i)[0];
  const projectEntries = zip.file(/^projects\/[^/]+\.json$/i);
  const memoriesEntry = zip.file(/(^|\/)memories\.json$/i)[0];
  if (!conversationsEntry && projectEntries.length === 0 && !memoriesEntry) return null;
  const warnings: string[] = [];
  const projects: ImportedProject[] = [];
  for (const entry of projectEntries) projects.push(parseClaudeProject(parseJson(await readArchiveEntryText(entry, archiveReadState)), entry.name));
  if (memoriesEntry) {
    const memoryProject = parseClaudeMemoryProject(parseJson(await readArchiveEntryText(memoriesEntry, archiveReadState)));
    if (memoryProject) {
      applyClaudeMemoryToProjects(projects, memoryProject);
      projects.push(memoryProject);
    }
  }
  const conversations = conversationsEntry ? parseClaudeConversations(asArray(parseJson(await readArchiveEntryText(conversationsEntry, archiveReadState))), warnings, projects) : [];
  if (!conversationsEntry) warnings.push("Claude archive did not contain conversations.json; imported project/memory data only.");
  if (projects.length > 0 && conversations.length > 0) {
    const associated = conversations.filter((conversation) => conversation.projectSourceId).length;
    warnings.push(`Claude export did not include explicit conversation project IDs; associated ${associated} conversations by project-name/path inference.`);
  }
  return { source: "claude", conversations, projects, warnings };
}
function parseClaudeConversations(records: unknown[], warnings: string[], projects: ImportedProject[] = []): ImportedConversation[] {
  const projectHints = projects.map((project) => {
    const profile = claudeProjectTopicProfile(project);
    return { sourceId: project.sourceId ?? "", name: project.name, normalizedName: normalizeProjectText(project.name), isStarterProject: project.metadata.isStarterProject === true, topicPhrases: profile.topicPhrases, negativePhrases: profile.negativePhrases };
  }).filter((project) => project.sourceId && project.normalizedName && project.sourceId !== "claude-memory");
  return records.map((record, index): ImportedConversation | null => {
    const item = asRecord(record);
    const messages = asArray(item.chat_messages ?? item.messages).map((message) => parseClaudeMessage(asRecord(message))).filter((m) => m.content.trim() || Array.isArray(m.metadata.activities) || Array.isArray(m.metadata.sourceFiles) || Array.isArray(m.metadata.sourceAttachments));
    if (messages.length === 0) {
      warnings.push(`Claude conversation ${index + 1} had no readable messages and was skipped.`);
      return null;
    }
    const inferredProject = inferClaudeProject(item, projectHints);
    const projectSourceId = stringOrNull(item.project_uuid ?? item.project_id) ?? inferredProject?.sourceId ?? null;
    return { source: "claude", sourceId: stringOrNull(item.uuid ?? item.id), projectSourceId, title: stringFromUnknown(item.name ?? item.title, `Imported Claude chat ${index + 1}`), createdAt: stringOrNull(item.created_at ?? item.createdAt), updatedAt: stringOrNull(item.updated_at ?? item.updatedAt), messages, artifacts: [], reusableHelpers: extractReusableHelpers(item, "claude"), metadata: { sourceFileShape: "claude-conversations", sourceSummary: item.summary, inferredProject: inferredProject ? { sourceId: inferredProject.sourceId, name: inferredProject.name, reason: inferredProject.reason } : undefined } };
  }).filter((conversation): conversation is ImportedConversation => conversation !== null);
}
function parseClaudeMessage(value: UnknownRecord): ImportedConversation["messages"][number] {
  const role = normalizeRole(stringFromUnknown(value.sender ?? value.role, "user"));
  const files = asArray(value.files).map(asRecord).map((file) => ({ uuid: stringOrNull(file.file_uuid ?? file.uuid), name: stringFromUnknown(file.file_name ?? file.filename ?? file.name, "Imported file") }));
  const attachments = asArray(value.attachments).map((attachment) => limitImportedValue(attachment));
  const parsed = parseClaudeParts(asArray(value.content));
  const explicitText = stringOrNull(value.text);
  const attachmentText = files.length > 0 ? `\n\nImported files:\n${files.map((file) => `- ${file.name}${file.uuid ? ` (${file.uuid})` : ""}`).join("\n")}` : "";
  const content = `${explicitText ?? parsed.visibleText}${attachmentText}`.trim();
  return { role, content, createdAt: stringOrNull(value.created_at ?? value.createdAt), metadata: compactRecord({ sourceUuid: value.uuid, sourceParentUuid: value.parent_message_uuid, sourceFiles: files.length ? files : undefined, sourceAttachments: attachments.length ? attachments : undefined, activities: parsed.activities.length ? parsed.activities : undefined }) };
}
function parseClaudeParts(parts: unknown[]): { visibleText: string; activities: AssistantActivity[] } {
  const visible: string[] = [];
  const activities: AssistantActivity[] = [];
  const toolActivities = new Map<string, AssistantActivity>();
  let index = 0;
  for (const partValue of parts) {
    const part = asRecord(partValue);
    const type = stringFromUnknown(part.type);
    if (type === "text") {
      const text = stringOrNull(part.text);
      if (text) visible.push(text);
    } else if (type === "thinking") {
      const content = stringOrNull(part.thinking) ?? asArray(part.summaries).map((summary) => stringOrNull(asRecord(summary).summary)).filter(Boolean).join("\n");
      if (content) activities.push({ id: `claude-thinking-${++index}`, type: "reasoning", title: "Thinking", status: "succeeded", content: truncateImportedString(content), details: compactRecord({ summaries: limitImportedValue(part.summaries), cutOff: part.cut_off, truncated: part.truncated }) });
    } else if (type === "tool_use") {
      const id = stringFromUnknown(part.id, `claude-tool-${++index}`);
      const activity: AssistantActivity = { id, type: "tool", title: stringFromUnknown(part.name, "Tool"), status: "running", input: limitImportedValue(part.input), content: stringOrNull(part.message) ?? undefined, details: compactRecord({ integrationName: part.integration_name, displayContent: part.display_content, context: limitImportedValue(part.context), isMcpApp: part.is_mcp_app }) };
      toolActivities.set(id, activity);
      activities.push(activity);
    } else if (type === "tool_result") {
      const id = stringFromUnknown(part.tool_use_id, `claude-tool-result-${++index}`);
      const existing = toolActivities.get(id);
      const output = normalizeClaudeToolResult(part.content ?? part.structured_content ?? part.message);
      if (existing) {
        existing.status = part.is_error === true ? "failed" : "succeeded";
        existing.output = output;
        existing.error = part.is_error === true ? stringFromUnknown(part.message, "Tool returned an error.") : null;
        existing.details = compactRecord({ ...(existing.details ?? {}), resultMessage: part.message, integrationName: part.integration_name, displayContent: part.display_content, meta: limitImportedValue(part.meta) });
      } else {
        activities.push({ id, type: "tool", title: stringFromUnknown(part.name, "Tool result"), status: part.is_error === true ? "failed" : "succeeded", output, error: part.is_error === true ? stringFromUnknown(part.message, "Tool returned an error.") : null });
      }
    } else if (type === "token_budget") {
      activities.push({ id: `claude-token-budget-${++index}`, type: "reasoning", title: "Token budget", status: "succeeded", content: formatImportedValue(part) });
    } else if (type && type !== "flag") {
      activities.push({ id: `claude-${type}-${++index}`, type: "reasoning", title: `Claude ${type}`, status: "succeeded", content: formatImportedValue(part) });
    }
  }
  for (const activity of toolActivities.values()) if (activity.status === "running") activity.status = "succeeded";
  return { visibleText: visible.join("\n\n"), activities };
}
function parseClaudeProject(json: unknown, fileName: string): ImportedProject {
  const item = asRecord(json);
  const docs = asArray(item.docs).map((docValue) => {
    const doc = asRecord(docValue);
    return { sourceId: stringOrNull(doc.uuid), title: stringFromUnknown(doc.filename ?? doc.name, "Claude project document"), content: normalizeContent(doc.content), createdAt: stringOrNull(doc.created_at), metadata: { sourceFileShape: "claude-project-doc" } };
  }).filter((doc) => doc.content.trim());
  return { source: "claude", sourceId: stringOrNull(item.uuid), name: stringFromUnknown(item.name, fileName.replace(/^projects\//, "").replace(/\.json$/i, "")), description: stringOrNull(item.description), instructions: stringOrNull(item.prompt_template), memory: null, references: docs, metadata: { sourceFileShape: "claude-project", isPrivate: item.is_private, isStarterProject: item.is_starter_project, createdAt: item.created_at, updatedAt: item.updated_at } };
}
function parseClaudeMemoryProject(json: unknown): ImportedProject | null {
  const records = asArray(json);
  const memory = records.map(asRecord).map((record) => stringOrNull(record.conversations_memory ?? record.memory ?? record.content)).filter(Boolean).join("\n\n");
  if (!memory.trim()) return null;
  return { source: "claude", sourceId: "claude-memory", name: "Claude memory", description: "Memory imported from Claude export.", instructions: null, memory, references: [{ sourceId: "claude-memory-conversations", title: "Claude conversations memory", content: memory, createdAt: null, metadata: { sourceFileShape: "claude-memories" } }], metadata: { sourceFileShape: "claude-memories" } };
}
function applyClaudeMemoryToProjects(projects: ImportedProject[], memoryProject: ImportedProject): void {
  if (!memoryProject.memory?.trim()) return;
  for (const project of projects) {
    if (project.metadata.isStarterProject === true) continue;
    project.memory = [project.memory, memoryProject.memory].filter((value): value is string => Boolean(value?.trim())).join("\n\n");
    project.references = [...project.references, ...memoryProject.references.map((reference) => ({ ...reference, title: `Claude memory - ${reference.title}` }))];
  }
}
function inferClaudeProject(item: UnknownRecord, projects: ClaudeProjectHint[]): { sourceId: string; name: string; reason: string } | null {
  if (projects.length === 0) return null;
  const scores = new Map<string, { project: ClaudeProjectHint; score: number; reasons: string[] }>();
  const addScore = (project: ClaudeProjectHint, score: number, reason: string) => {
    const current = scores.get(project.sourceId) ?? { project, score: 0, reasons: [] };
    current.score += score;
    if (!current.reasons.includes(reason)) current.reasons.push(reason);
    scores.set(project.sourceId, current);
  };
  const projectDirs = collectClaudeProjectDirs(item).map(normalizeProjectText);
  for (const dir of projectDirs) {
    for (const project of projects) {
      if (dir.endsWith(project.normalizedName) || dir.includes(` ${project.normalizedName} `)) addScore(project, 100, "project path");
    }
  }
  const title = stringFromUnknown(item.name ?? item.title);
  const summary = stringFromUnknown(item.summary);
  const titleNormalized = normalizeProjectText(title);
  const summaryNormalized = normalizeProjectText(summary);
  const bodyNormalized = normalizeProjectText(asArray(item.chat_messages ?? item.messages).map((message) => claudeMessageSearchText(asRecord(message))).join("\n").slice(0, 80_000));
  const contentNormalized = `${titleNormalized} ${summaryNormalized} ${bodyNormalized}`;
  for (const project of projects) {
    if (project.isStarterProject) continue;
    if (normalizeProjectText(title).includes(project.normalizedName)) addScore(project, 50, "title");
    if (normalizeProjectText(summary).includes(project.normalizedName)) addScore(project, 30, "summary");
    let topicScore = 0;
    const topicHits: string[] = [];
    for (const phrase of project.topicPhrases) {
      const normalized = normalizeProjectText(phrase);
      if (titleNormalized.includes(normalized)) { topicScore += 30; topicHits.push(phrase); }
      else if (summaryNormalized.includes(normalized)) { topicScore += 18; topicHits.push(phrase); }
      else if (bodyNormalized.includes(normalized)) { topicScore += 15; topicHits.push(phrase); }
    }
    if (topicScore > 0) addScore(project, Math.min(160, topicScore), `topic:${topicHits.slice(0, 6).join(", ")}`);
    const negativeHits = project.negativePhrases.filter((phrase) => contentNormalized.includes(normalizeProjectText(phrase)));
    if (negativeHits.length > 0) addScore(project, -80, `negative:${negativeHits.slice(0, 3).join(", ")}`);
    const occurrences = countOccurrences(contentNormalized, project.normalizedName);
    if (occurrences > 0) addScore(project, Math.min(40, occurrences * 10), "conversation text");
  }
  const ranked = [...scores.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 60) return null;
  if (ranked[1] && best.score - ranked[1].score < 15) return null;
  return { sourceId: best.project.sourceId, name: best.project.name, reason: best.reasons.join(", ") };
}
function claudeProjectTopicProfile(project: ImportedProject): { topicPhrases: string[]; negativePhrases: string[] } {
  const profileTextRaw = [project.name, project.description, project.instructions, project.references.map((reference) => `${reference.title}\n${reference.content}`).join("\n")].filter(Boolean).join("\n");
  const topicPhrases = new Set<string>([project.name, ...project.references.map((reference) => reference.title), ...extractTopicPhrases(profileTextRaw)]);
  const negativePhrases = new Set<string>();
  return { topicPhrases: [...topicPhrases].filter((phrase) => normalizeProjectText(phrase).trim()), negativePhrases: [...negativePhrases] };
}
function extractTopicPhrases(value: string): string[] {
  const words = normalizeProjectText(value).trim().split(/\s+/).filter((word) => word.length >= 4);
  const phrases = new Set<string>();
  for (const word of words) phrases.add(word);
  for (let index = 0; index < words.length - 1; index += 1) phrases.add(`${words[index]} ${words[index + 1]}`);
  return [...phrases].slice(0, 80);
}
function collectClaudeProjectDirs(value: unknown): string[] {
  const result: string[] = [];
  const visit = (entry: unknown) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!isRecord(entry)) return;
    for (const [key, nested] of Object.entries(entry)) {
      if (key === ["project", "dir"].join("_") && typeof nested === "string") result.push(nested);
      else visit(nested);
    }
  };
  visit(value);
  return result;
}
function claudeMessageSearchText(message: UnknownRecord): string {
  const parts = asArray(message.content).map((part) => {
    const record = asRecord(part);
    return [record.text, record.thinking, record.message, formatImportedValue(record.input)].filter((value) => typeof value === "string").join("\n");
  });
  return [message.text, ...parts].filter((value) => typeof value === "string").join("\n");
}
function normalizeProjectText(value: string): string { return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `; }
function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let index = value.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = value.indexOf(needle, index + needle.length);
  }
  return count;
}
function normalizeClaudeToolResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => isRecord(entry) && typeof entry.text === "string" ? entry.text : limitImportedValue(entry));
  return limitImportedValue(value);
}
function parseGeminiActivity(records: unknown[]): ImportPreview { const entries = records.filter(isGeminiActivityRecord).map((record) => { const item = asRecord(record); const parsed = parseGeminiTitle(stringFromUnknown(item.title)); return parsed ? { role: parsed.role, content: parsed.content, time: normalizeTimestamp(stringOrNull(item.time)), metadata: { header: item.header, products: item.products, subtitles: item.subtitles } } : null; }).filter((e): e is NonNullable<typeof e> => e !== null).sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "")); const sessions: typeof entries[] = []; let current: typeof entries = []; let previousTime: Date | null = null; for (const entry of entries) { const currentTime = entry.time ? new Date(entry.time) : null; if (previousTime && currentTime && currentTime.getTime() - previousTime.getTime() > 30 * 60 * 1000 && current.length > 0) { sessions.push(current); current = []; } current.push(entry); previousTime = currentTime ?? previousTime; } if (current.length > 0) sessions.push(current); return { source: "gemini", conversations: sessions.map((session, index) => { const first = session[0]; return { source: "gemini", sourceId: `gemini-${simpleHash(first?.time ?? `${index}`)}`, projectSourceId: null, title: session.find((m) => m.role === "user")?.content.slice(0, 80) || `Imported Gemini chat ${index + 1}`, createdAt: first?.time ?? null, updatedAt: session[session.length - 1]?.time ?? first?.time ?? null, messages: session.map((m) => ({ role: m.role, content: m.content, createdAt: m.time, metadata: m.metadata })), artifacts: [], reusableHelpers: [], metadata: { sourceFileShape: "gemini-takeout-activity" } }; }), projects: [], warnings: entries.length === 0 ? ["Gemini activity export did not contain readable messages."] : [] }; }
function orderChatGptMessages(mapping: UnknownRecord, currentNode: string | null): UnknownRecord[] { if (currentNode) { const ordered: UnknownRecord[] = []; const visited = new Set<string>(); let nodeId: string | null = currentNode; while (nodeId && !visited.has(nodeId)) { visited.add(nodeId); const node = asRecord(mapping[nodeId]); if (node.message) ordered.push(asRecord(node.message)); nodeId = stringOrNull(node.parent); } if (ordered.length > 0) return ordered.reverse(); } return Object.values(mapping).map((node) => asRecord(asRecord(node).message)).filter((m) => Object.keys(m).length > 0).sort((a, b) => (typeof a.create_time === "number" ? a.create_time : 0) - (typeof b.create_time === "number" ? b.create_time : 0)); }
function shouldSkipChatGptMessage(role: string, content: UnknownRecord, metadata: UnknownRecord): boolean { const contentType = stringFromUnknown(content.content_type); return role === "tool" || role === "system" || role === "developer" || metadata.is_visually_hidden_from_conversation === true || ["user_editable_context", "reasoning_recap", "thoughts"].includes(contentType); }
function extractReusableHelpers(item: UnknownRecord, source: "chatgpt" | "claude" | "gemini"): ImportedConversation["reusableHelpers"] { return [item.custom_instructions, item.instructions, item.gizmo, item.gpt, item.project, item.gem].filter(Boolean).map((candidate, index) => { const record = asRecord(candidate); return { id: `${source}-helper-${index + 1}`, name: stringFromUnknown(record.name ?? record.title, `${source} imported helper ${index + 1}`), description: stringFromUnknown(record.description, "Imported reusable assistant helper."), version: "imported", instructions: normalizeContent(record.instructions ?? record.prompt ?? record.content), prompts: [], workflow: [], artifactTemplates: [], mcpDependencies: [], toolDependencies: [], activationRules: [], permissions: [] }; }); }
function normalizeRole(role: string): "user" | "assistant" | "system" | "tool" { const lower = role.toLowerCase(); if (lower.includes("assistant") || lower.includes("bot") || lower.includes("claude")) return "assistant"; if (lower.includes("system")) return "system"; if (lower.includes("tool")) return "tool"; return "user"; }
function normalizeContent(value: unknown): string { if (typeof value === "string") return value; if (Array.isArray(value)) return value.map(normalizeContent).filter(Boolean).join("\n\n"); if (!isRecord(value)) return ""; if (value.type === "image" && typeof value.url === "string") return `![Imported image](${value.url})`; if (typeof value.language === "string" && typeof value.text === "string") return `\`\`\`${value.language}\n${value.text}\n\`\`\``; if (typeof value.text === "string") return value.text; if (typeof value.result === "string") return value.result; if (Array.isArray(value.parts)) return value.parts.map(normalizeContent).filter(Boolean).join("\n\n"); return ""; }
function isSupportedArchiveEntry(name: string): boolean { const n = name.replaceAll("\\", "/").toLowerCase(); return n.endsWith("conversations.json") || n.endsWith("myactivity.json") || (n.includes("/design_chats/") && n.endsWith(".json")); }
function validateZipEntryCount(bytes: Uint8Array, entryLimit: number): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const entries = buffer.readUInt16LE(offset + 10);
    if (entries === 0xffff || entries > entryLimit) throw new Error(`Import archive contains too many files (${entries === 0xffff ? "ZIP64" : entries}).`);
    return;
  }
  throw new Error("Import archive is missing a valid end-of-central-directory record.");
}
function validateImportArchive(zip: JSZip, entryLimit: number, uncompressedLimit: number): void {
  const allEntries = Object.values(zip.files);
  if (allEntries.length > entryLimit) throw new Error(`Import archive contains too many files (${allEntries.length}).`);
  const entries = allEntries.filter((entry) => !entry.dir && isImportArchiveEntry(entry.name));
  let total = 0;
  for (const entry of entries) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof size !== "number") continue;
    total += size;
    if (total > uncompressedLimit) throw new Error(`Import archive expands beyond the ${formatArchiveLimit(uncompressedLimit)} safety limit.`);
  }
}
function isImportArchiveEntry(name: string): boolean {
  const normalized = name.replaceAll("\\", "/").toLowerCase();
  return isSupportedArchiveEntry(normalized) || normalized.endsWith("/memories.json") || normalized === "memories.json" || /^projects\/[^/]+\.json$/.test(normalized);
}
async function readArchiveEntryText(entry: JSZip.JSZipObject, state: ArchiveReadState): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let entryBytes = 0;
    let settled = false;
    const stream = entry.nodeStream("nodebuffer");
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };
    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      entryBytes += chunk.byteLength;
      state.totalBytes += chunk.byteLength;
      if (entryBytes > state.maxBytes) { fail(new Error(`Import archive entry ${entry.name} expands beyond the ${formatArchiveLimit(state.maxBytes)} safety limit.`)); return; }
      if (state.totalBytes > state.maxBytes) { fail(new Error(`Import archive expands beyond the ${formatArchiveLimit(state.maxBytes)} safety limit.`)); return; }
      chunks.push(chunk);
    });
    stream.on("error", (error: Error) => fail(error));
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, entryBytes).toString("utf8"));
    });
  });
}
function formatArchiveLimit(value: number): string { return value >= 1024 * 1024 ? `${Math.round(value / 1024 / 1024)} MB` : `${value} byte`; }
function base64ToBytes(value: string): Uint8Array { return Uint8Array.from(Buffer.from(value, "base64")); }
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function asRecord(value: unknown): UnknownRecord { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is UnknownRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function numberToIso(value: unknown): string | null { if (typeof value !== "number" || !Number.isFinite(value)) return null; return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString(); }
function stringOrNull(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function stringFromUnknown(value: unknown, fallback = ""): string { return typeof value === "string" && value.length > 0 ? value : fallback; }
function compactRecord(input: UnknownRecord): UnknownRecord { return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== "")); }
function truncateImportedString(value: string, limit = importedContentLimit): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} characters]`;
}
function limitImportedValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateImportedString(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "symbol";
  if (Array.isArray(value)) {
    const limited = value.slice(0, importedValueArrayLimit).map((entry) => limitImportedValue(entry, depth + 1));
    if (value.length > importedValueArrayLimit) limited.push(`[truncated ${value.length - importedValueArrayLimit} items]`);
    return limited;
  }
  if (!isRecord(value)) return null;
  if (depth >= importedValueDepthLimit) return "[truncated nested object]";
  const entries = Object.entries(value);
  const limited: UnknownRecord = {};
  for (const [key, entry] of entries.slice(0, importedValueObjectKeyLimit)) limited[key] = limitImportedValue(entry, depth + 1);
  if (entries.length > importedValueObjectKeyLimit) limited.__truncated = `${entries.length - importedValueObjectKeyLimit} fields omitted`;
  return limited;
}
function formatImportedValue(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(limitImportedValue(value), null, 2); }
function isGeminiActivityRecord(value: unknown): boolean { const record = asRecord(value); const header = stringFromUnknown(record.header); return typeof record.title === "string" && (header.includes("Gemini") || header.includes("Bard") || asArray(record.products).some((product) => String(product).includes("Gemini"))); }
function parseGeminiTitle(title: string): { role: "user" | "assistant"; content: string } | null { const decoded = decodeHtml(title.replace(/<[^>]*>/g, "")).trim(); for (const prefix of ["You said:", "Dijiste:", "Vous avez dit:"]) if (decoded.startsWith(prefix)) return { role: "user", content: decoded.slice(prefix.length).trim() }; for (const prefix of ["Gemini said:", "Bard said:", "Gemini respondió:"]) if (decoded.startsWith(prefix)) return { role: "assistant", content: decoded.slice(prefix.length).trim() }; return null; }
function decodeHtml(value: string): string { return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'"); }
function normalizeTimestamp(value: string | null): string | null { if (!value) return null; const date = new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function simpleHash(value: string): string { let hash = 5381; for (const char of value) hash = (hash * 33) ^ char.charCodeAt(0); return (hash >>> 0).toString(16); }
