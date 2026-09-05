/**
 * The second topic a pair has: `watch:<lo>:<hi>`.
 *
 * Deliberately not part of `PairChannel`, and the separation is the security
 * design rather than tidiness. The pair's own topic carries their presence,
 * their invitations and the signalling for their peer connection, and is
 * readable by exactly the two of them -- `supabase/realtimetest.mjs` exists to
 * prove a third account is refused. This one carries a copy of the input they
 * are already exchanging and nothing else, and is readable by friends of either
 * of them. Two topics, two policies, and no way for the wider audience of the
 * second to reach the first.
 *
 * Nobody publishes here unless the pair has turned watching on, so a game
 * nobody is sharing costs no messages at all.
 *
 * Simpler than `PairChannel` on purpose: no presence, no rejoin. A watcher
 * whose channel drops sees the game stop and can leave and come back, which is
 * a fair trade for not carrying a second copy of that machinery. The pair's own
 * channel is the one that must survive anything, because everything else rides
 * on it.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../supabase.js";
import { packetsIn } from "./pairchannel.js";
import { ENGINE_VERSION } from "@engine/version.js";

const BYTES = "b";

/** The watch topic for two ids, in the order `friendships` stores them. */
export function watchTopicFor(a: string, b: string): string {
  return `watch:${a < b ? a : b}:${a < b ? b : a}`;
}

export class WatchChannel {
  private byteHandlers = new Set<(d: Uint8Array) => void>();
  private statusHandlers = new Set<(status: string) => void>();
  private settled = false;
  private viewerHandlers = new Set<() => void>();
  private snapshotHandlers = new Set<(text: string, epoch: number) => void>();
  viewers = 0;

  private constructor(
    readonly topic: string,
    private readonly channel: RealtimeChannel,
  ) {}

  /**
   * Join, and resolve once the server has let us in.
   *
   * A refusal is `CHANNEL_ERROR`, not a thrown error -- so for a watcher who is
   * friends with neither player it has to become one here, or they would sit in
   * front of a canvas waiting for a game they are never going to be shown.
   *
   * ## Every way out of here gives the channel back
   *
   * It used to reject and leave the Supabase channel it had just allocated
   * subscribed to the client. The caller catches the error and drops the
   * object, so `close()` -- the only thing that called `removeChannel` -- had
   * become unreachable: every refusal and every timeout leaked a channel for
   * the life of the tab, and the Realtime client has a limit on those.
   *
   * `signal` is the other half. Opening is a round trip and the user can leave
   * during it; without a way to say so, the completion handler attached a live
   * channel and a live session to a screen that had already been destroyed.
   */
  static open(topic: string, signal?: AbortSignal, viewer = false): Promise<WatchChannel> {
    const channel = supabase.channel(topic, { config: { private: true, presence: { key: crypto.randomUUID() } } });
    const watch = new WatchChannel(topic, channel);
    channel.on("presence", { event: "sync" }, () => {
      const count = Math.min(100,Object.values(channel.presenceState()).flat().length);
      if (count > watch.viewers) for (const fn of watch.viewerHandlers) fn();
      watch.viewers = count;
    });
    let snapshot: { id: string; chunks: string[]; epoch: number; at: number; total: number } | null = null;
    channel.on("broadcast", { event: "snapshot" }, ({ payload }) => {
      if (!viewer || watch.closed || !payload || payload.build !== ENGINE_VERSION || typeof payload.id !== "string" || payload.id.length > 36 || !Number.isInteger(payload.part) || !Number.isInteger(payload.total) || payload.total < 1 || payload.total > 70 || payload.part < 0 || payload.part >= payload.total || typeof payload.text !== "string" || payload.text.length > 16000 || !Number.isInteger(payload.epoch) || payload.epoch < 0 || payload.epoch > 255) return;
      if (!snapshot || snapshot.id !== payload.id) snapshot = { id: payload.id, chunks: [], epoch: payload.epoch, at: Date.now(), total: payload.total };
      if (snapshot.total !== payload.total || snapshot.epoch !== payload.epoch || Date.now() - snapshot.at > 15000) return;
      snapshot.chunks[payload.part] = payload.text;
      if (snapshot.chunks.filter(Boolean).length === snapshot.total) {
        const ready = snapshot; snapshot = null;
        for (const fn of watch.snapshotHandlers) fn(ready.chunks.join(""),ready.epoch);
      }
    });

    channel.on("broadcast", { event: BYTES }, ({ payload }) => {
      for (const bytes of packetsIn(payload)) {
        for (const fn of watch.byteHandlers) fn(bytes);
      }
    });

    return new Promise((resolve, reject) => {
      /** Give the channel back, whichever way this ends badly. */
      const abandon = (why: Error) => {
        watch.settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        void supabase.removeChannel(channel).catch(() => { /* already gone */ });
        reject(why);
      };
      const onAbort = () => {
        if (watch.settled) return;
        abandon(new Error("cancelled"));
      };
      const timer = setTimeout(() => {
        if (watch.settled) return;
        abandon(new Error("could not join that game"));
      }, 15000);

      if (signal?.aborted) { abandon(new Error("cancelled")); return; }
      signal?.addEventListener("abort", onAbort);

      channel.subscribe((status) => {
        if (watch.settled) {
          // Whatever the connection does afterwards. A watcher whose channel
          // goes needs to be told the game stopped rather than left in front of
          // a canvas that has quietly frozen.
          for (const fn of watch.statusHandlers) fn(status);
          return;
        }
        if (status === "SUBSCRIBED") {
          watch.settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          // Subscribed a moment after the screen went. Nothing is going to
          // close this but us.
          if (signal?.aborted) {
            void supabase.removeChannel(channel).catch(() => {});
            reject(new Error("cancelled"));
            return;
          }
          resolve(watch);
          if (viewer) void channel.track({ viewer: true });
        } else if (status === "CHANNEL_ERROR" || status === "CLOSED") {
          abandon(new Error("that game is not yours to watch"));
        }
      });
    });
  }

