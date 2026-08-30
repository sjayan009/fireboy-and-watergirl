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

interface Loop { src: AudioBufferSourceNode; gain: GainNode; }

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Set<string>();
  private loops = new Map<string, Loop>();
  private gain: GainNode | null = null;
  /** Volumes set by the game, kept so a sound that starts later inherits it. */
  private volumes = new Map<string, number>();
  private master = 1;
  /** Loops asked for while the buffer was still decoding. */
  private pendingLoops = new Map<string, number>();

  muted = false;

  private constructor(private index: Record<string, string>,
                      private base: string) {}

  static async load(base: string): Promise<AudioPlayer> {
    const res = await fetch(`${base}/sounds.json`, { cache: "force-cache" });
    const player = new AudioPlayer(await res.json(), base);
    const wake = () => player.resume();
    addEventListener("keydown", wake, { once: true });
    addEventListener("pointerdown", wake, { once: true });
    return player;
  }

  get ready(): boolean { return this.ctx !== null && this.ctx.state === "running"; }
  get known(): number { return Object.keys(this.index).length; }
  get playingLoops(): number { return this.loops.size; }

  resume(): void {
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
    // A manifest entry is either a bare filename, meaning the decoded WAVs
    // `extracted/` ships, or a path, meaning a build picked a smaller original
    // for this sound. Reading it out of the value keeps the choice in the data.
    const where = file.includes("/") ? file : `sounds_wav/${file}`;
    fetch(`${this.base}/${where}`)
      .then((r) => r.arrayBuffer())
      .then((b) => this.ctx!.decodeAudioData(b))
      .then((buf) => { this.buffers.set(symbol, buf); })
      .catch(() => { /* a missing effect must never break the game */ })
      .finally(() => this.loading.delete(symbol));
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
      };
    } else {
      src.connect(this.gain);
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
}
