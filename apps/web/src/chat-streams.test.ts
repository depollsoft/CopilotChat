import { describe, expect, it } from "vitest";
import { ChatStreamRegistry } from "./chat-streams";

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
    registry.end("chat-1", first);
    expect(registry.has("chat-1")).toBe(true);
    registry.end("chat-1", second);
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
