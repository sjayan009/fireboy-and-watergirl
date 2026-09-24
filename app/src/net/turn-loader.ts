/** Credentials only live in this module's memory, never persistent storage. */
export interface TurnCredentials {
  iceServers: RTCIceServer[];
  /** Unix milliseconds, computed conservatively by the authenticated broker. */
  expiresAt: number;
}

const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_TTL_MS = 4 * 60 * 60_000;
const RETRY_MS = 30_000;

export function parseTurnCredentials(value: unknown, now: number): TurnCredentials | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (typeof response.expiresAt !== "number" || !Number.isFinite(response.expiresAt) ||
      response.expiresAt <= now + REFRESH_MARGIN_MS || response.expiresAt > now + MAX_TTL_MS + 60_000 ||
      !Array.isArray(response.iceServers) || !response.iceServers.length || response.iceServers.length > 8) return null;
  const servers: RTCIceServer[] = [];
  let hasTurn = false;
  for (const entry of response.iceServers) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["urls", "username", "credential", "credentialType"].includes(key))) return null;
    const urls = typeof row.urls === "string" ? [row.urls] : row.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 8 || urls.some((url) =>
      typeof url !== "string" || url.length > 512 ||
      !/^(?:stuns?|turns?):(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/i.test(url))) return null;
    const relay = urls.some((url: string) => /^turns?:/i.test(url));
    if (row.credentialType !== undefined && row.credentialType !== "password") return null;
    if (relay && (typeof row.username !== "string" || !row.username.length || row.username.length > 1024 ||
        typeof row.credential !== "string" || !row.credential.length || row.credential.length > 1024)) return null;
    if (!relay && (row.username !== undefined || row.credential !== undefined)) return null;
    hasTurn ||= relay;
    servers.push({ urls: [...urls], ...(relay ? {
      username: row.username as string, credential: row.credential as string,
    } : {}) });
  }
  return hasTurn ? { iceServers: servers, expiresAt: response.expiresAt } : null;
}

export function createRuntimeIceLoader(
  invoke: () => Promise<{ data: unknown; error: unknown }>, now = Date.now,
): { load(fallback: RTCIceServer[], options?: { forceRefresh?: boolean }): Promise<RTCIceServer[]>; clear(): void } {
  let cached: TurnCredentials | null = null;
  let pending: Promise<TurnCredentials | null> | null = null;
  let retryAt = 0;
  let generation = 0;
  const copy = (servers: RTCIceServer[]) => servers.map((s) => ({ ...s, urls: Array.isArray(s.urls) ? [...s.urls] : s.urls }));
  return {
    clear() { cached = null; pending = null; retryAt = 0; generation++; },
    async load(fallback, options = {}) {
      if (!options.forceRefresh && cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) return copy(cached.iceServers);
      if (!options.forceRefresh && now() < retryAt) return copy(fallback);
      if (!pending) {
        const requestedGeneration = generation;
        pending = (async () => {
          try {
            const { data, error } = await invoke();
            const credentials = error ? null : parseTurnCredentials(data, now());
            if (requestedGeneration !== generation) return null;
            cached = credentials;
            retryAt = credentials ? 0 : now() + RETRY_MS;
            return credentials;
          } catch {
            if (requestedGeneration === generation) { cached = null; retryAt = now() + RETRY_MS; }
            return null;
          } finally { if (requestedGeneration === generation) pending = null; }
        })();
      }
      const result = await pending;
      return copy(result?.iceServers ?? fallback);
    },
  };
}
