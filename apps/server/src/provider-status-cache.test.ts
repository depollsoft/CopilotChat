import type { ProviderStatus } from "@copilotchat/shared";
import { describe, expect, it, vi } from "vitest";
import { ProviderStatusCache } from "./provider-status-cache.js";

function status(model: string, available = true): ProviderStatus {
  return {
    id: "sdk",
    label: "GitHub Copilot SDK",
    available,
    details: "ready",
    capabilities: [],
    models: [{ id: model, name: model, supportsReasoningEffort: false, supportedReasoningEfforts: [], supportsLongContext: false }],
    defaultModel: model,
  };
}

describe("ProviderStatusCache", () => {
  it("returns stale status while refreshing an expired model list", async () => {
    let now = 0;
    const cache = new ProviderStatusCache(100, () => now);
    const load = vi.fn()
      .mockResolvedValueOnce(status("old"))
      .mockResolvedValueOnce(status("new"));

    expect(cache.getStaleWhileRefreshing("owner", "token", load, () => status("loading"), vi.fn()).defaultModel).toBe("loading");
    await cache.getFresh("owner", "token", load);
    now = 101;

    expect(cache.getStaleWhileRefreshing("owner", "token", load, () => status("loading"), vi.fn()).defaultModel).toBe("old");
    await cache.getFresh("owner", "token", load);
    expect((await cache.getFresh("owner", "token", load)).defaultModel).toBe("new");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("forces a refresh and deduplicates concurrent discovery", async () => {
    const cache = new ProviderStatusCache(100);
    let resolveRefresh!: (value: ProviderStatus) => void;
    const load = vi.fn(() => new Promise<ProviderStatus>((resolve) => { resolveRefresh = resolve; }));

    const first = cache.getFresh("owner", "token", load, true);
    const second = cache.getFresh("owner", "token", load, true);
    resolveRefresh(status("new"));

    await expect(first).resolves.toEqual(status("new"));
    await expect(second).resolves.toEqual(status("new"));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries cached discovery failures without waiting for the normal TTL", async () => {
    const cache = new ProviderStatusCache(100);
    const load = vi.fn()
      .mockResolvedValueOnce(status("fallback", false))
      .mockResolvedValueOnce(status("recovered"));

    await expect(cache.getFresh("owner", "token", load)).resolves.toEqual(status("fallback", false));
    await expect(cache.getFresh("owner", "token", load)).resolves.toEqual(status("recovered"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not let an old credential overwrite a newer model list", async () => {
    const cache = new ProviderStatusCache(100);
    let resolveOld!: (value: ProviderStatus) => void;
    const oldRefresh = cache.getFresh("owner", "old-token", () => new Promise<ProviderStatus>((resolve) => { resolveOld = resolve; }), true);
    const newRefresh = cache.getFresh("owner", "new-token", () => Promise.resolve(status("new")), true);

    await expect(newRefresh).resolves.toEqual(status("new"));
    resolveOld(status("old"));
    await expect(oldRefresh).resolves.toEqual(status("old"));
    await expect(cache.getFresh("owner", "new-token", vi.fn())).resolves.toEqual(status("new"));
  });
});
