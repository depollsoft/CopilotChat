/**
 * Tracks the live response stream of every chat so that at most one connection
 * per chat feeds the UI. Without this, a chat that keeps streaming in the
 * background (or a duplicate reconnect for the same chat) writes into the same
 * streaming state as the chat on screen and both responses interleave.
 */
export class ChatStreamRegistry {
  private readonly streams = new Map<string, AbortController>();

  has(chatId: string): boolean {
    return this.streams.has(chatId);
  }

  /** Registers a stream, aborting any stream this chat already had. */
  begin(chatId: string, controller: AbortController): void {
    const previous = this.streams.get(chatId);
    if (previous && previous !== controller) previous.abort();
    this.streams.set(chatId, controller);
  }

  /** True while this controller is the chat's live stream, so only it may finish the chat's response. */
  isLive(chatId: string, controller: AbortController): boolean {
    return this.streams.get(chatId) === controller;
  }

  /** Unregisters a finished stream, keeping a newer stream that replaced it. Returns true when this stream was still the live one. */
  end(chatId: string, controller: AbortController): boolean {
    if (!this.isLive(chatId, controller)) return false;
    this.streams.delete(chatId);
    return true;
  }

  abort(chatId: string): void {
    const controller = this.streams.get(chatId);
    if (!controller) return;
    this.streams.delete(chatId);
    controller.abort();
  }

  abortAll(): void {
    for (const controller of [...this.streams.values()]) controller.abort();
    this.streams.clear();
  }
}

/** Chats whose response this client started, keyed by the time tracking began. */
export type LocalRunningChats = Record<string, number>;

/**
 * Drops locally tracked chats the server no longer reports as active. A chat is
 * kept until a server snapshot taken after tracking began has had a chance to
 * see it, so a just-started response never loses its running marker to a stale
 * snapshot and stops the polling that would confirm it.
 */
export function pruneLocalRunningChats(tracked: LocalRunningChats, activeChatIds: string[], snapshotStartedAt: number, keepChatId: string | null): LocalRunningChats {
  const active = new Set(activeChatIds);
  const next: LocalRunningChats = {};
  let dropped = false;
  for (const [chatId, trackedAt] of Object.entries(tracked)) {
    if (active.has(chatId) || chatId === keepChatId || trackedAt >= snapshotStartedAt) next[chatId] = trackedAt;
    else dropped = true;
  }
  return dropped ? next : tracked;
}
