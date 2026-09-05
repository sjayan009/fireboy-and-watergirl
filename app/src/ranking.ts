import { supabase } from "./supabase.js";
import { auth } from "./auth.js";
import type { NetSession } from "@engine/net/session.js";
import { canonicalReplay, completedResult } from "@engine/verified.js";
import { ENGINE_VERSION } from "@engine/version.js";

interface RankedWrite { key: string; owner: string; attempt: string; digest: string; replay: string | null; at: number }
interface Context { friend: string; connection: string; uploader: boolean }
type Registration = { id: Promise<string>; finished: boolean };
export const leaderboardCache = new Map<string, { at: number; data: unknown }>();

function db(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open("fbwg.ranked",1);
    request.onupgradeneeded = () => request.result.createObjectStore("pending", { keyPath: "key" }).createIndex("owner","owner");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Ranking storage unavailable"));
  });
}
async function pending(owner: string): Promise<RankedWrite[]> {
  const database = await db();
  try {
    return await new Promise((resolve,reject) => {
      const r = database.transaction("pending").objectStore("pending").index("owner").getAll(owner);
      r.onsuccess = () => resolve(r.result as RankedWrite[]);
      r.onerror = () => reject(r.error ?? new Error("Ranking storage unavailable"));
    });
  } finally { database.close(); }
}
async function write(entry: RankedWrite, remove = false): Promise<void> {
  const database = await db();
  try {
    await new Promise<void>((resolve,reject) => {
      const tx = database.transaction("pending","readwrite");
      if (remove) tx.objectStore("pending").delete(entry.key); else tx.objectStore("pending").put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Ranking storage unavailable"));
    });
  } finally { database.close(); }
}

/** Ranking is a separate durable workflow; it never blocks personal progress. */
export class Ranking {
  private owner = auth().user?.id ?? "";
  private runs = new Map<string, Registration>();
  private closed = false;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private changed: (label: string) => void) { this.schedule(0); }
  private registration(context: Context, session: NetSession): Registration {
    const key = `${context.connection}:${session.runSerial}`;
    let run = this.runs.get(key);
    if (!run) {
      const selection = session.selection;
      const id = (async () => {
        const { data,error } = await supabase.rpc("register_ranked_attempt", { their_id: context.friend, p_connection: context.connection, p_run: session.runSerial, p_mode: selection.mode, p_level: selection.num, p_engine: ENGINE_VERSION }).abortSignal(AbortSignal.timeout(5000));
        if (error || typeof data !== "string") throw new Error("Ranking registration unavailable");
        return data;
      })();
      run = { id, finished: false };
      this.runs.set(key,run);
      if (this.runs.size > 100) this.runs.delete(this.runs.keys().next().value!);
      void id.catch(() => { if (!this.closed) this.changed("Not ranked · registration unavailable"); });
    }
    return run;
  }
  async prepare(context: Context, session: NetSession): Promise<void> {
    if (!session.running || this.closed || auth().user?.id !== this.owner) return;
    // A failed registration permits ordinary play and cannot publish a ranking.
    await this.registration(context,session).id.catch(() => {});
  }
  observe(context: Context, session: NetSession, game: any, confirmedFrame?: number): void {
    if (!session.running || this.closed || auth().user?.id !== this.owner) return;
    const run = this.registration(context,session);
    if (!confirmedFrame || run.finished || !completedResult(game,confirmedFrame)) return;
    const replay = session.replay(confirmedFrame);
    if (!replay) return;
    run.finished = true;
    const text = canonicalReplay(replay);
    this.changed("Pending verification");
    void (async () => {
      const attempt = await run.id;
      const hash = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
      const digest = Array.from(new Uint8Array(hash),b => b.toString(16).padStart(2,"0")).join("");
      await write({ key: `${this.owner}:${attempt}`, owner: this.owner, attempt, digest, replay: context.uploader ? text : null, at: Date.now() });
      this.schedule(0);
    })().catch(() => { if (!this.closed) this.changed("Not ranked · replay could not be queued"); });
  }
  private schedule(ms: number): void {
    if (this.closed || this.timer !== null) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); },ms);
  }
  async flush(): Promise<void> {
    if (this.busy || this.closed || document.hidden || auth().user?.id !== this.owner) return;
    this.busy = true;
    try {
      const entries = await pending(this.owner);
      for (const entry of entries) {
        if (this.closed || auth().user?.id !== this.owner) break;
        const response = await supabase.rpc("ranked_status", { p_attempt: entry.attempt });
        if (response.error) throw new Error("Verification status unavailable");
        let state: unknown = response.data?.[0]?.state;
        if (!state && Date.now() - entry.at > 12 * 60 * 60 * 1000) state = "not_ranked";
        if (state === "waiting" || !state) {
          const { data,error } = await supabase.rpc("submit_ranked_replay", { p_attempt: entry.attempt, p_digest: entry.digest, p_replay: entry.replay });
          if (error) throw new Error("Verification submission unavailable");
          state = data;
        }
        if (state === "verified" || state === "not_ranked") {
          await write(entry,true);
          this.changed(state === "verified" ? "Verified" : "Not ranked");
          if (state === "verified") leaderboardCache.clear();
        } else {
          // Once stored on the server, retries carry only the acknowledgement.
          if (state !== "waiting" && entry.replay) await write({ ...entry, replay: null });
          this.changed("Pending verification");
        }
      }
    } catch { if (!this.closed) this.changed("Pending verification · retry needed"); }
    finally { this.busy = false; this.schedule(10000); }
  }
  close(): void { this.closed = true; if (this.timer !== null) clearTimeout(this.timer); }
}
