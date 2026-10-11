/** Canonical account progress. The engine uses a separate projection. */
import { auth } from "./auth.js";
import { LocalSave, normaliseSave } from "@engine/game/save.js";
import type { SaveStore } from "@engine/game/save.js";
import { mergeProgress, type ProgressArrays } from "./outbox.js";

const LEGACY_KEY = "FBCookie";
const keyFor = (owner: string) => `${LEGACY_KEY}:${owner}`;
const signature = (p: ProgressArrays) => JSON.stringify([p.stats, p.times]);
const SETTLE_MS = 1200;

/** Copy and verify before deleting the only old copy, including quota failures. */
function adoptLegacy(owner: string, local: LocalSave): void {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.stats) || !Array.isArray(parsed?.times)) return;
    Object.assign(local.data, mergeProgress(local.data, normaliseSave(parsed).data));
    local.flush();
    if (!local.lastError && localStorage.getItem(keyFor(owner)) === JSON.stringify(local.data)) {
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch { /* Unreadable or unclaimed progress remains recoverable at its original key. */ }
}

export interface SoloProgress {
  /** Canonical data: never hand this store directly to a shared Game. */
  readonly store: SaveStore;
  readonly lastError: string | null;
  readonly storageError: string | null;
  readonly pending: boolean;
  readonly localOnly: boolean;
  readonly revision: number;
  readonly acknowledgedRevision: number;
  sync(): Promise<void>;
  touched(): void;
  onChange(fn: () => void): () => void;
  close(): void;
}

/**
 * `deviceKey` makes it a save with no account at all: that key, ownerless, so
 * `valid()` is false and nothing is ever sent (the play screen's guest mode
 * passes the guest key, so a guest keeps the progress they have).
 */
export function soloProgress(deviceKey?: string): SoloProgress {
  const owner = deviceKey ? "" : auth().user?.id ?? "";
  const key = deviceKey ?? keyFor(owner || "anonymous");
  const local = new LocalSave(key);
  if (owner) adoptLegacy(owner, local);
  const data = local.data as ProgressArrays;
  const ackKey = key + ".cloud";
  let acknowledged = "";
  try { acknowledged = localStorage.getItem(ackKey) ?? ""; } catch { /* local reports storage errors */ }
  let current = signature(data), persisted = local.lastError ? "" : current;
  let revision = 0, acknowledgedRevision = acknowledged === current ? 0 : -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flight: Promise<void> | null = null, queued = false, closed = false, failures = 0;
  let lastError: string | null = null;
  const listeners = new Set<() => void>();
  const announce = () => { for (const fn of listeners) fn(); };
  const valid = () => !closed && !!owner && auth().user?.id === owner;

  function persist(): void {
    if (persisted === current && !local.lastError) return;
    local.flush();
    if (!local.lastError) persisted = current;
  }
  function schedule(delay = SETTLE_MS): void {
    if (!valid() || timer !== null || acknowledged === current) return;
    timer = setTimeout(() => { timer = null; void sync(); }, delay);
  }
  function touched(): void {
    if (closed || (owner && auth().user?.id !== owner)) return;
    const next = signature(data);
    if (next !== current) { current = next; revision++; queued = true; }
    persist(); schedule(); announce();
  }
  function sync(): Promise<void> {
    if (!valid()) return Promise.resolve();
    touched();
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (flight) { queued = true; return flight; }
    flight = (async () => {
      do {
        queued = false;
        const sentRevision = revision, sentSignature = current;
        const controller = new AbortController();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          const expired = new Promise<never>((_, reject) => {
            deadline = setTimeout(() => { controller.abort(); reject(new Error("Cloud save timed out. Your local result is preserved.")); }, 12000);
          });
          // Imported here, not at the top: a guest uses this module and never
          // downloads the client (auth.ts). Signed in, it is already loaded.
          const { supabase } = await import("./supabase.js");
          const request = supabase.rpc("sync_solo_progress", { p_stats: data.stats.slice(0, 32), p_times: data.times.slice(0, 32) });
          // Pin the token to the canonical owner across the SDK's asynchronous fetch.
          if (typeof request.setHeader === "function") {
            const session = await Promise.race([supabase.auth.getSession(), expired]);
            if (session.error || session.data.session?.user.id !== owner || !valid()) throw new Error("Sign in to the account that earned this result");
            request.setHeader("Authorization", "Bearer " + session.data.session.access_token);
          }
          const bounded = typeof request.abortSignal === "function" ? request.abortSignal(controller.signal) : request;
          const answer = await Promise.race([bounded, expired]);
          if (!valid()) return;
          if (answer.error) throw new Error(answer.error.message);
          const server = normaliseSave(null).data as ProgressArrays;
          for (const row of answer.data ?? []) {
            const i = row.node - 1;
            if (i < 0 || i >= 32) continue;
            server.stats[i] = row.medal;
            server.times[i] = row.best_time_s ?? 0;
            server.timesString[i] = row.best_time_str ?? "";
          }
          Object.assign(data, mergeProgress(data, server));
          const merged = signature(data);
          if (merged !== current) { current = merged; revision++; }
          persist();
          // Acknowledgements cannot clear an improvement earned during this request.
          if (sentRevision === revision || (sentRevision + 1 === revision && !queued)) {
            acknowledged = current; acknowledgedRevision = revision;
          } else { acknowledged = sentSignature; acknowledgedRevision = sentRevision; }
          try { localStorage.setItem(ackKey, acknowledged); } catch { /* canonical result remains durable locally */ }
          lastError = null; failures = 0; announce();
        } catch (error) {
          if (!valid()) return;
          lastError = (error as Error).message; failures++; announce();
          schedule(Math.min(30000, SETTLE_MS * 2 ** Math.min(failures, 5)));
          break;
        } finally { if (deadline !== undefined) clearTimeout(deadline); }
      } while (queued && valid() && acknowledged !== current);
    })().finally(() => { flight = null; if (valid() && acknowledged !== current) schedule(); });
    return flight;
  }
  const wake = () => { if (document.visibilityState === "visible") void sync(); };
  addEventListener("online", wake);
  document.addEventListener("visibilitychange", wake);
  const store: SaveStore = { data, lastError: null, flush: touched };
  return {
    store, sync, touched,
    get lastError() { return lastError; }, get storageError() { return local.lastError; },
    get pending() { return !!owner && acknowledged !== current; }, get localOnly() { return !owner; },
    get revision() { return revision; }, get acknowledgedRevision() { return acknowledgedRevision; },
    onChange(fn) { listeners.add(fn); fn(); return () => listeners.delete(fn); },
    close() {
      if (closed) return;
      touched(); closed = true;
      if (timer !== null) clearTimeout(timer);
      removeEventListener("online", wake); document.removeEventListener("visibilitychange", wake);
      listeners.clear();
    },
  };
}
