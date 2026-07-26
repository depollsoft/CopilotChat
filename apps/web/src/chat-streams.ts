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

  /** Unregisters a finished stream, keeping a newer stream that replaced it. */
  end(chatId: string, controller: AbortController): void {
    if (this.streams.get(chatId) === controller) this.streams.delete(chatId);
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
