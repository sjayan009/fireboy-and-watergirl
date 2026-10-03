/**
 * One session transport, two physical paths. TURN is an ICE candidate inside
 * RTC, never a third application transport. The caller coordinates fresh RTC
 * attempts; signaling, path control and emergency gameplay have separate lanes
 * on the existing private pair subscription.
 */
import { transportStats, type Transport, type TransportStats } from "@engine/net/transport.js";
import { connectWebRTC } from "@engine/net/webrtc.js";
import { decode as decodePacket } from "@engine/net/protocol.js";
import { encode } from "./base64.js";
import { RealtimeTransport, type ByteChannel } from "./realtime.js";
import { scopedChannel } from "./scope.js";

export type PathState = "STARTING" | "RTC_ACTIVE" | "RTC_SUSPECT" | "RELAY_ACTIVE" | "RTC_PROBING" | "OFFLINE";
export interface PathClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}
const clock: PathClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
};
export interface PathManagerOptions {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  timeoutMs?: number;
  legacyBatching?: boolean;
  /** Called again for each fresh connection, allowing expiring ICE credentials to refresh. */
  getIceServers?: () => Promise<RTCIceServer[]>;
  refreshIceServers?: () => Promise<RTCIceServer[]>;
  /** Dependency injection for deterministic failure/loss tests. */
  createRTC?: (signaling: Transport, caller: boolean, signal: AbortSignal) => Promise<Transport>;
  relay?: Transport;
  clock?: PathClock;
  nonce?: () => string;
  retryDelaysMs?: readonly number[];
  maxAttempts?: number;
  handoverMs?: number;
  /** Recoverable provider outages keep the same logical session for this long. */
  outageGraceMs?: number;
}

const CONTROL = 0xfc;
const MAX_PACKET = 64 * 1024;
const MAX_PENDING = 64;
const TICK_MS = 250;
const PROBE_MS = 500;
const HEARTBEAT_MS = 1000;
// 32 input frames span 1.23 s at 26 Hz. Allow one heartbeat plus WAN jitter
// before protecting gameplay; a suspect is reversible and does not retire ICE.
const SUSPECT_MS = 1500;
const RECOVERY_MS = 250;
const RELAY_LEASE_MS = 1500;
const DEAD_MS = 6000;
const DEDUP_MS = 2000;
const DEDUP_BYTES = 128 * 1024;
// One input packet covers 32 frames (1.23 s). Samples 500 ms apart keep
// overlapping coverage across the 1.5 s suspect detection interval, including
// the sender that can still advance on a one-way RTC failure.
const REPLAY_SAMPLE_MS = 500;
const MAX_REPLAY_INPUTS = 8;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const summedStats = ["sentPackets", "receivedPackets", "sentBytes", "receivedBytes", "droppedPackets",
  "queueSamples", "queueTotalMs", "bufferedBytes"] as const;
type ControlType = "PROBE" | "ACCEPT" | "RETRY" | "RELAY_ON" | "RELAY_OFF" | "PATH_HELLO" | "PATH_ACK" | "PATH_READY" | "PATH_ACTIVE";
interface Control { t: ControlType; n: string; g: number }
const controlTypes = new Set<ControlType>(["PROBE", "ACCEPT", "RETRY", "RELAY_ON", "RELAY_OFF", "PATH_HELLO", "PATH_ACK", "PATH_READY", "PATH_ACTIVE"]);
function controlBytes(value: Control): Uint8Array {
  const json = encoder.encode(JSON.stringify(value));
  const bytes = new Uint8Array(json.length + 1);
  bytes[0] = CONTROL; bytes.set(json, 1);
  return bytes;
}
function readControl(bytes: Uint8Array): Control | null {
  if (bytes[0] !== CONTROL || bytes.length > 256) return null;
  try {
    const value = JSON.parse(decoder.decode(bytes.subarray(1)));
    if (!value || !controlTypes.has(value.t) || !Number.isSafeInteger(value.g) ||
        value.g < 1 || value.g > 1000000 || typeof value.n !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.n)) return null;
    return { t: value.t, n: value.n, g: value.g };
  } catch { return null; }
}