  onStatus(fn: (status: string) => void): () => void {
    this.statusHandlers.add(fn);
    return () => this.statusHandlers.delete(fn);
  }
  onViewer(fn: () => void): () => void { this.viewerHandlers.add(fn); if (this.viewers) fn(); return () => this.viewerHandlers.delete(fn); }
  onSnapshot(fn: (text: string, epoch: number) => void): () => void { this.snapshotHandlers.add(fn); return () => this.snapshotHandlers.delete(fn); }
  snapshot(text: string, epoch: number): void {
    if (this.closed || text.length > 1048576) return;
    const id = crypto.randomUUID();
    const total = Math.ceil(text.length / 16000);
    void (async () => {
      for (let part = 0; part < total && !this.closed; part++) {
        const status = await this.channel.send({ type: "broadcast", event: "snapshot", payload: { build: ENGINE_VERSION, id, epoch, part, total, text: text.slice(part * 16000,(part + 1) * 16000) } });
        if (status !== "ok") break;
      }
    })().catch(() => {});
  }

  /**
   * Put a batch of the pair's packets on the topic. Players only -- the write
   * policy refuses everybody else, so a watcher calling this is refused by the
   * database rather than by politeness.
   */
  sendBytes(packets: string[]): void { this.feed(packets); }

  feed(packets: string[]): void {
    void this.channel.send({ type: "broadcast", event: BYTES,
                             payload: { p: packets } })
      .then((status) => {
        if (status !== "ok") console.warn(`the watch feed said: ${status}`);
      })
      .catch((e) => console.warn("the watch feed failed:", e));
  }

  onBytes(fn: (d: Uint8Array) => void): () => void {
    this.byteHandlers.add(fn);
    return () => this.byteHandlers.delete(fn);
  }

  private closed = false;

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.byteHandlers.clear();
    this.viewerHandlers.clear(); this.snapshotHandlers.clear();
    this.statusHandlers.clear();
    await supabase.removeChannel(this.channel);
  }
}
