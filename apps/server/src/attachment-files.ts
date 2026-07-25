import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { MessageAttachment } from "@copilotchat/shared";
import { assertNoSymlink, isPathInside, safePathSegment } from "./path-guards.js";
import type { AppDatabase } from "./db.js";
import type { UploadedFileStore } from "./uploaded-files.js";

const attachmentDirectoryName = ".copilotchat/uploads";
const attachmentCountLimit = 20;
type ValidatedFileIdentity = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; digest: string };
const validatedFiles = new Map<string, ValidatedFileIdentity>();
const validatedFileCacheLimit = 2048;

export type MaterializedMessageAttachments = { attachments: MessageAttachment[]; uploadIds: string[]; createdFilePaths: string[] };

export async function materializeMessageAttachments(input: { uploads: UploadedFileStore; ownerId: string; chatId: string; workspaceDir: string; maxBytes: number; uploadClaimId?: string | null; attachments?: MessageAttachment[] }): Promise<MaterializedMessageAttachments> {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return { attachments: [], uploadIds: [], createdFilePaths: [] };
  if (attachments.length > attachmentCountLimit) throw new Error(`A message can include at most ${attachmentCountLimit} attachments.`);
  if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) throw new Error("Attachment IDs must be unique within a message.");
  const uploadIds = attachments.flatMap((attachment) => attachment.uploadId ? [attachment.uploadId] : []);
  if (new Set(uploadIds).size !== uploadIds.length) throw new Error("Each staged upload can only be attached once per message.");
  if (uploadIds.length > 0 && !input.uploadClaimId) throw new Error("Staged attachments require an upload claim.");
  const uploadedFiles = new Map(await Promise.all(uploadIds.map(async (uploadId) => [uploadId, await input.uploads.get(input.ownerId, uploadId)] as const)));
  const totalBytes = attachments.reduce((total, attachment) => total + (attachment.uploadId ? uploadedFiles.get(attachment.uploadId)!.size : attachment.size), 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > input.maxBytes) throw new Error("Combined attachment size exceeds the upload limit.");
  const directory = chatAttachmentDirectory(input.workspaceDir, input.chatId);
  await prepareAttachmentDirectory(input.workspaceDir, directory);
  const materialized: MessageAttachment[] = [];
  const createdFilePaths: string[] = [];
  const createdThisAttempt: string[] = [];
  try {
    for (const attachment of attachments) {
      if (attachment.filePath) {
        materialized.push(await validateExistingAttachment(directory, attachment));
        continue;
      }
      if (attachment.uploadId) {
        const uploaded = uploadedFiles.get(attachment.uploadId)!;
        const targetPath = path.join(directory, attachmentFileName(attachment, uploaded.sha256));
        await assertNoSymlink(targetPath, "Attachment path must not be a symlink.");
        const existed = await pathExists(targetPath);
        await input.uploads.copyTo(input.ownerId, attachment.uploadId, targetPath, input.uploadClaimId!);
        const materializedAttachment = { id: attachment.id, name: uploaded.fileName, mimeType: uploaded.mimeType, size: uploaded.size, filePath: targetPath };
        await validateManagedAttachmentFile(targetPath, materializedAttachment);
        materialized.push(materializedAttachment);
        if (!existed) { createdFilePaths.push(targetPath); createdThisAttempt.push(targetPath); }
        continue;
      }
      if (!attachment.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data)) throw new Error(`Attachment ${attachment.name} is not valid base64.`);
      const content = Buffer.from(attachment.data, "base64");
      if (content.byteLength !== attachment.size) throw new Error(`Attachment ${attachment.name} size does not match its content.`);
      const contentDigest = createHash("sha256").update(content).digest("hex");
      const targetPath = path.join(directory, attachmentFileName(attachment, contentDigest));
      await assertNoSymlink(targetPath, "Attachment path must not be a symlink.");
      const existed = await pathExists(targetPath);
      await writeFileAtomically(targetPath, content);
      const materializedAttachment = { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, filePath: targetPath };
      await validateManagedAttachmentFile(targetPath, materializedAttachment);
      materialized.push(materializedAttachment);
      if (!existed) { createdFilePaths.push(targetPath); createdThisAttempt.push(targetPath); }
    }
    return { attachments: materialized, uploadIds, createdFilePaths };
  } catch (error) {
    await Promise.all(createdThisAttempt.map((filePath) => fs.rm(filePath, { force: true })));
    throw error;
  }
}