/** Registers before credential loading, so an early offer never misses its listener. */
class SignalingTransport implements Transport {
  readonly rttMs = null;
  private handler: ((data: Uint8Array) => void) | null = null;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private closed = false;
  private readonly off: () => void;
  constructor(private channel: ByteChannel) {
    this.off = channel.onBytes(data => {
      if (this.closed || data.length > MAX_PACKET) return;
      if (this.handler) this.handler(data);
      else if (this.pending.length < MAX_PENDING && this.pendingBytes + data.length <= 128 * 1024) {
        this.pending.push(data.slice()); this.pendingBytes += data.length;
      }
    });
  }
  send(data: Uint8Array): void { if (!this.closed) this.channel.sendBytes([encode(data)]); }
  onMessage(fn: (data: Uint8Array) => void): void {
    if (this.closed) return;
    this.handler = fn;
    const pending = this.pending; this.pending = []; this.pendingBytes = 0;
    for (const data of pending) fn(data);
  }
  close(): void { this.closed = true; this.off(); this.pending = []; this.pendingBytes = 0; this.handler = null; }
}

interface Attempt {
  n: string; g: number; started: number; lastControl: number; lastHello: number;
  lastHeard: number; abort: AbortController; signaling: SignalingTransport;
  connecting: boolean; transport?: Transport;
  heardHello: boolean; acked: boolean; peerReady: boolean; peerActive: boolean;
  active: boolean; activeAt: number; dualUntil: number;
  suspect: boolean; recoverySince: number; remoteRelayUntil: number; lastRelayOn: number; lastReplay: number;
  pending: Uint8Array[]; pendingBytes: number;
}

export class PathManager implements Transport {
  state: PathState = "STARTING";
  attempts = 0;
  migrations = 0;
  duplicates = 0;
  private readonly time: PathClock;
  private readonly relay: Transport;
  private readonly control: ByteChannel;
  private readonly offControl: () => void;
  private readonly offStatus: () => void;
  private readonly retries: readonly number[];
  private readonly maxAttempts: number;
  private readonly handoverMs: number;
  private readonly createRTC: NonNullable<PathManagerOptions["createRTC"]>;
  private readonly makeNonce: () => string;
  private readonly timeoutMs: number;
  private readonly outageGraceMs: number;
  private outage: { since: number; why: string } | null = null;
  private attempt: Attempt | null = null;
  private generation = 0;
  private spent = 0;
  private nextAttempt = 0;
  private retryRequest: { n: string; g: number; until: number; last: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private relayUp = true;
  private closed = false;
  private why: string | null = null;
  private receiver: ((data: Uint8Array) => void) | null = null;
  private incoming: Uint8Array[] = [];
  private incomingBytes = 0;
  private lost: ((why: string) => void) | null = null;
  private hurryOn = false;
  private readonly retired = transportStats();
  private retiredSends = 0;
  private readonly seen = new Map<string, { data: Uint8Array; source: string; at: number }>();
  private seenBytes = 0;
  private lastInput: Uint8Array | null = null;
  private readonly recentInputs: { data: Uint8Array; at: number }[] = [];
  private readonly recentCommands: { data: Uint8Array; at: number; key: string }[] = [];

  constructor(private readonly channel: ByteChannel, private readonly caller: boolean,
              options: PathManagerOptions = {}) {
    this.time = options.clock ?? clock;
    this.retries = options.retryDelaysMs?.length ? options.retryDelaysMs : [1000, 2000, 5000, 15000, 30000];
    this.maxAttempts = Math.min(12, Math.max(1, options.maxAttempts ?? 6));
    this.handoverMs = Math.max(250, options.handoverMs ?? 1000);
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.outageGraceMs = Math.max(0, Math.min(30000, options.outageGraceMs ?? 15000));
    this.makeNonce = options.nonce ?? (() => crypto.randomUUID());
    this.relay = options.relay ?? new RealtimeTransport(scopedChannel(channel, "path-v1", "gameplay"),
      { legacyBatching: options.legacyBatching });
    this.control = scopedChannel(channel, "path-v1", "control");
    this.createRTC = options.createRTC ?? (async (signaling, caller, signal) => {
      const load = options.refreshIceServers ?? options.getIceServers;
      const iceServers = load ? await load() : options.iceServers;
      if (signal.aborted) throw new Error("cancelled");
      return connectWebRTC(signaling, caller, { iceServers, signal,
        timeoutMs: this.timeoutMs, iceTransportPolicy: options.iceTransportPolicy });
    });
    this.offControl = this.control.onBytes(data => {
      const message = readControl(data);
      if (!this.closed && message) this.onControl(message);
    });
    this.offStatus = channel.onStatus(status => {
      if (this.closed) return;
      if (status === "SUBSCRIBED") {
        const wasDown = !this.relayUp;
        this.relayUp = true; this.outage = null; this.nextAttempt = this.time.now();
        this.state = this.usableRTC() ? "RTC_ACTIVE" : this.attempt ? "RTC_PROBING" : "RELAY_ACTIVE";
        if (wasDown) this.replayEmergency();
      }
      else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "PROTOCOL_ERROR") {
        this.relayUnavailable("the emergency channel went " + status.toLowerCase());
      }
    });
    this.relay.onMessage(data => this.deliver(data, "relay"));
    // Pair status is recoverable and distinguishes a real channel outage from
    // a timed-out social/control receipt. The legacy relay's one-shot onClosed
    // intentionally does neither, so only independently injected paths use it.
    if (options.relay) this.relay.onClosed?.(why => this.relayUnavailable(why));
    this.state = "RELAY_ACTIVE";
    this.schedule(0);
  }

