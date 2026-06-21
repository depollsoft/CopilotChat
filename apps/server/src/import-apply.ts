import { titleFromContent } from "@copilotchat/shared";
import type { Chat, ImportPreview } from "@copilotchat/shared";
import type { AppDatabase } from "./db.js";
import type { ImportProjectAssignment } from "./import-drafts.js";

export type ApplyImportResult = { imported: Chat[]; importedProjects: number; warnings: string[] };

export function applyImportPreview(db: AppDatabase, ownerId: string, preview: ImportPreview, assignments: ImportProjectAssignment[] = []): ApplyImportResult {
  const imported: Chat[] = [];
  const importedProjects = new Map<string, string>();
  const projectIdsByName = new Map<string, string>();

  for (const project of preview.projects) {
    const created = db.createProject(ownerId, { name: project.name, description: project.description, instructions: project.instructions, memory: project.memory });
    if (project.sourceId) importedProjects.set(project.sourceId, created.id);
    projectIdsByName.set(normalizeName(project.name), created.id);
    for (const reference of project.references) db.createProjectReference(ownerId, { projectId: created.id, title: reference.title, content: reference.content });
  }

  for (const conversation of preview.conversations) {
    const assignedProjectName = findAssignedProjectName(assignments, conversation.sourceId, conversation.title);
    const projectId = assignedProjectName ? ensureProject(db, ownerId, projectIdsByName, assignedProjectName) : conversation.projectSourceId ? importedProjects.get(conversation.projectSourceId) ?? null : null;
    const chat = db.createChat(ownerId, { title: conversation.title || titleFromContent(conversation.messages[0]?.content ?? ""), projectId, workspaceId: null });
    for (const message of conversation.messages) db.addMessage({ chatId: chat.id, role: message.role, content: message.content, createdAt: message.createdAt, metadata: { ...message.metadata, importedFrom: conversation.source, sourceConversationId: conversation.sourceId } });
    for (const artifact of conversation.artifacts) db.createArtifact(ownerId, { chatId: chat.id, projectId, messageId: artifact.messageId, title: artifact.title, kind: artifact.kind, language: artifact.language, content: artifact.content });
    for (const helper of conversation.reusableHelpers) db.upsertSkill(ownerId, helper, false, projectId);
    imported.push(chat);
  }

  return { imported, importedProjects: projectIdsByName.size, warnings: preview.warnings };
}

function ensureProject(db: AppDatabase, ownerId: string, projectIdsByName: Map<string, string>, projectName: string): string {
  const key = normalizeName(projectName);
  const existing = projectIdsByName.get(key);
  if (existing) return existing;
  const created = db.createProject(ownerId, { name: projectName.trim(), description: null, instructions: null, memory: null });
  projectIdsByName.set(key, created.id);
  return created.id;
}

function findAssignedProjectName(assignments: ImportProjectAssignment[], sourceId: string | null, title: string): string | null {
  const normalizedTitle = normalizeName(title);
  const assignment = assignments.find((item) => (sourceId && item.conversationSourceId === sourceId) || (item.conversationTitle && normalizeName(item.conversationTitle) === normalizedTitle));
  return assignment?.projectName.trim() || null;
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
