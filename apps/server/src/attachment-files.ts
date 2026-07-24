import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { MessageAttachment } from "@copilotchat/shared";
import { assertNoSymlink, isPathInside, safePathSegment } from "./path-guards.js";
import type { AppDatabase } from "./db.js";
import type { UploadedFileStore } from "./uploaded-files.js";

const attachmentDirectoryName = ".copilotchat/uploads";
const attachmentCountLimit = 20;

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
        materialized.push({ id: attachment.id, name: uploaded.fileName, mimeType: uploaded.mimeType, size: uploaded.size, filePath: targetPath });
        if (!existed) { createdFilePaths.push(targetPath); createdThisAttempt.push(targetPath); }
        continue;
      }
      if (!attachment.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data)) throw new Error(`Attachment ${attachment.name} is not valid base64.`);
      const content = Buffer.from(attachment.data, "base64");
      if (content.byteLength !== attachment.size) throw new Error(`Attachment ${attachment.name} size does not match its content.`);
      const targetPath = path.join(directory, attachmentFileName(attachment, createHash("sha256").update(content).digest("hex")));
      await assertNoSymlink(targetPath, "Attachment path must not be a symlink.");
      const existed = await pathExists(targetPath);
      await writeFileAtomically(targetPath, content);
      materialized.push({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, filePath: targetPath });
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
    await fs.rmdir(path.dirname(sourcePath)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
  }
}

export function isChatAttachmentDirectory(directory: string, chatId: string): boolean {
  const resolved = path.resolve(directory);
  return path.basename(resolved) === safePathSegment(chatId)
    && path.basename(path.dirname(resolved)) === "uploads"
    && path.basename(path.dirname(path.dirname(resolved))) === ".copilotchat";
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

async function validateExistingAttachment(directory: string, attachment: MessageAttachment): Promise<MessageAttachment> {
  const target = path.resolve(attachment.filePath!);
  const directoryRealPath = await fs.realpath(directory);
  const targetRealPath = await fs.realpath(target);
  if (!isPathInside(directoryRealPath, targetRealPath)) throw new Error(`Attachment ${attachment.name} is outside the active chat upload directory.`);
  await validateManagedAttachmentFile(targetRealPath, attachment);
  return { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, filePath: targetRealPath };
}

function attachmentFileName(attachment: MessageAttachment, contentDigest: string): string {
  const name = safePathSegment(path.basename(attachment.name));
  const idDigest = createHash("sha256").update(`${attachment.id}\0${contentDigest}`).digest("hex").slice(0, 24);
  return `${idDigest}-${contentDigest}-${name}`;
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
  if (expectedDigest && await hashFile(filePath) !== expectedDigest) throw new Error(`Attachment ${attachment.name} content does not match its file reference.`);
}

function attachmentDigestFromPath(filePath: string): string | null {
  return /^[a-f0-9]{24}-([a-f0-9]{64})-/.exec(path.basename(filePath))?.[1] ?? null;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
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