  get kind(): "webrtc" | "relay" { return this.usableRTC() ? "webrtc" : "relay"; }
  get activePath(): "rtc" | "relay" | "offline" { return this.closed ? "offline" : this.usableRTC() ? "rtc" : this.relayUp ? "relay" : "offline"; }
  get recovering(): boolean { return this.outage !== null; }
  get recoveryMs(): number { return this.outage ? Math.max(0, this.time.now() - this.outage.since) : 0; }
  /** Walkable by existing diagnostics and the real-PC failure test. */
  get inner(): Transport { return this.usableRTC() ?? this.relay; }
  get rtc() { return this.usableRTC()?.rtc; }
  get rttMs(): number | null { return this.inner.rttMs; }
  get pacingMs(): number { return this.inner.pacingMs ?? 0; }
  /** Physical gameplay dispatches plus RTC health/control; excludes Supabase signaling/control. */
  get sent(): number {
    const rtc = this.attempt?.transport;
    return this.retiredSends + (this.relay.sent ?? this.relay.stats?.sentPackets ?? 0) +
      (rtc?.sent ?? rtc?.stats?.sentPackets ?? 0);
  }
  get queueRecentMs(): readonly number[] {
    return this.inner.stats?.queueRecentMs ?? [];
  }
  get stats(): TransportStats {
    const stats = { ...this.retired };
    for (const path of [this.relay, this.attempt?.transport]) {
      const current = path?.stats;
      if (!current) continue;
      stats.queueMaxMs = Math.max(stats.queueMaxMs, current.queueMaxMs);
      for (const field of summedStats) stats[field] += current[field];
    }
    stats.queueRecentMs = this.queueRecentMs;
    return stats;
  }
  hurry(on: boolean): void { this.hurryOn = on; this.relay.hurry?.(on); this.attempt?.transport?.hurry?.(on); }
  onMessage(fn: (data: Uint8Array) => void): void {
    if (this.closed) return;
    this.receiver = fn;
    const pending = this.incoming; this.incoming = []; this.incomingBytes = 0;
    for (const data of pending) { if (this.closed) break; fn(data); }
  }
  onClosed(fn: (why: string) => void): void {
    this.lost = fn;
    if (this.why) { const why = this.why; this.why = null; this.lost = null; fn(why); }
  }
  send(data: Uint8Array): void {
    if (this.closed) return;
    const packet = decodePacket(data);
    if (packet?.kind === 2 /* Kind.Command, frozen wire value */) {
      const key = encode(data);
      if (!this.recentCommands.some(item => item.key === key)) this.recentCommands.push({ data: data.slice(), at: this.time.now(), key });
      while (this.recentCommands.length > 32) this.recentCommands.shift();
    }
    if (data[0] === 1 /* Kind.Input, frozen wire value */ && data.length <= 256) {
      this.lastInput = data.slice();
      const last = this.recentInputs.at(-1);
      if (!last || this.time.now() - last.at >= REPLAY_SAMPLE_MS) {
        this.recentInputs.push({ data: this.lastInput, at: this.time.now() });
        if (this.recentInputs.length > MAX_REPLAY_INPUTS) this.recentInputs.shift();
      }
    }
    const attempt = this.attempt;
    if (attempt?.transport && this.verified(attempt)) attempt.transport.send(data);
    if (this.relayUp && (!attempt?.active || !attempt.peerActive ||
        this.time.now() < attempt.dualUntil || this.needsRelay(attempt, this.time.now()))) {
      this.relay.send(data);
    }
  }
  /** Explicit retry after exhausting the automatic budget (for a diagnostics action). */
  retryRTC(): void {
    if (this.closed || this.attempt) return;
    this.spent = 0; this.nextAttempt = this.time.now();
    if (!this.caller && this.generation > 0 && this.retryRequest) this.retryRequest.until = this.time.now() + 60000;
  }

