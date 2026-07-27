import { describe, expect, it } from "vitest";

import { chatFileUrl, fileNameFromPath, isImageMimeType, isPreservedMarkdownUrl, messageAttachmentUrl, resolveMarkdownSource } from "./attachments.js";

const chatId = "chat 1";

describe("messageAttachmentUrl", () => {
  it("escapes every identifier it puts in the path", () => {
    expect(messageAttachmentUrl("chat/1", "msg 2", "att#3")).toBe("/api/chats/chat%2F1/messages/msg%202/attachments/att%233");
  });

  it("adds the download flag when requested", () => {
    expect(messageAttachmentUrl("c", "m", "a", { download: true })).toBe("/api/chats/c/messages/m/attachments/a?download=1");
  });
});

describe("chatFileUrl", () => {
  it("passes the path as an escaped query parameter", () => {
    expect(chatFileUrl(chatId, ".copilotchat/uploads/photo.png")).toBe("/api/chats/chat%201/files?path=.copilotchat%2Fuploads%2Fphoto.png");
    expect(chatFileUrl("c", "a b.png", { download: true })).toBe("/api/chats/c/files?path=a%20b.png&download=1");
  });
});

describe("resolveMarkdownSource", () => {
  it("loads remote and inline sources directly", () => {
    expect(resolveMarkdownSource("https://example.com/a.png", chatId)).toEqual({ kind: "direct", url: "https://example.com/a.png" });
    expect(resolveMarkdownSource("data:image/png;base64,AAAA", chatId)).toEqual({ kind: "direct", url: "data:image/png;base64,AAAA" });
    expect(resolveMarkdownSource("//cdn.example.com/a.png", chatId)).toEqual({ kind: "direct", url: "//cdn.example.com/a.png" });
    expect(resolveMarkdownSource("#section", chatId)).toEqual({ kind: "direct", url: "#section" });
    expect(resolveMarkdownSource("mailto:hi@example.com", chatId)).toEqual({ kind: "direct", url: "mailto:hi@example.com" });
    expect(resolveMarkdownSource("/api/chats/c/files?path=a.png", chatId)).toEqual({ kind: "direct", url: "/api/chats/c/files?path=a.png" });
    expect(resolveMarkdownSource("/chats/other-chat", chatId)).toEqual({ kind: "direct", url: "/chats/other-chat" });
  });

  it("routes workspace paths through the chat file endpoint", () => {
    expect(resolveMarkdownSource("artifacts/chart.png", chatId)).toEqual({
      kind: "chat-file",
      url: "/api/chats/chat%201/files?path=artifacts%2Fchart.png",
      path: "artifacts/chart.png",
      fileName: "chart.png",
    });
    expect(resolveMarkdownSource("./notes.md", chatId)?.kind).toBe("chat-file");
    expect(resolveMarkdownSource("/tmp/isolated/chat/photo.jpg", chatId)?.kind).toBe("chat-file");
    const windowsPath = resolveMarkdownSource("C:\\workspace\\photo.jpg", chatId);
    expect(windowsPath?.kind === "chat-file" ? windowsPath.fileName : null).toBe("photo.jpg");
  });

  it("unwraps file URLs the agent may emit", () => {
    expect(resolveMarkdownSource("file:///tmp/work/my%20photo.png", chatId)).toEqual({
      kind: "chat-file",
      url: "/api/chats/chat%201/files?path=%2Ftmp%2Fwork%2Fmy%20photo.png",
      path: "/tmp/work/my photo.png",
      fileName: "my photo.png",
    });
  });

  it("returns nothing without a source or a chat to resolve against", () => {
    expect(resolveMarkdownSource("", chatId)).toBeNull();
    expect(resolveMarkdownSource(undefined, chatId)).toBeNull();
    expect(resolveMarkdownSource("artifacts/chart.png", null)).toBeNull();
  });
});

describe("fileNameFromPath", () => {
  it("keeps the last path segment", () => {
    expect(fileNameFromPath(".copilotchat/uploads/chat/abc-photo.png")).toBe("abc-photo.png");
    expect(fileNameFromPath("photo.png")).toBe("photo.png");
    expect(fileNameFromPath("/")).toBe("/");
  });
});

describe("isImageMimeType", () => {
  it("detects image types", () => {
    expect(isImageMimeType("image/png")).toBe(true);
    expect(isImageMimeType("IMAGE/JPEG")).toBe(true);
    expect(isImageMimeType("application/pdf")).toBe(false);
    expect(isImageMimeType(undefined)).toBe(false);
  });
});

describe("isPreservedMarkdownUrl", () => {
  it("keeps only the sources the markdown pipeline resolves itself", () => {
    expect(isPreservedMarkdownUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isPreservedMarkdownUrl("file:///tmp/work/photo.png")).toBe(true);
    expect(isPreservedMarkdownUrl("data:text/html;base64,AAAA")).toBe(false);
    expect(isPreservedMarkdownUrl("javascript:alert(1)")).toBe(false);
    expect(isPreservedMarkdownUrl("https://example.com/a.png")).toBe(false);
  });
});
