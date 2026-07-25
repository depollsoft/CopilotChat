import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { importDraftSchema, importSourceSchema } from "@copilotchat/shared";
import type { ImportDraft, ImportPreviewRequest } from "@copilotchat/shared";
import { z } from "zod";
import type { UploadedFileStore } from "./uploaded-files.js";

export type ImportProjectAssignment = { conversationSourceId?: string | null; conversationTitle?: string | null; projectName: string };
export type StoredImportDraft = Omit<ImportPreviewRequest, "content"> & ImportDraft & { ownerId: string; assignments: ImportProjectAssignment[]; content?: string; contentFile?: string; contentStorage?: "text" | "binary" };
export class ImportLimitError extends Error {}

const persistedAssignmentSchema = z.object({ conversationSourceId: z.string().nullable().optional(), conversationTitle: z.string().nullable().optional(), projectName: z.string().min(1) });
const assignmentSchema = persistedAssignmentSchema.extend({ conversationSourceId: z.string().max(4096).nullable().optional(), conversationTitle: z.string().max(4096).nullable().optional(), projectName: z.string().min(1).max(4096) });
const storedImportDraftSchema = z.object({ source: importSourceSchema, fileName: z.string().min(1), encoding: z.enum(["text", "base64"]) }).extend(importDraftSchema.shape).extend({ ownerId: z.string(), assignments: z.array(persistedAssignmentSchema).default([]), content: z.string().optional(), contentFile: z.string().optional(), contentStorage: z.enum(["text", "binary"]).optional() }).refine((draft) => draft.content || draft.contentFile, { message: "Import draft content is missing." });