  private verified(a: Attempt): boolean { return a.heardHello && a.acked; }
  private needsRelay(a: Attempt, now: number): boolean { return a.suspect || now < a.remoteRelayUntil; }
  private usableRTC(): Transport | undefined {
    const a = this.attempt;
    return a && this.verified(a) && (a.active || !this.relayUp) &&
      (!this.relayUp || !this.needsRelay(a, this.time.now())) ? a.transport : undefined;
  }
  private schedule(ms: number): void {
    this.timer = this.time.setTimeout(() => { this.timer = null; this.tick(); }, ms);
  }
  private tick(): void {
    if (this.closed) return;
    const now = this.time.now();
    if (this.outage && !this.relayUp && !this.usableRTC() && now - this.outage.since >= this.outageGraceMs) {
      this.endOffline(this.outage.why); return;
    }
    const a = this.attempt;
    if (a) {
      if (!a.active && now - a.started >= this.timeoutMs + 4000) this.failAttempt(a);
      else if (a.active && !a.peerActive && now - a.activeAt > 4000) this.failAttempt(a);
      else if (a.active && now - a.lastHeard > DEAD_MS) this.failAttempt(a);
      else {
        if (a.active && a.peerActive && this.relayUp && now - a.lastHeard >= SUSPECT_MS && !a.suspect) {
          a.suspect = true; a.recoverySince = 0; this.state = "RTC_SUSPECT";
          this.replayInput(a);
        }
        if (a.suspect && this.relayUp && now - a.lastRelayOn >= PROBE_MS) {
          this.signal("RELAY_ON", a); a.lastRelayOn = now;
          this.replayInput(a);
        }
        if (!a.suspect && a.remoteRelayUntil && now >= a.remoteRelayUntil) {
          a.remoteRelayUntil = 0; this.state = "RTC_ACTIVE";
        }
        if (this.caller && !a.connecting && now - a.lastControl >= PROBE_MS) {
          this.signal("PROBE", a); a.lastControl = now;
        }
        if (a.transport && now - a.lastHello >= (a.active && a.peerActive ? HEARTBEAT_MS : TICK_MS)) {
          this.pathSignal("PATH_HELLO", a); a.lastHello = now;
          if (this.verified(a)) this.pathSignal(a.active ? "PATH_ACTIVE" : "PATH_READY", a);
        }
        if (a.active && a.peerActive && now >= a.dualUntil && !this.needsRelay(a, now)) {
          // A coalesced held-input timer must not publish after promotion.
          (this.relay as Transport & { discardPending?(): void }).discardPending?.();
        }
        if (a.active && now - a.activeAt > 30000) this.spent = 0;
      }
    }
    if (!this.attempt && this.caller && this.relayUp && this.spent < this.maxAttempts && now >= this.nextAttempt) {
      const next = this.newAttempt(this.makeNonce(), ++this.generation);
      this.signal("PROBE", next); next.lastControl = now;
    }
    const request = this.retryRequest;
    if (!this.caller && !this.attempt && this.relayUp && this.spent < this.maxAttempts &&
        request && now <= request.until && now - request.last >= PROBE_MS) {
      this.signal("RETRY", request); request.last = now;
    }
    if (!this.closed) this.schedule(TICK_MS);
  }
  private newAttempt(n: string, g: number): Attempt {
    const now = this.time.now();
    const a: Attempt = {
      n, g, started: now, lastControl: -Infinity, lastHello: -Infinity, lastHeard: now,
      abort: new AbortController(),
      signaling: new SignalingTransport(scopedChannel(this.channel, `rtc:${g}:${n}`, "signaling")),
      connecting: false, heardHello: false, acked: false, peerReady: false, peerActive: false,
      active: false, activeAt: 0, dualUntil: Infinity, pending: [], pendingBytes: 0,
      suspect: false, recoverySince: 0, remoteRelayUntil: 0, lastRelayOn: -Infinity, lastReplay: -Infinity,
    };
    this.attempt = a; this.spent++; this.attempts++; this.retryRequest = null;
    this.state = "RTC_PROBING";
    return a;
  }
  private signal(t: ControlType, a: { n: string; g: number }): void {
    if (this.relayUp && !this.closed) this.control.sendBytes([encode(controlBytes({ t, n: a.n, g: a.g }))]);
  }
  private pathSignal(t: ControlType, a: Attempt): void { a.transport?.send(controlBytes({ t, n: a.n, g: a.g })); }
  private onControl(message: Control): void {
    if (!this.relayUp) return;
    let a = this.attempt;
    if (message.t === "PROBE" && !this.caller) {
      if (a && message.g === a.g && message.n === a.n) { this.signal("ACCEPT", a); return; }
      if (message.g <= this.generation || this.spent >= this.maxAttempts) return;
      // A fresh caller attempt also communicates an asymmetric RTC failure.
      // Emergency receive stays installed while the old connection is retired.
      if (a) this.disposeAttempt(a);
      this.generation = message.g;
      a = this.newAttempt(message.n, message.g);
      this.connectAttempt(a); this.signal("ACCEPT", a);
      return;
    }
    if (!a || message.n !== a.n || message.g !== a.g) return;
    if (message.t === "RELAY_ON" && a.active) {
      a.remoteRelayUntil = this.time.now() + RELAY_LEASE_MS;
      this.state = "RTC_SUSPECT";
      this.replayInput(a);
    }
    if (message.t === "RELAY_OFF" && a.active) {
      a.remoteRelayUntil = 0;
      if (!a.suspect) this.state = "RTC_ACTIVE";
    }
    if (message.t === "ACCEPT" && this.caller && !a.connecting) this.connectAttempt(a);
    if (message.t === "RETRY" && this.caller) this.failAttempt(a);
  }
  private connectAttempt(a: Attempt): void {
    if (a.connecting) return;
    a.connecting = true;
    void Promise.resolve().then(() => this.createRTC(a.signaling, this.caller, a.abort.signal)).then(transport => {
      if (this.closed || this.attempt !== a || a.abort.signal.aborted) { transport.close(); return; }
      a.transport = transport; transport.hurry?.(this.hurryOn);
      transport.onMessage(data => this.onRTC(a, data));
      transport.onClosed?.(() => { if (this.attempt === a) this.failAttempt(a); });
      this.pathSignal("PATH_HELLO", a); a.lastHello = this.time.now();
    }).catch(() => { if (!this.closed && this.attempt === a) this.failAttempt(a); });
  }
  private onRTC(a: Attempt, data: Uint8Array): void {
    if (this.closed || this.attempt !== a || data.length > MAX_PACKET) return;
    const message = readControl(data);
    if (data[0] === CONTROL) {
      if (!message || message.n !== a.n || message.g !== a.g) return;
      this.heardRTC(a);
      if (message.t === "PATH_HELLO") { a.heardHello = true; this.pathSignal("PATH_ACK", a); }
      if (message.t === "PATH_ACK") a.acked = true;
      if (message.t === "PATH_READY" || message.t === "PATH_ACTIVE") a.peerReady = true;
      if (message.t === "PATH_ACTIVE") a.peerActive = true;
      if (this.verified(a)) {
        const pending = a.pending; a.pending = []; a.pendingBytes = 0;
        for (const bytes of pending) this.deliver(bytes, `rtc:${a.n}`);
        if (!a.active && a.peerReady) {
          a.active = true; a.activeAt = this.time.now(); this.migrations++;
          this.state = this.needsRelay(a, this.time.now()) ? "RTC_SUSPECT" : "RTC_ACTIVE";
          this.pathSignal("PATH_ACTIVE", a);
        }
        if (a.active && a.peerActive && a.dualUntil === Infinity) a.dualUntil = this.time.now() + this.handoverMs;
        if (!a.active) this.pathSignal("PATH_READY", a);
      }
      return;
    }
    // An early game packet can overtake HELLO on an unordered data channel.
    // Hold a bounded window until this exact candidate has proved both ways.
    if (this.verified(a)) { this.heardRTC(a); this.deliver(data, `rtc:${a.n}`); }
    else if (a.pending.length < MAX_PENDING && a.pendingBytes + data.length <= 128 * 1024) {
      a.pending.push(data.slice()); a.pendingBytes += data.length;
    }
  }

