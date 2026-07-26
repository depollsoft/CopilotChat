import { describe, expect, it } from "vitest";
import { ChatStreamRegistry, pruneLocalRunningChats } from "./chat-streams";

describe("ChatStreamRegistry", () => {
  it("keeps one stream per chat and aborts the replaced one", () => {
    const registry = new ChatStreamRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.begin("chat-1", first);
    registry.begin("chat-1", second);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(registry.has("chat-1")).toBe(true);
  });

  it("keeps streams of different chats independent", () => {
    const registry = new ChatStreamRegistry();
    const one = new AbortController();
    const two = new AbortController();
    registry.begin("chat-1", one);
    registry.begin("chat-2", two);
    registry.abort("chat-1");
    expect(one.signal.aborted).toBe(true);
    expect(two.signal.aborted).toBe(false);
    expect(registry.has("chat-1")).toBe(false);
    expect(registry.has("chat-2")).toBe(true);
  });

  it("does not unregister a stream that was already replaced", () => {
    const registry = new ChatStreamRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.begin("chat-1", first);
    registry.begin("chat-1", second);
    expect(registry.end("chat-1", first)).toBe(false);
    expect(registry.has("chat-1")).toBe(true);
    expect(registry.end("chat-1", second)).toBe(true);
    expect(registry.has("chat-1")).toBe(false);
  });

  it("aborting an unknown chat is a no-op", () => {
    const registry = new ChatStreamRegistry();
    expect(() => registry.abort("missing")).not.toThrow();
    expect(registry.has("missing")).toBe(false);
  });

  it("aborts every tracked stream at once", () => {
    const registry = new ChatStreamRegistry();
    const one = new AbortController();
    const two = new AbortController();
    registry.begin("chat-1", one);
    registry.begin("chat-2", two);
    registry.abortAll();
    expect(one.signal.aborted).toBe(true);
    expect(two.signal.aborted).toBe(true);
    expect(registry.has("chat-1")).toBe(false);
    expect(registry.has("chat-2")).toBe(false);
  });
});

describe("pruneLocalRunningChats", () => {
  it("keeps a chat the latest server snapshot was too early to see", () => {
    const tracked = { "chat-1": 200 };
    expect(pruneLocalRunningChats(tracked, [], 100, null)).toBe(tracked);
  });

  it("drops a chat a later snapshot no longer reports as active", () => {
    expect(pruneLocalRunningChats({ "chat-1": 100 }, [], 200, null)).toEqual({});
  });

  it("keeps chats the server still reports as active", () => {
    const tracked = { "chat-1": 100 };
    expect(pruneLocalRunningChats(tracked, ["chat-1"], 200, null)).toBe(tracked);
  });

  it("keeps the chat that is still streaming on screen", () => {
    const tracked = { "chat-1": 100 };
    expect(pruneLocalRunningChats(tracked, [], 200, "chat-1")).toBe(tracked);
  });

  it("prunes only the stale chats and keeps the identity when nothing changes", () => {
    expect(pruneLocalRunningChats({ "chat-1": 100, "chat-2": 300 }, [], 200, null)).toEqual({ "chat-2": 300 });
  });
});

describe("ChatStreamRegistry.isLive", () => {
  it("reports only the current stream as live", () => {
    const registry = new ChatStreamRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.begin("chat-1", first);
    expect(registry.isLive("chat-1", first)).toBe(true);
    registry.begin("chat-1", second);
    expect(registry.isLive("chat-1", first)).toBe(false);
    expect(registry.isLive("chat-1", second)).toBe(true);
    registry.abort("chat-1");
    expect(registry.isLive("chat-1", second)).toBe(false);
  });
});
