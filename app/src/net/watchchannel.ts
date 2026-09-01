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
import { decode } from "./pairchannel.js";

const BYTES = "b";

/** The watch topic for two ids, in the order `friendships` stores them. */
export function watchTopicFor(a: string, b: string): string {
  return `watch:${a < b ? a : b}:${a < b ? b : a}`;
}

export class WatchChannel {
  private byteHandlers = new Set<(d: Uint8Array) => void>();
  private statusHandlers = new Set<(status: string) => void>();
  private settled = false;

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
   */
  static open(topic: string): Promise<WatchChannel> {
    const channel = supabase.channel(topic, { config: { private: true } });
    const watch = new WatchChannel(topic, channel);

    channel.on("broadcast", { event: BYTES }, ({ payload }) => {
      for (const b64 of (payload as { p: string[] }).p ?? []) {
        const bytes = decode(b64);
        for (const fn of watch.byteHandlers) fn(bytes);
      }
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (watch.settled) return;
        watch.settled = true;
        reject(new Error("could not join that game"));
      }, 15000);
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
          resolve(watch);
        } else if (status === "CHANNEL_ERROR" || status === "CLOSED") {
          watch.settled = true;
          clearTimeout(timer);
          reject(new Error("that game is not yours to watch"));
        }
      });
    });
  }

  onStatus(fn: (status: string) => void): () => void {
    this.statusHandlers.add(fn);
    return () => this.statusHandlers.delete(fn);
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

  async close(): Promise<void> {
    this.byteHandlers.clear();
    this.statusHandlers.clear();
    await supabase.removeChannel(this.channel);
  }
}