  private heardRTC(a: Attempt): void {
    const now = this.time.now();
    a.lastHeard = now;
    if (!a.suspect) return;
    if (!a.recoverySince) { a.recoverySince = now; return; }
    if (now - a.recoverySince < RECOVERY_MS) return;
    a.suspect = false; a.recoverySince = 0;
    this.signal("RELAY_OFF", a);
    if (!this.needsRelay(a, now)) this.state = "RTC_ACTIVE";
  }

  private replayInput(a: Attempt, force = false): void {
    const now = this.time.now();
    if (!this.relayUp || !this.lastInput || (!force && now - a.lastReplay < PROBE_MS)) return;
    a.lastReplay = now;
    // The sender can run 30 frames ahead while the other peer waits 1.5 s to
    // suspect a one-way failure. By then its newest 32-frame history may no
    // longer include the missing frame. Replay overlapping older snapshots in
    // order; a stalled session also keeps its last snapshot available.
    this.replayEmergency();
  }

  private replayEmergency(): void {
    if (!this.relayUp) return;
    const now = this.time.now();
    while (this.recentCommands.length && now - this.recentCommands[0].at > 15000) this.recentCommands.shift();
    const packets = [...this.recentCommands.map(item => item.data), ...this.recentInputs.map(item => item.data)];
    if (this.lastInput && packets.at(-1) !== this.lastInput) packets.push(this.lastInput);
    const relay = this.relay as Transport & { sendUncoalesced?(packets: readonly Uint8Array[]): void };
    if (relay.sendUncoalesced) relay.sendUncoalesced(packets);
    else for (const data of packets) relay.send(data);
  }

