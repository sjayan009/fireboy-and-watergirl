/**
 * Plays the SoundBus queue through Web Audio.
 *
 * Audio is deliberately outside the deterministic path: the engine records
 * *what should be heard* on a queue (see SoundBus in flash.ts) and this drains
 * it. Nothing here can influence the simulation, so a muted peer and a loud one
 * stay in perfect lockstep.
 *
 * There is no special "music channel" any more. `Game.as` starts the
 * soundtrack the same way it starts every other looping effect --
 * `MenuSound.play(0, 999)` -- and keeps a SoundChannel handle so it can duck
 * or stop it later. Modelling that faithfully means one mechanism: every
 * looping sound gets its own gain node, keyed by symbol, and the ported code's
 * `soundTransform` and `stop()` calls arrive as control events naming it.
 *
 * Browsers refuse to start an AudioContext without a user gesture, so the
 * context stays suspended until the first key or click and the queue is simply
 * dropped until then -- the alternative is a burst of stale effects the moment
 * the player touches the keyboard.
 */
import { SoundBus, SoundItem, SoundControl } from "../flash/flash.js";
import { assetUrl } from "../asseturl.js";

interface Loop { src: AudioBufferSourceNode; gain: GainNode; }

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Set<string>();
  private requests = new Set<AbortController>();
  private loops = new Map<string, Loop>();
  private gain: GainNode | null = null;
  /** Volumes set by the game, kept so a sound that starts later inherits it. */
  private volumes = new Map<string, number>();
  private master = 1;
  /** Loops asked for while the buffer was still decoding. */
  private pendingLoops = new Map<string, number>();
  /**
   * One-shot sources that have not finished yet.
   *
   * `stopLoops` was the only teardown and it names what it does: a footstep or
   * a splash started a frame before the view was destroyed went on playing into
   * a context nobody could reach any more.
   */
  private oneShots = new Set<AudioBufferSourceNode>();

  muted = false;

  private constructor(private index: Record<string, string>,
                      private base: string) {}

  /**
   * The two gesture listeners, so they can be taken off again.
   *
   * `{ once: true }` removes the one that FIRED and leaves the other, which is
   * a leak on its own -- and neither was removed when the view went. A page
   * that opened and left play three times had three dead players listening for
   * the next click, and that click built three AudioContexts. Browsers allow
   * somewhere in the low tens of them per document, after which every later one
   * throws and the game is silent for the rest of the session.
   */
  private wake: (() => void) | null = null;
  private gone = false;

  static async load(base: string, signal?: AbortSignal): Promise<AudioPlayer> {
    signal?.throwIfAborted();
    const res = await fetch(assetUrl(base, "sounds.json"),
                            { cache: "force-cache", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    const player = new AudioPlayer(await res.json(), base);
    if (signal?.aborted) { player.dispose(); signal.throwIfAborted(); }
    const wake = () => {
      player.removeWake();
      player.resume();
    };
    player.wake = wake;
    addEventListener("keydown", wake);
    addEventListener("pointerdown", wake);
    return player;
  }

  private removeWake(): void {
    if (!this.wake) return;
    removeEventListener("keydown", this.wake);
    removeEventListener("pointerdown", this.wake);
    this.wake = null;
  }

  get ready(): boolean { return this.ctx !== null && this.ctx.state === "running"; }
  get known(): number { return Object.keys(this.index).length; }
  get playingLoops(): number { return this.loops.size; }

  resume(): void {
    if (this.gone) return;
    if (!this.ctx) {
      const Ctor = (globalThis as any).AudioContext ??
                   (globalThis as any).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.gain = this.ctx!.createGain();
      this.gain.connect(this.ctx!.destination);
      this.applyMaster();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private buffer(symbol: string): AudioBuffer | null {
    const hit = this.buffers.get(symbol);
    if (hit) return hit;
    if (this.loading.has(symbol)) return null;
    const file = this.index[symbol];
    if (!file || !this.ctx) return null;

    this.loading.add(symbol);
    const context = this.ctx;
    const controller = new AbortController();
    this.requests.add(controller);
    // A manifest entry is either a bare filename, meaning the decoded WAVs
    // `extracted/` ships, or a path, meaning a build picked a smaller original
    // for this sound. Reading it out of the value keeps the choice in the data.
    const where = file.includes("/") ? file : `sounds_wav/${file}`;
    fetch(assetUrl(this.base, where), { signal: controller.signal })
      .then((r) => r.arrayBuffer())
      .then((b) => { if (this.gone || this.ctx !== context) throw new Error("disposed"); return context.decodeAudioData(b); })
      .then((buf) => { if (!this.gone && this.ctx === context) this.buffers.set(symbol, buf); })
      .catch(() => { /* a missing effect must never break the game */ })
      .finally(() => { this.requests.delete(controller); this.loading.delete(symbol); });
    return null;
  }

  /**
   * Play everything the simulation queued, strictly in the order it was
   * queued. Order matters across a multi-frame drain: finishing a level
   * queues "stop Adv_Sound" and then "play Menu_Sound", and handling the stop
   * first would leave the in-game soundtrack playing under the menu music.
   */
  drain(): void {
    const items: SoundItem[] = SoundBus.drain();
    if (!this.ctx || this.ctx.state !== "running") {
      // No audio yet -- the browser will not start a context without a user
      // gesture. Drop one-shots, because a burst of stale effects the moment
      // the player touches a key is worse than silence; but REMEMBER loops.
      // The soundtrack starts once, on the intro menu, long before any
      // gesture, so discarding it would mean the music simply never plays.
      for (const it of items) {
        if (it.kind === "play" && it.loops > 1) {
          this.pendingLoops.set(it.symbol, it.loops);
        } else if (it.kind === "stop") {
          this.pendingLoops.delete(it.symbol);
        } else if (it.kind === "volume") {
          if (it.symbol === "") this.master = it.volume;
          else this.volumes.set(it.symbol, it.volume);
        }
      }
      return;
    }

    for (const it of items) {
      if (it.kind === "play") this.play(it.symbol, it.loops);
      else this.control(it);
    }
    // Loops that could not start yet -- the context was asleep, or the buffer
    // was still decoding. play() re-queues them if they still cannot start.
    for (const [symbol, loops] of [...this.pendingLoops]) {
      this.pendingLoops.delete(symbol);
      this.play(symbol, loops);
    }
  }

  private control(c: SoundControl): void {
    if (c.kind === "stop") {
      this.pendingLoops.delete(c.symbol);
      const loop = this.loops.get(c.symbol);
      if (loop) {
        try { loop.src.stop(); } catch { /* already finished */ }
        loop.src.disconnect(); loop.gain.disconnect();
        this.loops.delete(c.symbol);
      }
      return;
    }
    if (c.symbol === "") {           // SoundMixer: the game's mute button
      this.master = c.volume;
      this.applyMaster();
      return;
    }
    this.volumes.set(c.symbol, c.volume);
    const loop = this.loops.get(c.symbol);
    if (loop) loop.gain.gain.value = c.volume;
  }

  private play(symbol: string, loops: number): void {
    if (this.gone) return;
    const looping = loops > 1;
    const buf = this.buffer(symbol);
    if (!buf) {
      // Remember looping requests only: a one-shot that missed its moment is
      // better dropped than played late.
      if (looping) this.pendingLoops.set(symbol, loops);
      return;
    }
    if (!this.ctx || !this.gain) return;

    // A looping effect (wind, a moving platform, the soundtrack) must not
    // stack on itself.
    if (looping && this.loops.has(symbol)) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = looping;
    if (looping) {
      const g = this.ctx.createGain();
      g.gain.value = this.volumes.get(symbol) ?? 1;
      src.connect(g);
      g.connect(this.gain);
      this.loops.set(symbol, { src, gain: g });
      src.onended = () => {
        if (this.loops.get(symbol)?.src === src) this.loops.delete(symbol);
        src.disconnect(); g.disconnect();
      };
    } else {
      src.connect(this.gain);
      this.oneShots.add(src);
      src.onended = () => {
        this.oneShots.delete(src);
        try { src.disconnect(); } catch { /* already detached */ }
      };
    }
    src.start();
  }

  private applyMaster(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.master;
  }

  /** Cut every looping effect; used when a level is torn down by hand. */
  stopLoops(): void {
    for (const [, l] of this.loops) {
      try { l.src.stop(); } catch { /* already finished */ }
      l.src.disconnect(); l.gain.disconnect();
    }
    this.loops.clear();
    this.pendingLoops.clear();
  }

  /**
   * The harness mute. Kept separate from the game's own mute button, which
   * arrives through SoundMixer -- and unlike the old behaviour it does not
   * tear down the loops, so unmuting brings the soundtrack back rather than
   * leaving silence.
   */
  setMuted(m: boolean): void {
    if (m === this.muted) return;
    this.muted = m;
    this.applyMaster();
  }

  /**
   * Give back everything this player owns.
   *
   * The counterpart `load` never had. Every one-shot source is stopped as well
   * as every loop -- a one-shot outlives the view that started it -- the graph
   * is disconnected, the gesture listeners come off, and the context is closed.
   * Closing is what actually frees the audio hardware: a suspended context
   * still counts against the per-document limit.
   *
   * Idempotent, because a view can be destroyed by a navigation and a
   * `pagehide` in the same instant, and `AudioContext.close()` on a closed
   * context throws.
   */
  dispose(): void {
    for (const request of this.requests) request.abort();
    this.requests.clear();
    if (this.gone) return;
    this.gone = true;
    this.removeWake();
    this.stopLoops();
    for (const src of this.oneShots) {
      try { src.stop(); } catch { /* already finished */ }
      try { src.disconnect(); } catch { /* already detached */ }
    }
    this.oneShots.clear();
    try { this.gain?.disconnect(); } catch { /* already detached */ }
    this.gain = null;
    this.buffers.clear();
    this.pendingLoops.clear();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }
}
