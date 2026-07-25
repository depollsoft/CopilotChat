import type { ProviderStatus } from "@copilotchat/shared";

type CachedProviderStatus = {
  credentialKey: string;
  status: ProviderStatus;
  expiresAt: number;
};

type ProviderStatusLoad = () => Promise<ProviderStatus>;

export class ProviderStatusCache {
  private readonly cache = new Map<string, CachedProviderStatus>();
  private readonly credentials = new Map<string, string>();
  private readonly inFlight = new Map<string, { credentialKey: string; promise: Promise<ProviderStatus> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  getStaleWhileRefreshing(
    ownerId: string,
    credentialKey: string,
    load: ProviderStatusLoad,
    loadingStatus: () => ProviderStatus,
    onBackgroundError: (error: unknown) => void,
  ): ProviderStatus {
    this.credentials.set(ownerId, credentialKey);
    const cached = this.cache.get(ownerId);
    if (cached?.credentialKey === credentialKey && cached.expiresAt > this.now()) return cached.status;
    void this.refresh(ownerId, credentialKey, load).catch(onBackgroundError);
    return cached?.credentialKey === credentialKey ? cached.status : loadingStatus();
  }

  getFresh(ownerId: string, credentialKey: string, load: ProviderStatusLoad, force = false): Promise<ProviderStatus> {
    this.credentials.set(ownerId, credentialKey);
    const cached = this.cache.get(ownerId);
    if (!force && cached?.credentialKey === credentialKey && cached.expiresAt > this.now() && cached.status.modelsAuthoritative) return Promise.resolve(cached.status);
    return this.refresh(ownerId, credentialKey, load);
  }

  invalidate(ownerId: string): void {
    this.credentials.delete(ownerId);
    this.cache.delete(ownerId);
  }

  private refresh(ownerId: string, credentialKey: string, load: ProviderStatusLoad): Promise<ProviderStatus> {
    const existing = this.inFlight.get(ownerId);
    if (existing?.credentialKey === credentialKey) return existing.promise;
    const promise = load().then((status) => {
      if (this.credentials.get(ownerId) === credentialKey) {
        this.cache.set(ownerId, { credentialKey, status, expiresAt: this.now() + this.ttlMs });
      }
      return status;
    }).finally(() => {
      if (this.inFlight.get(ownerId)?.promise === promise) this.inFlight.delete(ownerId);
    });
    this.inFlight.set(ownerId, { credentialKey, promise });
    return promise;
  }
}