  private failAttempt(a: Attempt): void {
    if (this.closed || this.attempt !== a) return;
    // The accepting peer may be the only endpoint told about a broken RTC.
    // RETRY is repeated until the caller responds with a fresh attempt nonce.
    if (!this.caller) {
      this.retryRequest = { n: a.n, g: a.g, until: this.time.now() + 60000, last: -Infinity };
      this.signal("RETRY", a);
    }
    this.disposeAttempt(a);
    this.state = "RELAY_ACTIVE";
    if (this.relayUp) this.replayInput(a, true);
    this.nextAttempt = this.time.now() + this.retries[Math.min(Math.max(0, this.spent - 1), this.retries.length - 1)];
    if (!this.relayUp) this.offline("all gameplay paths are unavailable");
  }
  private disposeAttempt(a: Attempt): void {
    if (this.attempt === a) this.attempt = null;
    a.abort.abort(); a.signaling.close();
    const stats = a.transport?.stats;
    this.retiredSends += a.transport?.sent ?? stats?.sentPackets ?? 0;
    if (stats) {
      this.retired.queueMaxMs = Math.max(this.retired.queueMaxMs, stats.queueMaxMs);
      for (const field of summedStats) if (field !== "bufferedBytes") this.retired[field] += stats[field];
    }
    a.transport?.close(); a.pending = []; a.pendingBytes = 0;
  }
  private relayUnavailable(why: string): void {
    if (this.closed) return;
    this.relayUp = false;
    if (!this.usableRTC()) this.offline(why);
  }
  private deliver(data: Uint8Array, source: string): void {
    if (this.closed || data.length > MAX_PACKET || data[0] === CONTROL) return;
    const now = this.time.now();
    for (const [key, item] of this.seen) {
      if (now - item.at < DEDUP_MS) break;
      this.seen.delete(key); this.seenBytes -= item.data.length;
    }
    // Keep game bytes intact for the relay's protocol-aware edge publisher.
    // Byte-exact cross-path dedup does not suppress same-path command retries.
    const key = encode(data);
    const old = this.seen.get(key);
    if (old && old.source !== source) { this.duplicates++; return; }
    if (!old) {
      this.seen.set(key, { data: data.slice(), source, at: now }); this.seenBytes += data.length;
      while (this.seen.size > 256 || this.seenBytes > DEDUP_BYTES) {
        const first = this.seen.entries().next().value!;
        this.seen.delete(first[0]); this.seenBytes -= first[1].data.length;
      }
    }
    if (this.receiver) this.receiver(data);
    else if (this.incoming.length < MAX_PENDING && this.incomingBytes + data.length <= 128 * 1024) {
      this.incoming.push(data.slice()); this.incomingBytes += data.length;
    }
  }
  private offline(why: string): void {
    if (this.closed) return;
    this.state = "OFFLINE";
    this.outage ??= { since: this.time.now(), why };
    if (this.outageGraceMs === 0) this.endOffline(why);
  }
  private endOffline(why: string): void {
    if (this.closed) return;
    const fn = this.lost; this.lost = null;
    this.close();
    if (fn) fn(why); else this.why = why;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.state = "OFFLINE";
    if (this.timer !== null) this.time.clearTimeout(this.timer);
    this.timer = null; this.offControl(); this.offStatus();
    if (this.attempt) this.disposeAttempt(this.attempt);
    this.relay.close(); this.retryRequest = null;
    this.seen.clear(); this.seenBytes = 0; this.lastInput = null; this.recentInputs.length = 0;
    this.recentCommands.length = 0; this.outage = null;
    this.incoming = []; this.incomingBytes = 0;
    this.receiver = null; this.lost = null;
  }
}

/** Invoke only after both invitation and acceptance advertise pathManager. */
export function createPathManager(channel: ByteChannel, caller: boolean,
                                  options: PathManagerOptions = {}): PathManager {
  return new PathManager(channel, caller, options);
}
