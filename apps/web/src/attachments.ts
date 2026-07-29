/** Sources a chat message can point at: content the browser can load directly, or a file the server must stream. */
export type MarkdownSource = { kind: "direct"; url: string } | { kind: "chat-file"; url: string; path: string; fileName: string };

const directProtocols = new Set(["data:", "blob:", "http:", "https:"]);
/** In-app routes and served assets are links, not workspace files. */
const appPathPrefixes = ["/api/", "/assets/", "/icons/", "/chats/", "/projects/"];

export function isImageMimeType(mimeType: string | null | undefined): boolean {
  return Boolean(mimeType && mimeType.toLowerCase().startsWith("image/"));
}

/**
 * Raster formats that are safe to hand to `URL.createObjectURL`. A blob URL is same-origin and
 * carries none of the response's `Content-Disposition`, CSP, or `nosniff` protection, so opening
 * one as a document runs any script it contains. SVG is therefore never previewed, only downloaded.
 */
const previewableImageTypes = new Set(["image/apng", "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg", "image/png", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"]);
export function isPreviewableImageType(mimeType: string | null | undefined): boolean {
  return previewableImageTypes.has((mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "");
}

/**
 * Sources the markdown renderer must not blank out. Inline images and `file:` paths are
 * already gated by the sanitizer, and both are resolved before anything is rendered.
 */
export function isPreservedMarkdownUrl(url: string): boolean {
  return /^data:image\//i.test(url) || /^file:/i.test(url);
}

/** Endpoint that streams a stored message attachment. */
export function messageAttachmentUrl(chatId: string, messageId: string, attachmentId: string, options: { download?: boolean } = {}): string {
  return `/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}${options.download ? "?download=1" : ""}`;
}

/** Endpoint that streams a file from the chat working directory. */
export function chatFileUrl(chatId: string, filePath: string, options: { download?: boolean } = {}): string {
  return `/api/chats/${encodeURIComponent(chatId)}/files?path=${encodeURIComponent(filePath)}${options.download ? "&download=1" : ""}`;
}

export function fileNameFromPath(filePath: string): string {
  const withoutQuery = filePath.split(/[?#]/)[0] ?? filePath;
  const segments = withoutQuery.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? filePath;
}

/**
 * Maps a markdown `src`/`href` onto something the app can render. Remote and inline
 * sources load as-is; everything that looks like a workspace path is routed through the
 * chat file endpoint so images and files the agent references actually resolve.
 */
export function resolveMarkdownSource(rawValue: string | null | undefined, chatId: string | null, options: { download?: boolean } = {}): MarkdownSource | null {
  const value = rawValue?.trim();
  if (!value) return null;
  if (value.startsWith("//") || value.startsWith("#")) return { kind: "direct", url: value };
  // Single-letter prefixes stay paths so Windows-style drive letters are not read as protocols.
  const protocol = /^([a-z][a-z0-9+.-]+:)/i.exec(value)?.[1]?.toLowerCase();
  if (protocol && directProtocols.has(protocol)) return { kind: "direct", url: value };
  if (protocol && protocol !== "file:") return { kind: "direct", url: value };
  if (value === "/" || appPathPrefixes.some((prefix) => value.startsWith(prefix))) return { kind: "direct", url: value };
  if (!chatId) return null;
  const filePath = protocol === "file:" ? fileUrlToPath(value) : decodeMarkdownPath(value);
  if (!filePath) return null;
  return { kind: "chat-file", url: chatFileUrl(chatId, filePath, options), path: filePath, fileName: fileNameFromPath(filePath) };
}

/**
 * Markdown destinations are URLs, so a path with a space arrives percent-encoded. Without
 * decoding, `artifacts/my%20chart.png` would be looked up as a file literally named `my%20chart.png`.
 */
function decodeMarkdownPath(value: string): string | null {
  const withoutFragment = value.split("#")[0] ?? value;
  if (!withoutFragment) return null;
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    // A stray `%` is a legal filename character, so a malformed escape falls back to the raw path.
    return withoutFragment;
  }
}

function fileUrlToPath(value: string): string | null {
  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname) || null;
  } catch {
    return null;
  }
}
