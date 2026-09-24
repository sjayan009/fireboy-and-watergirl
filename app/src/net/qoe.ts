import type { Transport } from "@engine/net/transport.js";
import type { NetSession } from "@engine/net/session.js";
import type { RenderTiming } from "@engine/embed.js";

/** Rolling percentiles have bounded storage. They are local observations,
 * never simulation inputs or an authorization/billing decision. */
class Samples {
  private values: number[] = [];
  private cursor = 0;
  add(value: number | null | undefined): void {
    if (value == null || !Number.isFinite(value) || value < 0) return;
    if (this.values.length < 2048) this.values.push(value);
    else { this.values[this.cursor] = value; this.cursor = (this.cursor + 1) % 2048; }
  }
  summary() { return percentiles(this.values); }
}

function percentiles(values: readonly number[]) {
  const sorted = values.filter(v => Number.isFinite(v) && v >= 0).sort((a,b) => a-b);
  const at = (q: number) => sorted.length ? sorted[Math.max(0,Math.ceil(sorted.length*q)-1)] : null;
  return { samples: sorted.length, p50: at(.5), p95: at(.95), max: at(1) };
}

/** No arbitrary objects are copied into summaries: specifically no candidates,
 * input contents, user identity, tokens or ICE server configuration. */
export class QoeRecorder {
  private frame = new Samples();
  private render = new Samples();
  private input = new Samples();
  private rtt = new Samples();
  private previousFrame: number | null = null;
  private lastNetwork = -Infinity;
  private observer: PerformanceObserver | null = null;
  private longTasks = 0;
  private longTaskMaxMs = 0;
  private session: NetSession | null = null;
  private transport: Transport | null = null;
  private fallbackKind: "webrtc" | "relay" | null = null;
  private cpuPercent: number | null = null;
  private closed = false;

  constructor(observeLongTasks = true) {
    if (observeLongTasks && typeof PerformanceObserver !== "undefined" &&
        PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      this.observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) this.longTask(entry.duration);
      });
      this.observer.observe({ type: "longtask" });
    }
  }

  attach(transport: Transport, kind: "webrtc" | "relay"): void {
    this.transport = transport; this.fallbackKind = kind;
  }

  tick(timestamp: number, session: NetSession | null): void {
    if (this.closed) return;
    if (this.previousFrame !== null) this.frame.add(timestamp-this.previousFrame);
    this.previousFrame = timestamp;
    if (session) this.session = session;
    if (timestamp-this.lastNetwork < 250) return;
    this.lastNetwork = timestamp;
    this.rtt.add(session?.rttMs ?? this.transport?.rttMs);
  }

  rendered(sample: RenderTiming): void {
    if (this.closed) return;
    this.render.add(sample.renderMs); this.input.add(sample.inputToRenderMs);
  }

  longTask(duration: number): void {
    if (this.closed || !Number.isFinite(duration) || duration < 50) return;
    this.longTasks++; this.longTaskMaxMs = Math.max(this.longTaskMaxMs,duration);
  }

  /** Only a harness with a real main-thread meter should populate this. */
  mainThreadCpu(percent: number): void {
    if (Number.isFinite(percent) && percent >= 0 && percent <= 100) this.cpuPercent = percent;
  }

  summary() {
    const s = this.session, t = this.transport, stats = t?.stats, rtc = t?.rtc;
    // Runtime allowlists defend even diagnostics supplied by a test/wrapper.
    const candidate = rtc?.candidateType;
    const protocol = rtc?.protocol;
    return {
      activeApplicationPath: t?.activePath ?? (this.fallbackKind === "webrtc" ? "rtc" : this.fallbackKind),
      candidateType: candidate && ["host","srflx","prflx","relay"].includes(candidate) ? candidate : null,
      protocol: protocol === "udp" || protocol === "tcp" ? protocol : null,
      rttMs: this.rtt.summary(), jitterMs: s?.jitterMs ?? null,
      transportQueueMs: percentiles(stats?.queueRecentMs ?? []),
      transportQueueLifetimeMaxMs: stats?.queueMaxMs ?? null,
      sentMessages: t?.sent ?? null,
      sentPackets: stats?.sentPackets ?? null, receivedPackets: stats?.receivedPackets ?? null,
      sentBytes: stats?.sentBytes ?? null, receivedBytes: stats?.receivedBytes ?? null,
      droppedPackets: stats?.droppedPackets ?? null,
      rollbacks: s?.rollbacks ?? null, deepestRollback: s?.deepestRollback ?? null,
      stalls: s?.stalls ?? null, inputAgeMs: s?.inputAgeMs ?? null,
      adaptiveDelayFrames: s?.inputDelay ?? null,
      frameMs: this.frame.summary(), renderMs: this.render.summary(),
      inputToRenderMs: this.input.summary(), longTasks: this.longTasks, longTaskMaxMs: this.longTaskMaxMs,
      mainThreadCpuPercent: this.cpuPercent,
      scope: "Local rolling samples (up to 2048); queue up to 512. Input is event to next simulation-bearing render; benchmark visual response separately. Session counters describe current level. CPU unavailable without harness.",
    };
  }

  close(): void {
    if (this.closed) return;
    for (const entry of this.observer?.takeRecords() ?? []) this.longTask(entry.duration);
    this.observer?.disconnect(); this.observer = null;
    latest = this.summary();
    this.closed = true;
  }
}

let latest: ReturnType<QoeRecorder["summary"]> | null = null;
/** End-screen summary held only in memory, never uploaded automatically. */
export function latestQoeSummary(): ReturnType<QoeRecorder["summary"]> | null { return latest; }
