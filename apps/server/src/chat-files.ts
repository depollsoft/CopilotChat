import fs from "node:fs/promises";
import path from "node:path";
import type { MessageAttachment } from "@copilotchat/shared";
import { isPathInside } from "./path-guards.js";

/** A workspace file that passed the containment checks and can be streamed back to its owner. */
export type ResolvedChatFile = { absolutePath: string; relativePath: string; fileName: string; size: number; mimeType: string; etag: string };
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
/** Types a browser renders with scripting privileges, so they are only ever sent as downloads. */
const activeContentTypes = new Set(["text/html", "application/xhtml+xml", "image/svg+xml", "application/xml", "text/xml", "application/javascript", "text/javascript", "application/pdf"]);
const inlineContentTypePrefixes = ["image/", "audio/", "video/", "text/"];

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
  let stat;
  try {
    realPath = await fs.realpath(absolutePath);
    stat = await fs.stat(realPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new ChatFileNotFoundError("File not found.");
    throw error;
  }
  // Symlinks are fine as long as their target is still inside the workspace.
  if (!isPathInside(workspaceRealPath, realPath)) throw new ChatFileAccessError("File path must stay inside the chat workspace.");
  if (!stat.isFile()) throw new ChatFileNotFoundError("File not found.");
  const fileName = path.basename(realPath);
  return { absolutePath: realPath, relativePath: path.relative(workspaceRealPath, realPath), fileName, size: stat.size, mimeType: contentTypeForFile(fileName), etag: fileEtag(stat.size, stat.mtimeMs) };
}

/** Validator that changes whenever the agent rewrites a file in place, so a stale preview is never reused. */
export function fileEtag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
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
export function chatFileSystemContext(input: { workspaceDir: string; attachments: MessageAttachment[] }): string | null {
  const listed = new Map<string, string>();
  for (const attachment of input.attachments) {
    if (!attachment.filePath) continue;
    const relative = workspaceRelativePath(input.workspaceDir, attachment.filePath);
    if (relative) listed.set(relative, attachment.name);
  }
  const lines = [...listed].map(([relative, name]) => `- ${relative} (${name})`);
  return [
    "Showing files to the user:",
    "Reference any file inside the active workspace with a Markdown image or link that uses its workspace-relative path, and the app renders it inline in the chat.",
    "Use `![description](path/to/image.png)` for images and `[label](path/to/file.pdf)` for other files. Never inline base64 data and never invent paths for files you have not confirmed exist.",
    lines.length > 0 ? ["Files the user uploaded in this chat:", ...lines].join("\n") : "",
  ].filter(Boolean).join("\n\n");
}