export function chatAttachmentDirectory(workspaceDir: string, chatId: string): string {
  return path.join(workspaceDir, attachmentDirectoryName, safePathSegment(chatId));
}

export async function relocateChatAttachments(input: { db: AppDatabase; ownerId: string; chatId: string; workspaceDir: string; onMissing?: (attachment: MessageAttachment) => void }): Promise<void> {
  const attachments = input.db.listChatAttachmentFiles(input.ownerId, input.chatId);
  if (attachments.length === 0) return;
  const directory = chatAttachmentDirectory(input.workspaceDir, input.chatId);
  await prepareAttachmentDirectory(input.workspaceDir, directory);
  const directoryRealPath = await fs.realpath(directory);
  for (const attachment of attachments) {
    let sourcePath: string;
    try {
      sourcePath = await fs.realpath(attachment.filePath!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      input.db.updateMessageAttachmentFilePath(input.ownerId, input.chatId, attachment.id, null);
      input.onMissing?.(attachment);
      continue;
    }
    if (!isChatAttachmentDirectory(path.dirname(sourcePath), input.chatId)) throw new Error(`Attachment ${attachment.name} is outside a managed chat upload directory.`);
    try {
      await validateManagedAttachmentFile(sourcePath, attachment);
    } catch {
      validatedFiles.delete(sourcePath);
      input.db.updateMessageAttachmentFilePath(input.ownerId, input.chatId, attachment.id, null);
      input.onMissing?.(attachment);
      continue;
    }
    if (isPathInside(directoryRealPath, sourcePath)) continue;
    const targetPath = path.join(directoryRealPath, path.basename(sourcePath));
    await assertNoSymlink(targetPath, "Attachment path must not be a symlink.");
    await copyFileAtomically(sourcePath, targetPath);
    await validateManagedAttachmentFile(targetPath, attachment);
    input.db.updateMessageAttachmentFilePath(input.ownerId, input.chatId, attachment.id, targetPath);
    await fs.rm(sourcePath, { force: true });
    validatedFiles.delete(sourcePath);
    await fs.rmdir(path.dirname(sourcePath)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
  }
}

export function isChatAttachmentDirectory(directory: string, chatId: string): boolean {
  const resolved = path.resolve(directory);
  return path.basename(resolved) === safePathSegment(chatId)
    && path.basename(path.dirname(resolved)) === "uploads"
    && path.basename(path.dirname(path.dirname(resolved))) === ".copilotchat";
}

export function forgetValidatedAttachmentFiles(paths: string[]): void {
  for (const filePath of paths) validatedFiles.delete(filePath);
}

export function forgetValidatedAttachmentTree(rootPath: string): void {
  for (const filePath of validatedFiles.keys()) if (isPathInside(rootPath, filePath)) validatedFiles.delete(filePath);
}

export async function reconcileAttachmentFiles(input: { db: AppDatabase; isolatedWorkspaceRoot: string }): Promise<number> {
  const referenced = new Set(input.db.listAllAttachmentFilePaths().map((filePath) => path.resolve(filePath)));
  let deleted = 0;
  for (const workspaceRoot of input.db.listAllWorkspaceRoots()) deleted += await cleanManagedUploadRoot(path.join(workspaceRoot, attachmentDirectoryName), referenced);
  let isolatedWorkspaces: Dirent[];
  try {
    isolatedWorkspaces = await fs.readdir(input.isolatedWorkspaceRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return deleted;
    throw error;
  }
  for (const workspace of isolatedWorkspaces) {
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) continue;
    deleted += await cleanManagedUploadRoot(path.join(input.isolatedWorkspaceRoot, workspace.name, attachmentDirectoryName), referenced);
  }
  return deleted;
}

async function prepareAttachmentDirectory(workspaceDir: string, directory: string): Promise<void> {
  const root = path.resolve(workspaceDir);
  const copilotChatDir = path.join(root, ".copilotchat");
  const uploadsDir = path.join(copilotChatDir, "uploads");
  await assertNoSymlink(copilotChatDir, "Attachment directory must not be a symlink.");
  await assertNoSymlink(uploadsDir, "Attachment directory must not be a symlink.");
  await assertNoSymlink(directory, "Attachment directory must not be a symlink.");
  await fs.mkdir(directory, { recursive: true });
  const [rootRealPath, directoryRealPath] = await Promise.all([fs.realpath(root), fs.realpath(directory)]);
  if (!isPathInside(rootRealPath, directoryRealPath)) throw new Error("Attachment directory must stay inside the active workspace.");
}

async function cleanManagedUploadRoot(uploadRoot: string, referenced: Set<string>): Promise<number> {
  let rootStat;
  try {
    rootStat = await fs.lstat(uploadRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return 0;
  let deleted = 0;
  for (const chatDirectory of await fs.readdir(uploadRoot, { withFileTypes: true })) {
    if (!chatDirectory.isDirectory() || chatDirectory.isSymbolicLink()) continue;
    const directory = path.join(uploadRoot, chatDirectory.name);
    for (const file of await fs.readdir(directory, { withFileTypes: true })) {
      if (!file.isFile() || file.isSymbolicLink()) continue;
      const filePath = path.join(directory, file.name);
      if (referenced.has(path.resolve(filePath))) continue;
      forgetValidatedAttachmentFiles([filePath]);
      await fs.rm(filePath, { force: true });
      deleted += 1;
    }
    await fs.rmdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
  }
  await fs.rmdir(uploadRoot).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
  return deleted;
}

async function validateExistingAttachment(directory: string, attachment: MessageAttachment): Promise<MessageAttachment> {
  const target = path.resolve(attachment.filePath!);
  const directoryRealPath = await fs.realpath(directory);
  const targetRealPath = await fs.realpath(target);
  if (!isPathInside(directoryRealPath, targetRealPath)) throw new Error(`Attachment ${attachment.name} is outside the active chat upload directory.`);
  await validateManagedAttachmentFile(targetRealPath, attachment);
  return { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, filePath: targetRealPath };
}

function attachmentFileName(attachment: MessageAttachment, contentDigest: string): string {
  const name = boundedStorageName(attachment.name, 112);
  const idDigest = createHash("sha256").update(`${attachment.id}\0${contentDigest}`).digest("hex").slice(0, 24);
  return `${idDigest}-${contentDigest}-${name}`;
}

function boundedStorageName(fileName: string, maxLength: number): string {
  const safeName = safePathSegment(path.basename(fileName));
  if (safeName.length <= maxLength) return safeName;
  const extension = path.extname(safeName).slice(0, 32);
  return `${safeName.slice(0, Math.max(1, maxLength - extension.length))}${extension}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeFileAtomically(targetPath: string, content: Buffer): Promise<void> {
  const temporaryPath = `${targetPath}.${randomUUID()}.part`;
  try {
    await fs.writeFile(temporaryPath, content, { flag: "wx" });
    await replaceFile(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function copyFileAtomically(sourcePath: string, targetPath: string): Promise<void> {
  const temporaryPath = `${targetPath}.${randomUUID()}.part`;
  try {
    await fs.copyFile(sourcePath, temporaryPath);
    await replaceFile(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function validateManagedAttachmentFile(filePath: string, attachment: MessageAttachment): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`Attachment ${attachment.name} is not a file.`);
  if (stat.size !== attachment.size) throw new Error(`Attachment ${attachment.name} size does not match its file.`);
  const expectedDigest = attachmentDigestFromPath(filePath);
  if (!expectedDigest) return;
  const cached = validatedFiles.get(filePath);
  if (cached && cached.digest === expectedDigest && sameFileIdentity(cached, stat)) { cacheValidatedIdentity(filePath, cached); return; }
  if (await hashFile(filePath) !== expectedDigest) { validatedFiles.delete(filePath); throw new Error(`Attachment ${attachment.name} content does not match its file reference.`); }
  cacheValidatedIdentity(filePath, fileIdentity(stat, expectedDigest));
}

function attachmentDigestFromPath(filePath: string): string | null {
  return /^[a-f0-9]{24}-([a-f0-9]{64})-/.exec(path.basename(filePath))?.[1] ?? null;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function fileIdentity(stat: Stats, digest: string): ValidatedFileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, digest };
}

function cacheValidatedIdentity(filePath: string, identity: ValidatedFileIdentity): void {
  validatedFiles.delete(filePath);
  validatedFiles.set(filePath, identity);
  while (validatedFiles.size > validatedFileCacheLimit) {
    const oldest = validatedFiles.keys().next().value;
    if (typeof oldest !== "string") break;
    validatedFiles.delete(oldest);
  }
}

function sameFileIdentity(identity: ValidatedFileIdentity, stat: Stats): boolean {
  return identity.dev === stat.dev && identity.ino === stat.ino && identity.size === stat.size && identity.mtimeMs === stat.mtimeMs && identity.ctimeMs === stat.ctimeMs;
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
