import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { MessageAttachment } from "@copilotchat/shared";
import { isPathInside } from "./path-guards.js";

/**
 * A workspace file that passed the containment checks, together with the descriptor those
 * checks were made against. Callers must stream `handle` and close it; reopening
 * `absolutePath` would reintroduce the symlink-swap race the descriptor exists to close.
 */
export type ResolvedChatFile = { handle: FileHandle; absolutePath: string; relativePath: string; fileName: string; size: number; mimeType: string; etag: string };
export class ChatFileNotFoundError extends Error {}
export class ChatFileAccessError extends Error {}

const extensionMimeTypes: Record<string, string> = {
  ".apng": "image/apng", ".avif": "image/avif", ".bmp": "image/bmp", ".gif": "image/gif", ".heic": "image/heic", ".ico": "image/x-icon",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".tif": "image/tiff", ".tiff": "image/tiff", ".webp": "image/webp",
  ".aac": "audio/aac", ".flac": "audio/flac", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".oga": "audio/ogg", ".ogg": "audio/ogg", ".opus": "audio/opus", ".wav": "audio/wav",
  ".m4v": "video/mp4", ".mov": "video/quicktime", ".mp4": "video/mp4", ".ogv": "video/ogg", ".webm": "video/webm",
  ".csv": "text/csv", ".json": "application/json", ".log": "text/plain", ".md": "text/markdown", ".pdf": "application/pdf", ".txt": "text/plain",
  ".htm": "text/html", ".html": "text/html", ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml",
  ".gz": "application/gzip", ".tar": "application/x-tar", ".zip": "application/zip",
};
/** The subset of an attachment the system prompt needs to point the agent at a file. */
export type ChatContextAttachment = Pick<MessageAttachment, "name" | "filePath">;
/** Keeps an attachment-heavy chat from growing the system prompt without bound. */
const chatFileContextLimit = 40;
/** Types a browser renders with scripting privileges, so they are only ever sent as downloads. */
const activeContentTypes = new Set(["text/html", "application/xhtml+xml", "image/svg+xml", "application/xml", "text/xml", "application/javascript", "text/javascript", "application/pdf"]);
const inlineContentTypePrefixes = ["image/", "audio/", "video/", "text/"];

/**
 * Attachment MIME types arrive from the client and are stored verbatim, so they can carry CR/LF
 * or other characters Node rejects when setting a header. That throw happens while the response
 * is already being sent, past Fastify's error handling, and takes the process down; anything
 * that is not a plain `type/subtype` token is therefore replaced rather than echoed.
 */
export function safeContentType(mimeType: string | null | undefined, fallback = "application/octet-stream"): string {
  const value = (mimeType ?? "").split(";")[0]?.trim() ?? "";
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value) && value.length <= 255 ? value.toLowerCase() : fallback;
}

export function contentTypeForFile(fileName: string, fallback = "application/octet-stream"): string {
  return extensionMimeTypes[path.extname(fileName).toLowerCase()] ?? fallback;
}

/** True when the browser may render the type in place instead of downloading it. */
export function isInlineContentType(mimeType: string): boolean {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (activeContentTypes.has(normalized)) return false;
  return inlineContentTypePrefixes.some((prefix) => normalized.startsWith(prefix));
}

