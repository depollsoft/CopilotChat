import { previewImportPayload } from "@copilotchat/importers";
import type { ProviderTool } from "@copilotchat/provider";
import type { ImportPreview } from "@copilotchat/shared";
import { z } from "zod";
import type { AppDatabase } from "./db.js";
import { applyImportPreview } from "./import-apply.js";
import type { ImportDraftStore, ImportProjectAssignment, StoredImportDraft } from "./import-drafts.js";

const draftArgsSchema = z.object({ draftId: z.string().min(1) });
const assignmentSchema = z.object({ conversationSourceId: z.string().nullable().optional(), conversationTitle: z.string().nullable().optional(), projectName: z.string().min(1) });
const assignmentArgsSchema = draftArgsSchema.extend({ assignments: z.array(assignmentSchema).default([]) });
const applyArgsSchema = draftArgsSchema.extend({ confirmed: z.boolean().default(false) });

export function buildImportTools(input: { db: AppDatabase; ownerId: string; drafts: ImportDraftStore }): ProviderTool[] {
  return [
    {
      name: "preview_import_draft",
      description: "Preview an uploaded Claude, ChatGPT, or Gemini import draft without applying it.",
      parameters: { type: "object", properties: { draftId: { type: "string", description: "The import draft ID shown in the user's message." } }, required: ["draftId"], additionalProperties: false },
      skipPermission: true,
      handler: async (args) => summarizeImportPreview(await loadPreview(input, draftArgsSchema.parse(args).draftId)),
    },
    {
      name: "set_import_project_assignments",
      description: "Set project assignment overrides for imported conversations using source IDs or exact conversation titles from project conversation lists.",
      parameters: {
        type: "object",
        properties: {
          draftId: { type: "string", description: "The import draft ID." },
          assignments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                conversationSourceId: { type: "string", description: "Source conversation ID when available." },
                conversationTitle: { type: "string", description: "Exact conversation title when source ID is not available." },
                projectName: { type: "string", description: "Project name from the screenshot or pasted list." },
              },
              required: ["projectName"],
              additionalProperties: false,
            },
          },
        },
        required: ["draftId", "assignments"],
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args) => {
        const parsed = assignmentArgsSchema.parse(args);
        const draft = await input.drafts.setAssignments(input.ownerId, parsed.draftId, parsed.assignments);
        const preview = await parseDraft(draft);
        return { ...summarizeImportPreview({ draft, preview }), assignmentOverrides: draft.assignments.length };
      },
    },
    {
      name: "apply_import_draft",
      description: "Apply an import draft to local CopilotChat data after the user confirms the preview and any project assignment corrections.",
      parameters: { type: "object", properties: { draftId: { type: "string", description: "The import draft ID." }, confirmed: { type: "boolean", description: "Must be true only after the user explicitly confirmed applying the import." } }, required: ["draftId", "confirmed"], additionalProperties: false },
      handler: async (args) => {
        const parsed = applyArgsSchema.parse(args);
        if (!parsed.confirmed) throw new Error("Import apply requires explicit user confirmation.");
        const { draft, preview } = await loadPreview(input, parsed.draftId);
        const result = applyImportPreview(input.db, input.ownerId, preview, draft.assignments);
        return { importedConversations: result.imported.length, importedProjects: result.importedProjects, warnings: result.warnings };
      },
    },
  ];
}

async function loadPreview(input: { ownerId: string; drafts: ImportDraftStore }, draftId: string): Promise<{ draft: StoredImportDraft; preview: ImportPreview }> {
  const draft = await input.drafts.get(input.ownerId, draftId);
  return { draft, preview: await parseDraft(draft) };
}

async function parseDraft(draft: StoredImportDraft): Promise<ImportPreview> {
  return previewImportPayload(draft.source, draft.fileName, draft.content, draft.encoding);
}

function summarizeImportPreview(input: { draft: StoredImportDraft; preview: ImportPreview }): Record<string, unknown> {
  const projectNamesBySourceId = new Map(input.preview.projects.map((project) => [project.sourceId, project.name]));
  return {
    draftId: input.draft.id,
    fileName: input.draft.fileName,
    source: input.preview.source,
    conversations: input.preview.conversations.length,
    projects: input.preview.projects.length,
    projectReferences: input.preview.projects.reduce((sum, project) => sum + project.references.length, 0),
    assignmentOverrides: input.draft.assignments.length,
    warnings: input.preview.warnings.slice(0, 10),
    projectSummaries: input.preview.projects.slice(0, 40).map((project) => ({ sourceId: project.sourceId, name: project.name, references: project.references.length })),
    conversationSummaries: input.preview.conversations.slice(0, 120).map((conversation) => ({ sourceId: conversation.sourceId, title: conversation.title, project: assignedProjectName(input.draft.assignments, conversation.sourceId, conversation.title) ?? (conversation.projectSourceId ? projectNamesBySourceId.get(conversation.projectSourceId) ?? conversation.projectSourceId : null), messages: conversation.messages.length })),
    truncatedConversationSummaries: Math.max(0, input.preview.conversations.length - 120),
  };
}

function assignedProjectName(assignments: ImportProjectAssignment[], sourceId: string | null, title: string): string | null {
  const normalizedTitle = normalizeTitle(title);
  return assignments.find((assignment) => (sourceId && assignment.conversationSourceId === sourceId) || (assignment.conversationTitle && normalizeTitle(assignment.conversationTitle) === normalizedTitle))?.projectName ?? null;
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
