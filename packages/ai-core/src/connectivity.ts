/**
 * SPEC 06 §6.1 — "may the app reach the internet right now?"
 *
 * Deliberately dumb and cheap: a HEAD request to a small, stable endpoint with a
 * short timeout, cached for 15 seconds so a screen full of badges never hammers
 * the network. It never sends anything about the user, and it is skipped
 * entirely while the user is in Offline mode — in Offline the answer is simply
 * "no" (the app must not even check).
 */

export const CONNECTIVITY_TIMEOUT_MS = 3_000;
export const CONNECTIVITY_CACHE_MS = 15_000;
const PROBE_URLS = ['https://www.gstatic.com/generate_204', 'https://api.openai.com/v1/models'];

export interface ConnectivityState {
  online: boolean;
  checkedAt: number;
  /** Present when offline: the short reason to show in the UI. */
  reason?: 'offline_mode' | 'no_network' | 'timeout';
}

export interface ConnectivityOptions {
  /** Injectable for tests — defaults to global fetch. */
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheMs?: number;
  probeUrls?: string[];
}

export class ConnectivityService {
  private state: ConnectivityState | null = null;
  private inflight: Promise<ConnectivityState> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly probeUrls: string[];
  private offlineMode = false;

  constructor(options: ConnectivityOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? CONNECTIVITY_TIMEOUT_MS;
    this.cacheMs = options.cacheMs ?? CONNECTIVITY_CACHE_MS;
    this.probeUrls = options.probeUrls ?? PROBE_URLS;
  }

  /**
   * Offline mode is a hard "no": the router must never send data, so we do not
   * even test the connection (SPEC 06 §6.1).
   */
  setOfflineMode(offline: boolean): void {
    if (this.offlineMode === offline) return;
    this.offlineMode = offline;
    this.state = offline ? { online: false, checkedAt: this.now(), reason: 'offline_mode' } : null;
  }

  /** Last known answer without triggering a probe (for synchronous UI). */
  peek(): ConnectivityState | null {
    return this.state;
  }

  /** Cached result when fresh, otherwise a fresh probe. */
  async check(force = false): Promise<ConnectivityState> {
    if (this.offlineMode) {
      return { online: false, checkedAt: this.now(), reason: 'offline_mode' };
    }
    if (!force && this.state && this.now() - this.state.checkedAt < this.cacheMs) {
      return this.state;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.probe()
      .then((state) => {
        this.state = state;
        return state;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async isOnline(force = false): Promise<boolean> {
    return (await this.check(force)).online;
  }

  /** Drops the cache, e.g. after the user switches mode or resumes the app. */
  invalidate(): void {
    this.state = null;
  }

  private async probe(): Promise<ConnectivityState> {
    let timedOut = false;
    for (const url of this.probeUrls) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
      try {
        const response = await this.fetchFn(url, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'follow',
          cache: 'no-store',
        });
        // Any HTTP answer proves the network works; 204/200 are the normal ones.
        if (response.status > 0) {
          return { online: true, checkedAt: this.now() };
        }
      } catch {
        // Try the next probe URL; a blocked one does not mean "offline".
      } finally {
        clearTimeout(timer);
      }
    }
    return {
      online: false,
      checkedAt: this.now(),
      reason: timedOut ? 'timeout' : 'no_network',
    };
  }
}
