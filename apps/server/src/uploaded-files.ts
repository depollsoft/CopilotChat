import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MessageAttachment } from "@copilotchat/shared";
import { z } from "zod";

const uploadedFileSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string(),
});

export type UploadedFile = z.infer<typeof uploadedFileSchema>;
export class UploadLimitError extends Error {}
export class UploadValidationError extends Error {}
/** Raised when a chunk does not continue from the bytes already stored, so the client can resume from `received`. */
export class UploadOffsetError extends Error {
  constructor(message: string, readonly received: number) { super(message); }
}

/** An upload still being assembled from chunks, so it survives request boundaries imposed by proxy body limits. */
type ChunkedUpload = { id: string; ownerId: string; fileName: string; mimeType: string; size: number; received: number; handle: FileHandle; releaseReservation: () => void; updatedAt: number; busy: boolean };

export class UploadedFileStore {
  private readonly claimsByUpload = new Map<string, { claimId: string; ownerId: string }>();
  private readonly uploadsByClaim = new Map<string, { ownerId: string; uploadIds: string[] }>();
  private readonly deletingUploads = new Set<string>();
  private readonly activeUploadIds = new Set<string>();
  private readonly chunkedUploads = new Map<string, ChunkedUpload>();
  private readonly reservationsByOwner = new Map<string, { bytes: number; count: number }>();
  private readonly activeOperationsByOwner = new Map<string, number>();
  private readonly ownerIdleWaiters = new Map<string, Set<() => void>>();
  private readonly deletingOwners = new Set<string>();
  private readonly ownerDeletionQueue = new Map<string, Promise<void>>();
  private quotaQueue: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string, private readonly maxBytes: number, private readonly maxStagedBytes = maxBytes, private readonly maxStagedFiles = 100, private readonly chunkSessionTtlMs = 60 * 60 * 1000) {}

  /** Opens an upload that is filled by repeated `appendChunk` calls, keeping every request small enough for proxies. */
  async beginChunked(ownerId: string, input: { fileName: string; mimeType: string; size: number }): Promise<{ uploadId: string; received: number }> {
    const fileName = this.validateUploadInput(input);
    this.beginOwnerOperation(ownerId);
    const id = randomUUID();
    let releaseReservation: (() => void) | null = null;
    try {
      await fs.mkdir(this.rootDir, { recursive: true });
      releaseReservation = await this.reserve(ownerId, input.size);
      this.activeUploadIds.add(id);
      const handle = await fs.open(`${this.dataPath(id)}.part`, "wx");
      this.chunkedUploads.set(id, { id, ownerId, fileName, mimeType: input.mimeType, size: input.size, received: 0, handle, releaseReservation, updatedAt: Date.now(), busy: false });
      return { uploadId: id, received: 0 };
    } catch (error) {
      this.activeUploadIds.delete(id);
      await fs.rm(`${this.dataPath(id)}.part`, { force: true });
      if (releaseReservation) await this.withQuotaLock(async () => releaseReservation?.());
      throw error;
    } finally {
      this.endOwnerOperation(ownerId);
    }
  }

  /** Writes `chunk` at `offset`. Re-sending the previous chunk is safe because bytes are written by position. */
  async appendChunk(ownerId: string, uploadId: string, offset: number, chunk: Buffer): Promise<{ received: number; size: number }> {
    const upload = this.chunkedUpload(ownerId, uploadId);
    if (upload.busy) throw new UploadValidationError("Another chunk of this upload is still being written.");
    if (offset > upload.received) throw new UploadOffsetError(`Upload is missing bytes before offset ${offset}.`, upload.received);
    if (offset + chunk.length > upload.size) throw new UploadValidationError("Upload contained more bytes than declared.");
    this.beginOwnerOperation(ownerId);
    upload.busy = true;
    try {
      if (chunk.length > 0) await upload.handle.write(chunk, 0, chunk.length, offset);
      upload.received = Math.max(upload.received, offset + chunk.length);
      upload.updatedAt = Date.now();
      return { received: upload.received, size: upload.size };
    } catch (error) {
      await this.abortChunked(ownerId, uploadId).catch(() => undefined);
      throw error;
    } finally {
      upload.busy = false;
      this.endOwnerOperation(ownerId);
    }
  }

  /** Seals a chunked upload into the same staged file a single-request upload produces. */
  async finishChunked(ownerId: string, uploadId: string): Promise<MessageAttachment> {
    const upload = this.chunkedUpload(ownerId, uploadId);
    if (upload.busy) throw new UploadValidationError("Another chunk of this upload is still being written.");
    this.beginOwnerOperation(ownerId);
    upload.busy = true;
    const temporaryPath = `${this.dataPath(uploadId)}.part`;
    try {
      if (upload.received !== upload.size) throw new UploadValidationError(`Upload size mismatch: expected ${upload.size} bytes but received ${upload.received}.`);
      await upload.handle.close();
      const stat = await fs.stat(temporaryPath);
      if (stat.size !== upload.size) throw new UploadValidationError(`Upload size mismatch: expected ${upload.size} bytes but stored ${stat.size}.`);
      const uploaded: UploadedFile = { id: uploadId, ownerId, fileName: upload.fileName, mimeType: upload.mimeType, size: upload.size, sha256: await hashFile(temporaryPath), createdAt: new Date().toISOString() };
      this.chunkedUploads.delete(uploadId);
      await this.withQuotaLock(async () => {
        await fs.rename(temporaryPath, this.dataPath(uploadId));
        const metadataTemporaryPath = `${this.metadataPath(uploadId)}.part`;
        await fs.writeFile(metadataTemporaryPath, JSON.stringify(uploaded), { encoding: "utf8", flag: "wx" });
        await fs.rename(metadataTemporaryPath, this.metadataPath(uploadId));
        upload.releaseReservation();
      });
      return { id: uploaded.id, uploadId: uploaded.id, name: uploaded.fileName, mimeType: uploaded.mimeType, size: uploaded.size };
    } catch (error) {
      this.chunkedUploads.set(uploadId, upload);
      await this.abortChunked(ownerId, uploadId).catch(() => undefined);
      throw error;
    } finally {
      upload.busy = false;
      this.activeUploadIds.delete(uploadId);
      this.endOwnerOperation(ownerId);
    }
  }

  async abortChunked(ownerId: string, uploadId: string): Promise<void> {
    const upload = this.chunkedUploads.get(uploadId);
    if (!upload) return;
    if (upload.ownerId !== ownerId) throw new UploadValidationError("Upload session not found.");
    this.chunkedUploads.delete(uploadId);
    await upload.handle.close().catch(() => undefined);
    await Promise.all([fs.rm(`${this.dataPath(uploadId)}.part`, { force: true }), fs.rm(this.dataPath(uploadId), { force: true }), fs.rm(this.metadataPath(uploadId), { force: true })]);
    await this.withQuotaLock(async () => upload.releaseReservation());
    this.activeUploadIds.delete(uploadId);
  }

  private chunkedUpload(ownerId: string, uploadId: string): ChunkedUpload {
    const upload = this.chunkedUploads.get(uploadId);
    if (!upload || upload.ownerId !== ownerId) throw new UploadValidationError("Upload session not found. Start the upload again.");
    return upload;
  }

  private validateUploadInput(input: { fileName: string; size: number }): string {
    if (input.size > this.maxBytes) throw new UploadLimitError(`Upload exceeds the ${formatBytes(this.maxBytes)} limit.`);
    const fileName = path.basename(input.fileName).trim();
    if (!fileName || fileName === "." || fileName === "..") throw new UploadValidationError("Upload requires a valid file name.");
    return fileName;
  }

  async create(ownerId: string, input: { fileName: string; mimeType: string; size: number }, source: Readable): Promise<MessageAttachment> {
    const fileName = this.validateUploadInput(input);
    this.beginOwnerOperation(ownerId);
    const id = randomUUID();
    let releaseReservation: (() => void) | null = null;
    try {
      await fs.mkdir(this.rootDir, { recursive: true });
      releaseReservation = await this.reserve(ownerId, input.size);
      this.activeUploadIds.add(id);
      const temporaryPath = `${this.dataPath(id)}.part`;
      let received = 0;
      const hash = createHash("sha256");
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > input.size) { callback(new UploadValidationError("Upload contained more bytes than declared.")); return; }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(source, limiter, createWriteStream(temporaryPath, { flags: "wx" }));
      if (received !== input.size) throw new UploadValidationError(`Upload size mismatch: expected ${input.size} bytes but received ${received}.`);
      const uploaded: UploadedFile = { id, ownerId, fileName, mimeType: input.mimeType, size: input.size, sha256: hash.digest("hex"), createdAt: new Date().toISOString() };
      await this.withQuotaLock(async () => {
        await fs.rename(temporaryPath, this.dataPath(uploaded.id));
        const metadataTemporaryPath = `${this.metadataPath(uploaded.id)}.part`;
        await fs.writeFile(metadataTemporaryPath, JSON.stringify(uploaded), { encoding: "utf8", flag: "wx" });
        await fs.rename(metadataTemporaryPath, this.metadataPath(uploaded.id));
        releaseReservation?.();
        releaseReservation = null;
      });
      return { id: uploaded.id, uploadId: uploaded.id, name: uploaded.fileName, mimeType: uploaded.mimeType, size: uploaded.size };
    } catch (error) {
      await Promise.all([fs.rm(`${this.dataPath(id)}.part`, { force: true }), fs.rm(this.dataPath(id), { force: true }), fs.rm(`${this.metadataPath(id)}.part`, { force: true }), fs.rm(this.metadataPath(id), { force: true })]);
      throw error;
    } finally {
      this.activeUploadIds.delete(id);
      if (releaseReservation) await this.withQuotaLock(async () => { releaseReservation?.(); releaseReservation = null; });
      this.endOwnerOperation(ownerId);
    }
  }

  async get(ownerId: string, id: string): Promise<UploadedFile> {
    const uploaded = uploadedFileSchema.parse(JSON.parse(await fs.readFile(this.metadataPath(id), "utf8")) as unknown);
    if (uploaded.ownerId !== ownerId) throw new Error("Uploaded file not found.");
    return uploaded;
  }

  async claim(ownerId: string, uploadIds: string[]): Promise<string | null> {
    if (uploadIds.length === 0) return null;
    this.beginOwnerOperation(ownerId);
    try {
      const uniqueIds = [...new Set(uploadIds)];
      if (uniqueIds.length !== uploadIds.length) throw new Error("Each staged upload can only be claimed once.");
      await Promise.all(uniqueIds.map((id) => this.get(ownerId, id)));
      for (const id of uniqueIds) if (this.claimsByUpload.has(id) || this.deletingUploads.has(id)) throw new Error("Uploaded file is already in use.");
      const claimId = randomUUID();
      for (const id of uniqueIds) this.claimsByUpload.set(id, { claimId, ownerId });
      this.uploadsByClaim.set(claimId, { ownerId, uploadIds: uniqueIds });
      return claimId;
    } finally {
      this.endOwnerOperation(ownerId);
    }
  }

  async copyTo(ownerId: string, id: string, targetPath: string, claimId: string): Promise<UploadedFile> {
    this.beginOwnerOperation(ownerId);
    try {
      const claim = this.claimsByUpload.get(id);
      if (!claim || claim.ownerId !== ownerId || claim.claimId !== claimId) throw new Error("Uploaded file is not claimed by this request.");
      const uploaded = await this.get(ownerId, id);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const temporaryPath = `${targetPath}.${randomUUID()}.part`;
      try {
        await fs.copyFile(this.dataPath(id), temporaryPath, constants.COPYFILE_EXCL);
        const targetStat = await fs.stat(temporaryPath);
        if (targetStat.size !== uploaded.size) throw new Error(`Upload ${uploaded.fileName} was not copied completely.`);
        await replaceFile(temporaryPath, targetPath);
      } finally {
        await fs.rm(temporaryPath, { force: true });
      }
      return uploaded;
    } finally {
      this.endOwnerOperation(ownerId);
    }
  }

  async delete(ownerId: string, id: string): Promise<void> {
    this.beginOwnerOperation(ownerId);
    try {
      if (this.claimsByUpload.has(id)) throw new Error("Uploaded file is currently in use.");
      if (this.deletingUploads.has(id)) throw new Error("Uploaded file is already being deleted.");
      this.deletingUploads.add(id);
      try {
        await this.get(ownerId, id);
        if (this.claimsByUpload.has(id)) throw new Error("Uploaded file is currently in use.");
        await this.deleteFiles(id);
      } finally {
        this.deletingUploads.delete(id);
      }
    } finally {
      this.endOwnerOperation(ownerId);
    }
  }

  async completeClaim(ownerId: string, claimId: string): Promise<void> {
    this.beginOwnerOperation(ownerId);
    try {
      const claim = this.uploadsByClaim.get(claimId);
      if (!claim) return;
      if (claim.ownerId !== ownerId) throw new Error("Upload claim not found.");
      const errors: unknown[] = [];
      for (const id of claim.uploadIds) {
        try {
          await this.deleteFiles(id);
        } catch (error) {
          errors.push(error);
        } finally {
          this.claimsByUpload.delete(id);
        }
      }
      this.uploadsByClaim.delete(claimId);
      if (errors.length > 0) throw new AggregateError(errors, "Could not remove claimed uploads.");
    } finally {
      this.endOwnerOperation(ownerId);
    }
  }

  abandonClaim(ownerId: string, claimId: string): void {
    const claim = this.uploadsByClaim.get(claimId);
    if (!claim) return;
    if (claim.ownerId !== ownerId) throw new Error("Upload claim not found.");
    for (const id of claim.uploadIds) this.claimsByUpload.delete(id);
    this.uploadsByClaim.delete(claimId);
  }

  async deleteOwner(ownerId: string): Promise<number> {
    return this.withOwnerDeletion(ownerId, () => this.deleteOwnerFiles(ownerId));
  }

  async clearOwner<T>(ownerId: string, action: () => Promise<T>): Promise<T> {
    return this.withOwnerDeletion(ownerId, async () => {
      const result = await action();
      await this.deleteOwnerFiles(ownerId);
      return result;
    });
  }

  private async deleteOwnerFiles(ownerId: string): Promise<number> {
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
      if (this.activeUploadIds.has(id)) continue;
      const uploaded = await this.safeRead(id);
      if (!uploaded) {
        await Promise.all([fs.rm(this.dataPath(id), { force: true }), fs.rm(this.metadataPath(id), { force: true })]);
        continue;
      }
      if (uploaded.ownerId !== ownerId) continue;
      const claim = this.claimsByUpload.get(id);
      if (claim) this.abandonClaim(ownerId, claim.claimId);
      await this.deleteFiles(id);
      deleted += 1;
    }
    return deleted;
  }

  async cleanupExpired(): Promise<void> {
    await this.expireChunkedUploads();
    await this.withQuotaLock(async () => this.cleanupExpiredUnlocked());
  }

  /** Abandoned chunked uploads hold staged-quota reservations, so they are released well before the 24 hour file sweep. */
  private async expireChunkedUploads(): Promise<void> {
    const cutoff = Date.now() - this.chunkSessionTtlMs;
    for (const upload of [...this.chunkedUploads.values()]) {
      if (upload.busy || upload.updatedAt > cutoff) continue;
      await this.abortChunked(upload.ownerId, upload.id).catch(() => undefined);
    }
  }

  private async cleanupExpiredUnlocked(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const metadataIds = new Set(entries.filter((entry) => entry.endsWith(".json")).map((entry) => path.basename(entry, ".json")));
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = path.basename(entry, ".json");
      if (this.activeUploadIds.has(id) || this.claimsByUpload.has(id) || this.deletingUploads.has(id)) continue;
      this.deletingUploads.add(id);
      try {
        if (this.claimsByUpload.has(id)) continue;
        const uploaded = await this.safeRead(id);
        if (!uploaded) {
          await Promise.all([fs.rm(this.dataPath(id), { force: true }), fs.rm(this.metadataPath(id), { force: true })]);
          continue;
        }
        try {
          await fs.access(this.dataPath(id));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await fs.rm(this.metadataPath(id), { force: true });
          continue;
        }
        if (new Date(uploaded.createdAt).getTime() >= cutoff || this.claimsByUpload.has(id)) continue;
        await Promise.all([fs.rm(this.dataPath(id), { force: true }), fs.rm(this.metadataPath(id), { force: true })]);
      } finally {
        this.deletingUploads.delete(id);
      }
    }
    for (const entry of entries) {
      const uploadId = entry.endsWith(".upload.part") ? entry.slice(0, -".upload.part".length) : entry.endsWith(".json.part") ? entry.slice(0, -".json.part".length) : entry.endsWith(".upload") ? entry.slice(0, -".upload".length) : null;
      if (!uploadId || this.activeUploadIds.has(uploadId) || (entry.endsWith(".upload") && metadataIds.has(uploadId))) continue;
      const stat = await fs.stat(path.join(this.rootDir, entry)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (stat && stat.mtimeMs < cutoff) await fs.rm(path.join(this.rootDir, entry), { force: true });
    }
  }

  private async safeRead(id: string): Promise<UploadedFile | null> {
    try {
      const parsed = uploadedFileSchema.safeParse(JSON.parse(await fs.readFile(this.metadataPath(id), "utf8")) as unknown);
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async reserve(ownerId: string, size: number): Promise<() => void> {
    await this.withQuotaLock(async () => {
      await this.cleanupExpiredUnlocked();
      const usage = await this.ownerUsage(ownerId);
      const reserved = this.reservationsByOwner.get(ownerId) ?? { bytes: 0, count: 0 };
      if (usage.bytes + reserved.bytes + size > this.maxStagedBytes) throw new UploadLimitError(`Staged uploads exceed the ${formatBytes(this.maxStagedBytes)} per-owner limit.`);
      if (usage.count + reserved.count + 1 > this.maxStagedFiles) throw new UploadLimitError(`Staged uploads exceed the ${this.maxStagedFiles}-file per-owner limit.`);
      this.reservationsByOwner.set(ownerId, { bytes: reserved.bytes + size, count: reserved.count + 1 });
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const reserved = this.reservationsByOwner.get(ownerId);
      if (!reserved) return;
      const next = { bytes: Math.max(0, reserved.bytes - size), count: Math.max(0, reserved.count - 1) };
      if (next.bytes === 0 && next.count === 0) this.reservationsByOwner.delete(ownerId);
      else this.reservationsByOwner.set(ownerId, next);
    };
  }

  private async ownerUsage(ownerId: string): Promise<{ bytes: number; count: number }> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: 0, count: 0 };
      throw error;
    }
    let bytes = 0;
    let count = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const uploaded = await this.safeRead(path.basename(entry, ".json"));
      if (!uploaded || uploaded.ownerId !== ownerId) continue;
      bytes += uploaded.size;
      count += 1;
    }
    return { bytes, count };
  }

  private async withQuotaLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.quotaQueue;
    let release!: () => void;
    this.quotaQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private beginOwnerOperation(ownerId: string): void {
    if (this.deletingOwners.has(ownerId)) throw new UploadValidationError("Uploads are unavailable while this owner's data is being cleared.");
    this.activeOperationsByOwner.set(ownerId, (this.activeOperationsByOwner.get(ownerId) ?? 0) + 1);
  }

  private endOwnerOperation(ownerId: string): void {
    const next = Math.max(0, (this.activeOperationsByOwner.get(ownerId) ?? 1) - 1);
    if (next > 0) { this.activeOperationsByOwner.set(ownerId, next); return; }
    this.activeOperationsByOwner.delete(ownerId);
    const waiters = this.ownerIdleWaiters.get(ownerId);
    this.ownerIdleWaiters.delete(ownerId);
    for (const resolve of waiters ?? []) resolve();
  }

  private async waitForOwnerIdle(ownerId: string): Promise<void> {
    if (!this.activeOperationsByOwner.has(ownerId)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.ownerIdleWaiters.get(ownerId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.ownerIdleWaiters.set(ownerId, waiters);
    });
  }

  private async withOwnerDeletion<T>(ownerId: string, action: () => Promise<T>): Promise<T> {
    this.deletingOwners.add(ownerId);
    const previous = this.ownerDeletionQueue.get(ownerId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.ownerDeletionQueue.set(ownerId, tail);
    await previous;
    await this.waitForOwnerIdle(ownerId);
    try {
      return await action();
    } finally {
      release();
      if (this.ownerDeletionQueue.get(ownerId) === tail) {
        this.ownerDeletionQueue.delete(ownerId);
        this.deletingOwners.delete(ownerId);
      }
    }
  }

  private async deleteFiles(id: string): Promise<void> {
    await Promise.all([fs.rm(this.dataPath(id), { force: true }), fs.rm(this.metadataPath(id), { force: true })]);
  }

  private metadataPath(id: string): string {
    return path.join(this.rootDir, `${safeId(id)}.json`);
  }

  private dataPath(id: string): string {
    return path.join(this.rootDir, `${safeId(id)}.upload`);
  }
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error("Invalid upload id.");
  return id;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024 * 1024) return `${Math.round(value / 1024 / 1024 / 1024)} GB`;
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

async function replaceFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") throw error;
    await fs.rm(targetPath, { force: true });
    await fs.rename(sourcePath, targetPath);
  }
}
