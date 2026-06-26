import type { ProviderTool } from "@copilotchat/provider";
import type { Chat } from "@copilotchat/shared";
import { z } from "zod";
import type { AppDatabase } from "./db.js";

const scopeArg = z.enum(["current_project", "other_projects", "all"]);
const searchArgsSchema = z.object({ query: z.string().min(1), scope: scopeArg.default("all"), limit: z.number().int().min(1).max(50).optional() });
const listArgsSchema = z.object({ scope: scopeArg.default("all"), includeArchived: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional() });
const getArgsSchema = z.object({ chatId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() });

const scopeProperty = { type: "string", enum: ["current_project", "other_projects", "all"], description: "Which previous conversations to look in. 'current_project' = only this conversation's project (or only general/project-less chats when this conversation has no project), 'other_projects' = every conversation outside the current project, 'all' = every conversation. Defaults to 'all'." } as const;

export function buildConversationTools(input: { db: AppDatabase; ownerId: string; chat: Chat }): ProviderTool[] {
  const { db, ownerId, chat } = input;
  const currentProjectId = chat.projectId;
  return [
    {
      name: "search_past_conversations",
      description: "Search the full text of the user's previous CopilotChat conversations and return matching message excerpts with their chat id, title, and project. Use this to recall earlier decisions, answers, or context from other chats. By default it searches across every project; narrow it with `scope`.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Text to search for within past conversation messages." }, scope: scopeProperty, limit: { type: "number", description: "Maximum number of matching messages to return (1-50, default 20)." } }, required: ["query"], additionalProperties: false },
      skipPermission: true,
      handler: (args) => { const parsed = searchArgsSchema.parse(args); const results = db.searchConversations(ownerId, parsed.query, { scope: parsed.scope, currentProjectId, excludeChatId: chat.id, limit: parsed.limit }); return { query: parsed.query, scope: parsed.scope, count: results.length, results }; },
    },
    {
      name: "list_recent_conversations",
      description: "List the user's most recent previous CopilotChat conversations (title, project, message count, timestamps) so you can discover prior chats to open with get_conversation. Scope to the current project or across all projects.",
      parameters: { type: "object", properties: { scope: scopeProperty, includeArchived: { type: "boolean", description: "Include archived conversations. Defaults to false." }, limit: { type: "number", description: "Maximum number of conversations to return (1-50, default 20)." } }, required: [], additionalProperties: false },
      skipPermission: true,
      handler: (args) => { const parsed = listArgsSchema.parse(args); const conversations = db.listRecentConversations(ownerId, { scope: parsed.scope, currentProjectId, excludeChatId: chat.id, includeArchived: parsed.includeArchived, limit: parsed.limit }); return { scope: parsed.scope, count: conversations.length, conversations }; },
    },
    {
      name: "get_conversation",
      description: "Read the message transcript of a specific previous conversation by its chatId (obtained from search_past_conversations or list_recent_conversations). Returns the most recent messages, capped for length.",
      parameters: { type: "object", properties: { chatId: { type: "string", description: "The id of the conversation to read." }, limit: { type: "number", description: "Maximum number of most-recent messages to return (1-200, default 40)." } }, required: ["chatId"], additionalProperties: false },
      skipPermission: true,
      handler: (args) => { const parsed = getArgsSchema.parse(args); return db.getConversationTranscript(ownerId, parsed.chatId, { limit: parsed.limit }); },
    },
  ];
}
