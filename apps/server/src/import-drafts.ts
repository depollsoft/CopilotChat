import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { importDraftSchema, importPreviewRequestSchema } from "@copilotchat/shared";
import type { ImportDraft, ImportPreviewRequest } from "@copilotchat/shared";
import { z } from "zod";

export type ImportProjectAssignment = { conversationSourceId?: string | null; conversationTitle?: string | null; projectName: string };
export type StoredImportDraft = ImportPreviewRequest & ImportDraft & { ownerId: string; assignments: ImportProjectAssignment[] };

const assignmentSchema = z.object({ conversationSourceId: z.string().nullable().optional(), conversationTitle: z.string().nullable().optional(), projectName: z.string().min(1) });
const storedImportDraftSchema = importPreviewRequestSchema.extend(importDraftSchema.shape).extend({ ownerId: z.string(), assignments: z.array(assignmentSchema).default([]) });

export class ImportDraftStore {
  constructor(private readonly rootDir: string) {}

  async create(ownerId: string, input: ImportPreviewRequest): Promise<ImportDraft> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const draft: StoredImportDraft = { ...input, id: randomUUID(), ownerId, createdAt: new Date().toISOString(), assignments: [] };
    await fs.writeFile(this.pathFor(draft.id), JSON.stringify(draft), "utf8");
    return publicDraft(draft);
  }

  async get(ownerId: string, id: string): Promise<StoredImportDraft> {
    const draft = await this.read(id);
    if (draft.ownerId !== ownerId) throw new Error("Import draft not found.");
    return draft;
  }

  async setAssignments(ownerId: string, id: string, assignments: ImportProjectAssignment[]): Promise<StoredImportDraft> {
    const draft = await this.get(ownerId, id);
    const next = { ...draft, assignments: z.array(assignmentSchema).parse(assignments) };
    await fs.writeFile(this.pathFor(id), JSON.stringify(next), "utf8");
    return next;
  }

  async deleteOwner(ownerId: string): Promise<number> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let deleted = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = path.basename(entry, ".json");
      const draft = await this.read(id);
      if (draft.ownerId !== ownerId) continue;
      await fs.unlink(this.pathFor(id));
      deleted += 1;
    }
    return deleted;
  }

  private async read(id: string): Promise<StoredImportDraft> {
    return storedImportDraftSchema.parse(JSON.parse(await fs.readFile(this.pathFor(id), "utf8")) as unknown);
  }

  private pathFor(id: string): string {
    if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error("Invalid import draft id.");
    return path.join(this.rootDir, `${id}.json`);
  }
}

function publicDraft(draft: StoredImportDraft): ImportDraft {
  return { id: draft.id, fileName: draft.fileName, source: draft.source, encoding: draft.encoding, createdAt: draft.createdAt };
}