export class ImportDraftStore {
  private readonly activeContentFiles = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string, private readonly maxImportBytes = 128 * 1024 * 1024, private readonly maxOwnerDraftBytes = 1024 * 1024 * 1024) {}

  async create(ownerId: string, input: ImportPreviewRequest): Promise<ImportDraft> {
    return this.withOperationLock(() => this.createUnlocked(ownerId, input));
  }

  private async createUnlocked(ownerId: string, input: ImportPreviewRequest): Promise<ImportDraft> {
    assertImportPayloadSize(input, this.maxImportBytes);
    await fs.mkdir(this.rootDir, { recursive: true });
    const id = randomUUID();
    const draft: StoredImportDraft = { source: input.source, fileName: input.fileName, encoding: input.encoding, id, ownerId, createdAt: new Date().toISOString(), assignments: [], contentFile: `${id}.data`, contentStorage: "text" };
    await this.assertOwnerCapacity(ownerId, Buffer.byteLength(input.content) + Buffer.byteLength(JSON.stringify(draft)));
    this.activeContentFiles.add(draft.contentFile!);
    try {
      await fs.writeFile(this.contentPathFor(draft), input.content, { encoding: "utf8", flag: "wx" });
      await fs.writeFile(this.pathFor(draft.id), JSON.stringify(draft), { encoding: "utf8", flag: "wx" });
      return publicDraft(draft);
    } catch (error) {
      await Promise.all([fs.rm(this.contentPathFor(draft), { force: true }), fs.rm(this.pathFor(draft.id), { force: true })]);
      throw error;
    } finally {
      this.activeContentFiles.delete(draft.contentFile!);
    }
  }

  async createFromUpload(ownerId: string, source: ImportPreviewRequest["source"], uploads: UploadedFileStore, uploadId: string, uploadClaimId: string): Promise<ImportDraft> {
    return this.withOperationLock(() => this.createFromUploadUnlocked(ownerId, source, uploads, uploadId, uploadClaimId));
  }

  private async createFromUploadUnlocked(ownerId: string, source: ImportPreviewRequest["source"], uploads: UploadedFileStore, uploadId: string, uploadClaimId: string): Promise<ImportDraft> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const uploaded = await uploads.get(ownerId, uploadId);
    if (uploaded.size > this.maxImportBytes) throw new ImportLimitError(`Import exceeds the ${formatBytes(this.maxImportBytes)} limit.`);
    const id = randomUUID();
    const isZip = uploaded.fileName.toLowerCase().endsWith(".zip");
    const draft: StoredImportDraft = { source, fileName: uploaded.fileName, encoding: isZip ? "base64" : "text", id, ownerId, createdAt: new Date().toISOString(), assignments: [], contentFile: `${id}.data`, contentStorage: isZip ? "binary" : "text" };
    await this.assertOwnerCapacity(ownerId, uploaded.size + Buffer.byteLength(JSON.stringify(draft)));
    this.activeContentFiles.add(draft.contentFile!);
    try {
      await uploads.copyTo(ownerId, uploadId, this.contentPathFor(draft), uploadClaimId);
      await fs.writeFile(this.pathFor(draft.id), JSON.stringify(draft), { encoding: "utf8", flag: "wx" });
      return publicDraft(draft);
    } catch (error) {
      await Promise.all([fs.rm(this.contentPathFor(draft), { force: true }), fs.rm(this.pathFor(draft.id), { force: true })]);
      throw error;
    } finally {
      this.activeContentFiles.delete(draft.contentFile!);
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
    return this.withOperationLock(() => this.setAssignmentsUnlocked(ownerId, id, assignments));
  }

  private async setAssignmentsUnlocked(ownerId: string, id: string, assignments: ImportProjectAssignment[]): Promise<StoredImportDraft> {
    const draft = await this.get(ownerId, id);
    const next = { ...draft, assignments: z.array(assignmentSchema).max(10_000).parse(assignments) };
    const nextMetadata = JSON.stringify(next);
    const currentMetadataBytes = (await fs.stat(this.pathFor(id))).size;
    if (await this.ownerDraftBytes(ownerId) - currentMetadataBytes + Buffer.byteLength(nextMetadata) > this.maxOwnerDraftBytes) throw new ImportLimitError(`Import drafts exceed the ${formatBytes(this.maxOwnerDraftBytes)} per-owner limit.`);
    await fs.writeFile(this.pathFor(id), nextMetadata, "utf8");
    return next;
  }

  async deleteOwner(ownerId: string): Promise<number> {
    return this.withOperationLock(() => this.deleteOwnerUnlocked(ownerId));
  }

  async clearOwner<T>(ownerId: string, action: () => Promise<T>): Promise<T> {
    return this.withOperationLock(async () => {
      const result = await action();
      await this.deleteOwnerUnlocked(ownerId);
      return result;
    });
  }

  private async deleteOwnerUnlocked(ownerId: string): Promise<number> {
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
      await this.deleteDraftFiles(draft);
      deleted += 1;
    }
    await this.cleanupOrphansUnlocked();
    return deleted;
  }

  async delete(ownerId: string, id: string): Promise<void> {
    await this.withOperationLock(async () => {
      const draft = await this.get(ownerId, id);
      await this.deleteDraftFiles(draft);
    });
  }

  async consume<T>(ownerId: string, id: string, action: (draft: StoredImportDraft) => Promise<T> | T): Promise<T> {
    return this.withOperationLock(async () => {
      const draft = await this.get(ownerId, id);
      const result = await action(draft);
      await this.deleteDraftFiles(draft);
      return result;
    });
  }

  async cleanupOrphans(): Promise<number> {
    return this.withOperationLock(() => this.cleanupOrphansUnlocked());
  }

  private async cleanupOrphansUnlocked(): Promise<number> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    const referenced = new Set<string>();
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const value = JSON.parse(await fs.readFile(path.join(this.rootDir, entry), "utf8")) as { contentFile?: unknown };
        if (typeof value.contentFile === "string" && path.basename(value.contentFile) === value.contentFile) referenced.add(value.contentFile);
      } catch {
        referenced.add(`${path.basename(entry, ".json")}.data`);
      }
    }
    let deleted = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".data") || referenced.has(entry) || this.activeContentFiles.has(entry)) continue;
      await fs.rm(path.join(this.rootDir, entry), { force: true });
      deleted += 1;
    }
    return deleted;
  }

  private async withOperationLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async assertOwnerCapacity(ownerId: string, incomingBytes: number): Promise<void> {
    if (await this.ownerDraftBytes(ownerId) + incomingBytes > this.maxOwnerDraftBytes) throw new ImportLimitError(`Import drafts exceed the ${formatBytes(this.maxOwnerDraftBytes)} per-owner limit.`);
  }

  private async ownerDraftBytes(ownerId: string): Promise<number> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let total = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const draft = await this.read(path.basename(entry, ".json"));
        if (draft.ownerId !== ownerId) continue;
        total += (await fs.stat(this.pathFor(draft.id))).size;
        if (draft.contentFile) total += (await fs.stat(this.contentPathFor(draft))).size;
      } catch {
        // Unreadable drafts are retained for recovery but excluded from quota accounting.
      }
    }
    return total;
  }

  private async deleteDraftFiles(draft: StoredImportDraft): Promise<void> {
    if (draft.contentFile) await fs.rm(this.contentPathFor(draft), { force: true });
    await fs.rm(this.pathFor(draft.id), { force: true });
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

export function assertImportPayloadSize(input: Pick<ImportPreviewRequest, "content" | "encoding" | "fileName">, maxImportBytes: number): number {
  if (input.encoding === "base64" && !input.fileName.toLowerCase().endsWith(".zip")) throw new Error("Non-ZIP imports must use text encoding.");
  if (input.encoding === "base64" && (input.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content))) throw new Error("Import file is not valid base64.");
  const size = input.encoding === "base64" ? Buffer.from(input.content, "base64").byteLength : Buffer.byteLength(input.content);
  if (size > maxImportBytes) throw new ImportLimitError(`Import exceeds the ${formatBytes(maxImportBytes)} limit.`);
  return size;
}

function publicDraft(draft: StoredImportDraft): ImportDraft {
  return { id: draft.id, fileName: draft.fileName, source: draft.source, encoding: draft.encoding, createdAt: draft.createdAt };
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}