/** RFC 6266 header that keeps unusual file names from breaking the response. */
export function contentDispositionHeader(fileName: string, disposition: "inline" | "attachment"): string {
  const asciiName = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Resolves a path the agent or the UI referenced against the chat working directory.
 * Absolute paths, `file://` URLs, and workspace-relative paths are all accepted, but the
 * resolved file must stay inside the workspace so a chat cannot read unrelated files.
 */
export async function resolveChatFile(input: { workspaceDir: string; requestedPath: string }): Promise<ResolvedChatFile> {
  const requested = normalizeRequestedPath(input.requestedPath);
  if (!requested) throw new ChatFileAccessError("A file path is required.");
  let workspaceRealPath: string;
  try {
    workspaceRealPath = await fs.realpath(input.workspaceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ChatFileNotFoundError("File not found.");
    throw error;
  }
  const absolutePath = path.resolve(workspaceRealPath, requested);
  if (!isPathInside(workspaceRealPath, absolutePath)) throw new ChatFileAccessError("File path must stay inside the chat workspace.");
  let realPath: string;
  let handle: FileHandle;
  try {
    realPath = await fs.realpath(absolutePath);
    // Opening without following a final symlink means the descriptor is the entry that realpath
    // resolved, so a later swap of the name cannot redirect the bytes that get streamed.
    handle = await fs.open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new ChatFileNotFoundError("File not found.");
    if (code === "ELOOP" || code === "EMLINK") throw new ChatFileAccessError("File path must stay inside the chat workspace.");
    if (code === "EACCES" || code === "EPERM") throw new ChatFileAccessError("File is not readable.");
    throw error;
  }
  try {
    // Symlinks are fine as long as their target is still inside the workspace.
    if (!isPathInside(workspaceRealPath, realPath)) throw new ChatFileAccessError("File path must stay inside the chat workspace.");
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new ChatFileNotFoundError("File not found.");
    // The name still has to resolve to the opened inode, otherwise it was swapped mid-check.
    const current = await fs.stat(absolutePath, { bigint: true }).catch(() => null);
    if (!current || current.dev !== stat.dev || current.ino !== stat.ino) throw new ChatFileAccessError("File changed while it was being read.");
    const fileName = path.basename(realPath);
    return { handle, absolutePath: realPath, relativePath: path.relative(workspaceRealPath, realPath), fileName, size: Number(stat.size), mimeType: contentTypeForFile(fileName), etag: fileEtag(stat) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Validator built from the identity and nanosecond mtime of the opened file. Millisecond
 * precision let a same-size rewrite inside one tick keep its tag and answer 304 with stale
 * bytes, so the inode and the full-resolution timestamp are both included.
 */
export function fileEtag(stat: { size: bigint; mtimeNs: bigint; ino: bigint; dev: bigint }): string {
  return `"${stat.size.toString(16)}-${stat.mtimeNs.toString(16)}-${stat.dev.toString(16)}.${stat.ino.toString(16)}"`;
}

/** Validator for attachment bytes held in the database, which have no file identity to read. */
export function bufferEtag(content: Buffer): string {
  return `"${content.byteLength.toString(16)}-${createHash("sha256").update(content).digest("hex").slice(0, 32)}"`;
}

function normalizeRequestedPath(requestedPath: string): string {
  const trimmed = requestedPath.trim();
  if (!trimmed || trimmed.includes("\0")) return "";
  if (/^file:\/\//i.test(trimmed)) {
    try { return decodeURIComponent(new URL(trimmed).pathname); } catch { return ""; }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return "";
  return trimmed;
}

/** Workspace-relative path for an attachment, or null when it lives outside the workspace. */
export function workspaceRelativePath(workspaceDir: string, filePath: string): string | null {
  const relative = path.relative(path.resolve(workspaceDir), path.resolve(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/**
 * Tells the agent where this chat's uploads live and how to show a file back to the user,
 * so "show me that image" renders inline instead of emitting an unreachable path.
 */
export function chatFileSystemContext(input: { workspaceDir: string; attachments: ChatContextAttachment[]; limit?: number }): string | null {
  const limit = input.limit ?? chatFileContextLimit;
  const listed = new Map<string, string>();
  for (const attachment of input.attachments) {
    if (!attachment.filePath) continue;
    const relative = workspaceRelativePath(input.workspaceDir, attachment.filePath);
    // Re-inserting moves a repeated upload to the end, so the newest mention survives the cap.
    if (relative) { listed.delete(relative); listed.set(relative, attachment.name); }
  }
  const all = [...listed];
  const kept = all.slice(-limit);
  const omitted = all.length - kept.length;
  const lines = kept.map(([relative, name]) => `- ${relative} (${name})`);
  if (omitted > 0) lines.unshift(`- (${omitted} older upload${omitted === 1 ? "" : "s"} omitted; ask the user if you need one.)`);
  return [
    "Showing files to the user:",
    "Reference any file inside the active workspace with a Markdown image or link that uses its workspace-relative path, and the app renders it inline in the chat.",
    "Use `![description](path/to/image.png)` for images and `[label](path/to/file.pdf)` for other files. Never inline base64 data and never invent paths for files you have not confirmed exist.",
    lines.length > 0 ? ["Files the user uploaded in this chat:", ...lines].join("\n") : "",
  ].filter(Boolean).join("\n\n");
}
