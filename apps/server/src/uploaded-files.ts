import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
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

export class UploadedFileStore {
  private readonly claimsByUpload = new Map<string, { claimId: string; ownerId: string }>();
  private readonly uploadsByClaim = new Map<string, { ownerId: string; uploadIds: string[] }>();

  constructor(private readonly rootDir: string, private readonly maxBytes: number) {}

  async create(ownerId: string, input: { fileName: string; mimeType: string; size: number }, source: Readable): Promise<MessageAttachment> {
    if (input.size > this.maxBytes) throw new Error(`Upload exceeds the ${formatBytes(this.maxBytes)} limit.`);
    await fs.mkdir(this.rootDir, { recursive: true });
    await this.deleteExpired();
    const fileName = path.basename(input.fileName).trim();
    if (!fileName || fileName === "." || fileName === "..") throw new Error("Upload requires a valid file name.");
    const id = randomUUID();
    const temporaryPath = `${this.dataPath(id)}.part`;
    let received = 0;
    const hash = createHash("sha256");
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > input.size) { callback(new Error("Upload contained more bytes than declared.")); return; }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(source, limiter, createWriteStream(temporaryPath, { flags: "wx" }));
      if (received !== input.size) throw new Error(`Upload size mismatch: expected ${input.size} bytes but received ${received}.`);
      const uploaded: UploadedFile = { id, ownerId, fileName, mimeType: input.mimeType, size: input.size, sha256: hash.digest("hex"), createdAt: new Date().toISOString() };
      await fs.rename(temporaryPath, this.dataPath(uploaded.id));
      await fs.writeFile(this.metadataPath(uploaded.id), JSON.stringify(uploaded), { encoding: "utf8", flag: "wx" });
      return { id: uploaded.id, uploadId: uploaded.id, name: uploaded.fileName, mimeType: uploaded.mimeType, size: uploaded.size };
    } catch (error) {
      await Promise.all([fs.rm(temporaryPath, { force: true }), fs.rm(this.dataPath(id), { force: true }), fs.rm(this.metadataPath(id), { force: true })]);
      throw error;
    }
  }

  async get(ownerId: string, id: string): Promise<UploadedFile> {
    const uploaded = uploadedFileSchema.parse(JSON.parse(await fs.readFile(this.metadataPath(id), "utf8")) as unknown);
    if (uploaded.ownerId !== ownerId) throw new Error("Uploaded file not found.");
    return uploaded;
  }

  async claim(ownerId: string, uploadIds: string[]): Promise<string | null> {
    const uniqueIds = [...new Set(uploadIds)];
    if (uniqueIds.length === 0) return null;
    if (uniqueIds.length !== uploadIds.length) throw new Error("Each staged upload can only be claimed once.");
    await Promise.all(uniqueIds.map((id) => this.get(ownerId, id)));
    for (const id of uniqueIds) if (this.claimsByUpload.has(id)) throw new Error("Uploaded file is already in use.");
    const claimId = randomUUID();
    for (const id of uniqueIds) this.claimsByUpload.set(id, { claimId, ownerId });
    this.uploadsByClaim.set(claimId, { ownerId, uploadIds: uniqueIds });
    return claimId;
  }

  async copyTo(ownerId: string, id: string, targetPath: string, claimId: string): Promise<UploadedFile> {
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
  }

  async delete(ownerId: string, id: string): Promise<void> {
    if (this.claimsByUpload.has(id)) throw new Error("Uploaded file is currently in use.");
    await this.get(ownerId, id);
    await this.deleteFiles(id);
  }

  async completeClaim(ownerId: string, claimId: string): Promise<void> {
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
  }

  abandonClaim(ownerId: string, claimId: string): void {
    const claim = this.uploadsByClaim.get(claimId);
    if (!claim) return;
    if (claim.ownerId !== ownerId) throw new Error("Upload claim not found.");
    for (const id of claim.uploadIds) this.claimsByUpload.delete(id);
    this.uploadsByClaim.delete(claimId);
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

  private async deleteExpired(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = path.basename(entry, ".json");
      if (this.claimsByUpload.has(id)) continue;
      const uploaded = await this.safeRead(id);
      if (!uploaded) {
        await Promise.all([fs.rm(this.dataPath(id), { force: true }), fs.rm(this.metadataPath(id), { force: true })]);
        continue;
      }
      if (new Date(uploaded.createdAt).getTime() >= cutoff) continue;
      await Promise.all([fs.rm(this.dataPath(id), { force: true }), fs.rm(this.metadataPath(id), { force: true })]);
    }
  }

  private async safeRead(id: string): Promise<UploadedFile | null> {
    try {
      const parsed = uploadedFileSchema.safeParse(JSON.parse(await fs.readFile(this.metadataPath(id), "utf8")) as unknown);
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
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
