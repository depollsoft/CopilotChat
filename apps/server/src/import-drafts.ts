import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { importDraftSchema, importPreviewRequestSchema } from "@copilotchat/shared";
import type { ImportDraft, ImportPreviewRequest } from "@copilotchat/shared";
import { z } from "zod";
import type { UploadedFileStore } from "./uploaded-files.js";

export type ImportProjectAssignment = { conversationSourceId?: string | null; conversationTitle?: string | null; projectName: string };
export type StoredImportDraft = Omit<ImportPreviewRequest, "content"> & ImportDraft & { ownerId: string; assignments: ImportProjectAssignment[]; content?: string; contentFile?: string; contentStorage?: "text" | "binary" };

const assignmentSchema = z.object({ conversationSourceId: z.string().nullable().optional(), conversationTitle: z.string().nullable().optional(), projectName: z.string().min(1) });
const storedImportDraftSchema = importPreviewRequestSchema.omit({ content: true }).extend(importDraftSchema.shape).extend({ ownerId: z.string(), assignments: z.array(assignmentSchema).default([]), content: z.string().optional(), contentFile: z.string().optional(), contentStorage: z.enum(["text", "binary"]).optional() }).refine((draft) => draft.content || draft.contentFile, { message: "Import draft content is missing." });

export class ImportDraftStore {
  constructor(private readonly rootDir: string, private readonly maxImportBytes = 128 * 1024 * 1024) {}

  async create(ownerId: string, input: ImportPreviewRequest): Promise<ImportDraft> {
    if (Buffer.byteLength(input.content) > this.maxImportBytes) throw new Error(`Import exceeds the ${formatBytes(this.maxImportBytes)} limit.`);
    await fs.mkdir(this.rootDir, { recursive: true });
    const id = randomUUID();
    const draft: StoredImportDraft = { source: input.source, fileName: input.fileName, encoding: input.encoding, id, ownerId, createdAt: new Date().toISOString(), assignments: [], contentFile: `${id}.data`, contentStorage: "text" };
    try {
      await fs.writeFile(this.contentPathFor(draft), input.content, { encoding: "utf8", flag: "wx" });
      await fs.writeFile(this.pathFor(draft.id), JSON.stringify(draft), { encoding: "utf8", flag: "wx" });
      return publicDraft(draft);
    } catch (error) {
      await Promise.all([fs.rm(this.contentPathFor(draft), { force: true }), fs.rm(this.pathFor(draft.id), { force: true })]);
      throw error;
    }
  }

  async createFromUpload(ownerId: string, source: ImportPreviewRequest["source"], uploads: UploadedFileStore, uploadId: string, uploadClaimId: string): Promise<ImportDraft> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const uploaded = await uploads.get(ownerId, uploadId);
    if (uploaded.size > this.maxImportBytes) throw new Error(`Import exceeds the ${formatBytes(this.maxImportBytes)} limit.`);
    const id = randomUUID();
    const isZip = uploaded.fileName.toLowerCase().endsWith(".zip");
    const draft: StoredImportDraft = { source, fileName: uploaded.fileName, encoding: isZip ? "base64" : "text", id, ownerId, createdAt: new Date().toISOString(), assignments: [], contentFile: `${id}.data`, contentStorage: isZip ? "binary" : "text" };
    await uploads.copyTo(ownerId, uploadId, this.contentPathFor(draft), uploadClaimId);
    try {
      await fs.writeFile(this.pathFor(draft.id), JSON.stringify(draft), { encoding: "utf8", flag: "wx" });
      return publicDraft(draft);
    } catch (error) {
      await fs.rm(this.contentPathFor(draft), { force: true });
      throw error;
    }
  }

  async get(ownerId: string, id: string): Promise<StoredImportDraft> {
    const draft = await this.read(id);
    if (draft.ownerId !== ownerId) throw new Error("Import draft not found.");
    return draft;
  }

  async readContent(draft: StoredImportDraft): Promise<string | Uint8Array> {
    if (draft.content !== undefined) return draft.content;
    if (!draft.contentFile) throw new Error("Import draft content is missing.");
    return draft.contentStorage === "binary" ? fs.readFile(this.contentPathFor(draft)) : fs.readFile(this.contentPathFor(draft), "utf8");
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
      await Promise.all([fs.unlink(this.pathFor(id)), draft.contentFile ? fs.rm(this.contentPathFor(draft), { force: true }) : Promise.resolve()]);
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

  private contentPathFor(draft: Pick<StoredImportDraft, "contentFile">): string {
    if (!draft.contentFile || path.basename(draft.contentFile) !== draft.contentFile) throw new Error("Invalid import draft content path.");
    return path.join(this.rootDir, draft.contentFile);
  }
}

function publicDraft(draft: StoredImportDraft): ImportDraft {
  return { id: draft.id, fileName: draft.fileName, source: draft.source, encoding: draft.encoding, createdAt: draft.createdAt };
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024 ? `${Math.round(value / 1024 / 1024)} MB` : `${Math.round(value / 1024)} KB`;
}
