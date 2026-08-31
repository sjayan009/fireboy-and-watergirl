/**
 * Netplay: rollback, with lockstep still in the box.
 *
 * Both peers run the same simulation on the same inputs and never exchange
 * state -- only the three bits each player presses. That works because the
 * engine is a pure function of (mode, level, input log), verified across V8,
 * SpiderMonkey and JavaScriptCore.
 *
 * ## Two modes, and why the second one exists
 *
 * **Lockstep** runs a frame only once both players' input for it is known. To
 * avoid waiting, a peer decides its input for frame `F + delay` and sends it
 * ahead. Nobody stalls, but you pay a constant delay between pressing a key and
 * seeing your own character move -- about 115 ms at 26 Hz and delay 3. It is
 * simple, it is proved, and it is what this file did first.
 *
 * **Rollback** does not wait and does not delay. Your input applies to the very
 * next frame, exactly as in single-player, and the peer's input is *guessed* as
 * "whatever they were doing last" -- which in a platformer, where keys are held
 * for many frames at a time, is right almost every time. When the guess turns
 * out wrong, the session restores the snapshot from the frame the guess was
 * made on and re-simulates with the truth. The correction is a few frames of
 * physics, and it lands before anyone could see it.
 *
 * Rollback is affordable here for a specific, measured reason: re-simulating a
 * frame costs about **0.04 ms** and a snapshot costs about **4.7 ms**, against a
 * 38.5 ms frame. Most games cannot say that.
 *
 * ## One snapshot, not a ring
 *
 * The textbook implementation keeps a snapshot per frame and restores the exact
 * one it needs. Here the two costs are lopsided enough to make that the wrong
 * shape: a snapshot is a hundred times dearer than a re-simulated frame, so it
 * is far cheaper to restore an OLDER state and re-simulate the extra frames
 * than it is to have saved the exact one.
 *
 * So there is a single snapshot, taken at a frame both players' real input has
 * settled, and every correction rewinds to it. It is refreshed only when it has
 * fallen `snapLag` frames behind the settled frontier, which also puts a floor
 * under how often the digests get recorded. The result is one capture per eight
 * frames rather than eight, and 1.4 MB of memory instead of 17 MB.
 *
 * ## What has to be true for this to work
 *
 * Re-simulation runs frames that already ran. Anything with an effect outside
 * the simulation must therefore happen *once*, on the frame's first run only --
 * sound, and writing progress to the save. `step` is told whether it is
 * replaying so the host can suppress them; getting that wrong is the classic
 * rollback bug and it sounds like a machine gun.
 *
 * Solo play runs through this same session with a NullTransport, so the
 * single-player path and the netplay path are one path and a bug in either
 * shows up in both.
 */
import { Transport } from "./transport.js";
import { Snapshot } from "./snapshot.js";
import {
  Command, HISTORY, Kind, decode, encodeCommand, encodeInput,
} from "./protocol.js";

/** 0 drives Fireboy (input bits 0-2), 1 drives Watergirl (bits 3-5). */
export type Slot = 0 | 1;

/**
 * What the session needs from the game. Kept as an interface so the netcode
 * can be tested against a trivial fake as well as the real Game, and so the
 * session never imports the renderer.
 */
export interface SessionHost {
  /**
   * Advance exactly one fixed step, applying all six input bits.
   *
   * `replaying` is true when this frame has been simulated before and is being
   * re-run to correct a mispredicted input. The physics must be identical
   * either way; everything that leaves the simulation -- a sound, a save --
   * must happen only when it is false.
   */
  step(bits: number, frame: number, replaying: boolean): void;
  /** Digest of the shared simulation state, or null if no level is running. */
  hash(): string | null;
  /** Build a level. Called on Start, and again on every rebuild. */
  start(mode: string, num: number): void;
  /** Toggle the pause tray. */
  pause(): void;
  /** Rebuild the current level from its beginning. */
  retry(): void;
  /** Leave the level. */
  quit(): void;
  /**
   * Capture the whole simulation into `s`, including any state that lives in
   * module scope where no walk can reach it. Only needed for rollback.
   */
  save?(s: Snapshot): void;
  /** Put back what `save` captured. */
  load?(s: Snapshot): void;
}

export interface SessionOptions {
  slot: Slot;
  transport: Transport;
  host: SessionHost;
  /**
   * Predict the peer's input and correct by re-simulating, instead of waiting
   * for it. Costs a snapshot per frame and removes the input delay entirely.
   */
  rollback?: boolean;
  /** Frames of input delay. 0 under rollback; 3 at 26 Hz is about 115 ms. */
  delay?: number;
  /** How far back a correction may reach. Beyond this the session waits. */
  maxRollback?: number;
  /**
   * How far the snapshot may fall behind the settled frontier before it is
   * refreshed. Larger means fewer captures and longer re-simulations, which is
   * a good trade at a hundred to one.
   */
  snapLag?: number;
  /** Fixed timestep, matching the original's 26 fps. */
  timeStep?: number;
  /** Compare digests every N frames. Hashing costs 8 us, so this is cheap. */
  hashEvery?: number;
  /** Solo: no remote peer, so never stall waiting for one. */
  solo?: boolean;
  onDesync?: (frame: number, mine: string, theirs: string) => void;
  /**
   * A Quit took effect and the level is over, with `bySlot` naming who asked.
   *
   * Both peers hear this on the same frame, including the one who sent it, so a
   * page can say "they left" or "you left" from the same callback instead of
   * inferring it from which button was last pressed.
   *
   * `forGood` separates the two very different things a Quit can mean: back to
   * the map to pick another level, or that person closing the tab. They travel
   * as one command because they are one thing to the simulation, and they are
   * nothing alike to the person left sitting there.
   */
  onQuit?: (bySlot: Slot, forGood: boolean) => void;
  /**
   * The transport says the link is gone. Nothing more is coming over it.
   *
   * The session does not act on this itself, and deliberately so: it cannot
   * know whether the answer is to reconnect, to wait, or to give up, and it has
   * no way to build a new link even if it did. It stops predicting -- there is
   * nothing left to predict from -- and tells whoever owns the transport.
   */
  onLinkDown?: (why: string) => void;
}

/**
 * The three modes, in the order the wire numbers them and the order the ported
 * `StartGame` switches on -- adventure is type 1, so `MODES[type - 1]`.
 *
 * Exported because three places need the same list and disagreeing about it
 * would be a session where each peer started a different level: `Command.Start`
 * carries the index, `GameHost` turns it back into the type digit, and the
 * shell reads it out of a map node's name.
 */
export const MODES = ["adventure", "puzzle", "speed"];

/**
 * How many further times a command is sent after the first.
 *
 * Enough to survive a run of losses on a link bad enough to be worth playing
 * on at all; the packets are seven bytes, so the cost of being generous is
 * nothing.
 */
const COMMAND_RESENDS = 12;

export class NetSession {
  readonly slot: Slot;
  private readonly other: Slot;
  private readonly transport: Transport;
  private readonly host: SessionHost;
  private readonly rollbackOn: boolean;
  private readonly delay: number;
  private readonly maxRollback: number;
  private readonly snapLag: number;
  private readonly timeStep: number;
  private readonly hashEvery: number;
  private readonly solo: boolean;
  private readonly onDesync?: SessionOptions["onDesync"];
  private readonly onQuit?: SessionOptions["onQuit"];
  private readonly onLinkDown?: SessionOptions["onLinkDown"];

  /** Per-slot input, indexed by absolute frame. undefined = not yet known. */
  private input: [(number | undefined)[], (number | undefined)[]] = [[], []];
  /**
   * What we guessed the peer was pressing on each frame we ran without knowing,
   * or undefined if we knew. Kept so that the truth arriving can be COMPARED:
   * a guess that turns out right needs no correction at all, which under real
   * play -- where keys are held for many frames -- is most of them.
   */
  private guess: (number | undefined)[] = [];
  /**
   * Commands to apply, keyed by the frame they take effect on.
   *
   * Unlike input these are never consumed: a rollback re-runs the frame they
   * belong to and has to apply them again, so they are pruned by age instead.
   */
  private commands = new Map<number, { command: Command; a: number; b: number }[]>();
  /** Our own digests, so a remote one can be checked against the same frame. */
  private hashes = new Map<number, string>();
  /**
   * Commands still being re-sent, because the channel may have eaten one.
   *
   * `left` counts down; `untilHeard` does not count at all. Start is the one
   * command a fixed number of attempts is not good enough for -- every other
   * command can be missed and the game merely feels wrong, but a Start that
   * never lands leaves the two peers on different generations of the level
   * forever, with no path back. So it is re-sent until the peer's own input
   * proves they are on it.
   */
  private outbox: {
    packet: Uint8Array; left: number; untilHeard?: boolean;
  }[] = [];
  /** Whether the peer has sent anything at all on this generation. */
  private heard = false;
  /**
   * Which build of the level we are on. Bumped by every Start and Retry, which
   * both peers apply at the same frame, so both counters move together.
   *
   * Without it, a retry makes frame numbers ambiguous: packets still in flight
   * for frames 195-201 of the level just left get filed as frames 195-201 of
   * the level just started, and played back seconds later as if real.
   */
  private epoch = 0;

  /**
   * The simulation as it stood *before* `snapFrame` ran. Every correction
   * rewinds to here and re-simulates forward.
   */
  private snap: Snapshot | null = null;
  private snapFrame = -1;
  /**
   * The earliest frame a correction still owes, or -1.
   *
   * Packets are folded in here rather than acted on the moment they land, so
   * three arriving between two ticks cost one rewind instead of three. Under a
   * jittery link that is most of them.
   */
  private owed = -1;

  /** The next frame to run. */
  frame = 0;
  /** One past the newest frame ever run. Frames below this are re-runs. */
  private ran = 0;
  /** The oldest frame we do not yet have the peer's real input for. */
  private confirmed = 0;
  /** The peer's newest real input, which is also the guess for the next one. */
  private lastRemote = 0;
  /** The next frame we have not yet decided our own input for. */
  private nextLocal = 0;
  /** What this player is pressing right now, three bits. */
  private localBits = 0;
  private acc = 0;

  private started = false;
  /** True while waiting on the other peer's input. */
  stalled = false;
  /** Frames spent stalled, for the connection readout. */
  stalledFrames = 0;
  desyncs = 0;
  /** Corrections made, and the deepest one, for the connection readout. */
  rollbacks = 0;
  deepestRollback = 0;
  /** Snapshots taken. The dear half of rollback, so worth being able to see. */
  captures = 0;
  /** Full replays, which should stay at zero and are a bug if they do not. */
  rebuilds = 0;
  /** How far ahead of us the peer's newest input is, in frames. */
  lead = 0;
  /**
   * The transport has reported itself gone.
   *
   * Read by the page to tell "they are lagging" from "there is no longer a
   * connection", which look identical from the stall counter alone and are the
   * difference between waiting and doing something about it.
   */
  linkDown = false;

  private mode = "adventure";
  private num = 1;

  constructor(o: SessionOptions) {
    this.slot = o.slot;
    this.other = (o.slot === 0 ? 1 : 0) as Slot;
    this.transport = o.transport;
    this.host = o.host;
    this.rollbackOn = (o.rollback ?? false) && !!o.host.save && !!o.host.load;
    // Rollback's whole point is that there is nothing to wait for, so it wants
    // no delay. Lockstep needs enough to cover a round trip.
    this.delay = o.delay ?? (this.rollbackOn ? 0 : 3);
    this.maxRollback = o.maxRollback ?? 10;
    this.timeStep = o.timeStep ?? 1 / 26;
    this.hashEvery = o.hashEvery ?? 8;
    this.solo = o.solo ?? false;
    this.onDesync = o.onDesync;
    this.onQuit = o.onQuit;
    this.onLinkDown = o.onLinkDown;
    this.snapLag = o.snapLag ?? this.hashEvery;
    if (this.rollbackOn) this.snap = new Snapshot();
    this.transport.onMessage((d) => this.receive(d));
    // Optional on the interface, because a BroadcastChannel between two tabs
    // and the tests' in-memory link have no such state to report.
    this.transport.onClosed?.((why) => {
      if (this.linkDown) return;
      this.linkDown = true;
      this.onLinkDown?.(why);
    });
  }

  /** Whether this session predicts and corrects rather than waiting. */
  get predicting(): boolean { return this.rollbackOn && !this.solo; }

  /**
   * Whether a level is running and this session owns the clock.
   *
   * False before the first Start and again after a Quit, and that gap is a real
   * state rather than a broken one: the pair is still connected, still hears
   * each other's commands, and is sitting on the map deciding what to play
   * next. The page has to know, because between levels the SHELL runs -- the
   * map, its fireflies, the boards -- and nothing shared is being simulated, so
   * the clock belongs to the page's own loop and not to this.
   */
  get running(): boolean { return this.started; }

  /**
   * Which build of the level this peer is on. Two peers in step are on the
   * same one, and a test that only compares digests cannot see the difference
   * between "agreed" and "both idle on nothing".
   */
  get generation(): number { return this.epoch; }

  // ---- starting ---------------------------------------------------------

  /**
   * Begin a level. Both peers must call this with the same arguments, which
   * the lobby guarantees by sending Start through the command channel.
   */
  begin(mode: string, num: number): void {
    this.mode = mode;
    this.num = num;
    this.epoch = (this.epoch + 1) & 0xff;
    this.host.start(mode, num);
    this.started = true;
    this.heard = false;
    this.resetLog();
  }

  /** Everything that is indexed by frame number, back to frame zero. */
  private resetLog(): void {
    this.input = [[], []];
    this.guess = [];
    this.commands.clear();
    this.hashes.clear();
    this.log.length = 0;
    // The outbox deliberately survives: a Retry applies one frame after it is
    // sent, so clearing it here would leave the command with a single delivery
    // attempt, and a peer that missed it would be stranded on the old level.
    // Stale resends are harmless now that packets carry an epoch.
    this.frame = 0;
    this.ran = 0;
    this.confirmed = 0;
    this.lastRemote = 0;
    this.acc = 0;
    this.stalledFrames = 0;
    this.owed = -1;
    this.snapFrame = -1;
    // The first `delay` frames have no decided input, so both peers agree in
    // advance that they are neutral. Without this a lockstep session deadlocks
    // on frame 0 waiting for input nobody was ever going to send.
    for (let f = 0; f < this.delay; f++) {
      this.input[0][f] = 0;
      this.input[1][f] = 0;
    }
    this.confirmed = this.delay;
    this.nextLocal = this.delay;
    // The state a correction rewinds to has to exist before the first frame
    // runs, or the first mispredicted frame has nothing to go back to.
    if (this.rollbackOn && !this.solo) this.takeSnapshot(this.frame);
    this.scheduleLocal();
  }

  /** Park the single snapshot on frame `f`, which must be the state we are in. */
  private takeSnapshot(f: number): void {
    if (!this.snap) return;
    this.host.save!(this.snap);
    this.snap.frame = f;
    this.snapFrame = f;
    this.captures++;
  }

  /**
   * Ask the other peer to start a level, and start it ourselves.
   *
   * Refused while a level is already running. The one caller that could reach
   * this mid-level is a map click, and the map is not on screen mid-level --
   * but a Start applied on one peer and dropped by the other's `started` guard
   * is a divergence with no way back, so it is worth being explicit rather
   * than relying on where the button happens to live.
   */
  requestStart(mode: string, num: number): void {
    if (this.started) return;
    const m = Math.max(0, MODES.indexOf(mode));
    // Start is the one command that cannot be scheduled on a future frame:
    // there is no session running yet to count frames in.
    const packet = encodeCommand({
      kind: Kind.Command, slot: this.slot, epoch: this.epoch, frame: 0,
      command: Command.Start, a: m, b: num,
    });
    this.transport.send(packet);
    // Not "like any other command": re-sent until they answer. Thirteen copies
    // is a very good bet and not a guarantee, and the one time it loses, the
    // two peers are stranded on different generations with nothing that can
    // notice, because every later packet is filtered by the epoch they no
    // longer share.
    this.outbox.push({ packet, left: COMMAND_RESENDS, untilHeard: true });
    this.begin(mode, num);
  }

  /**
   * Leave for good, and make sure they hear about it.
   *
   * Not `send(Command.Quit)`, and the difference is the whole point. An
   * ordinary command is scheduled a rollback window into the future so both
   * peers apply it on the same frame -- which works because both peers keep
   * feeding each other the input needed to GET to that frame. Somebody closing
   * their tab does not: they schedule a Quit ten frames ahead and then send
   * nothing else, so the peer runs to the edge of its prediction window and
   * stalls one frame short of the very command that would have released it.
   * It is a race the leaver always wins by leaving.
   *
   * So a departure is not scheduled at all. There is no longer a pair to keep
   * in step, so there is nothing for the two of them to disagree about, and the
   * honest thing is to apply it the moment it lands. Sent a few times because
   * the resends ride on input packets that are not coming either.
   */
  depart(): void {
    if (!this.started) return;
    const packet = encodeCommand({
      kind: Kind.Command, slot: this.slot, epoch: this.epoch,
      frame: this.frame, command: Command.Quit, a: this.slot, b: 1,
    });
    if (!this.solo) for (let i = 0; i < 3; i++) this.transport.send(packet);
    this.host.quit();
    this.started = false;
  }

  // ---- input ------------------------------------------------------------

  /** This player's three bits: 1 = left, 2 = right, 4 = up. */
  setLocalInput(bits: number): void {
    this.localBits = bits & 7;
  }

  /**
   * Decide and send our input for every frame up to the delay horizon.
   *
   * A frame's input is decided ONCE and never revised, even if the session
   * stalls for a second afterwards -- the peer has already been told, and
   * changing our mind would mean the two simulations disagree.
   */
  private scheduleLocal(): void {
    let sent = false;
    while (this.nextLocal <= this.frame + this.delay) {
      this.input[this.slot][this.nextLocal] = this.localBits;
      this.nextLocal++;
      sent = true;
    }
    if (sent && !this.solo) this.sendInput();
  }

  private sendInput(): void {
    const newest = this.nextLocal - 1;
    const bits: number[] = [];
    for (let i = 0; i < HISTORY && newest - i >= 0; i++) {
      bits.push(this.input[this.slot][newest - i] ?? 0);
    }
    // The newest digest we have. The peer checks it against its own for the
    // same frame; a mismatch is a desync and nothing else.
    let hashFrame = 0;
    let hash = 0;
    for (const [f, h] of this.hashes) {
      if (f >= hashFrame) { hashFrame = f; hash = parseInt(h, 16) >>> 0; }
    }
    this.transport.send(encodeInput({
      kind: Kind.Input, slot: this.slot, epoch: this.epoch,
      frame: newest, bits, hashFrame, hash,
    }));

  }

  /**
   * Send the commands that are still owed an answer.
   *
   * Input heals itself, because every packet repeats the last sixteen frames.
   * A command has no such redundancy, so it is simply sent again for a while.
   *
   * Driven from `tick` rather than from `sendInput`, which is where it used to
   * live -- and that was a resend schedule that stopped exactly when the
   * session stopped sending input. A stalled peer is precisely the one that has
   * missed something, and it was the one peer whose commands stopped being
   * repeated. It is also why a departure could not be scheduled at all.
   */
  private drainOutbox(): void {
    if (this.solo || this.outbox.length === 0) return;
    for (const c of this.outbox) {
      if (c.untilHeard) { this.transport.send(c.packet); continue; }
      if (c.left-- > 0) this.transport.send(c.packet);
    }
    this.outbox = this.outbox.filter((c) => c.untilHeard || c.left > 0);
  }

  // ---- commands ---------------------------------------------------------

  /**
   * Pause, retry and quit all change state both peers simulate, so they travel
   * the same channel as input and take effect on an agreed frame. Applying one
   * locally the moment the key is pressed is the single easiest way to desync
   * this game.
   *
   * Under rollback a command that arrives for a frame already simulated is not
   * a problem: it forces a correction, exactly as a mispredicted input does.
   */
  send(command: Command, a = 0, b = 0): void {
    // Far enough ahead that neither peer can already have simulated past it by
    // the time the packet lands. Input is worth shaving frames off; a command
    // is not -- nobody notices 400 ms on a pause, and a command that arrives
    // for a frame already behind the snapshot cannot be applied at all.
    const at = this.frame + this.delay + this.maxRollback;
    this.queueCommand(at, command, a, b);
    if (this.solo) return;
    const packet = encodeCommand({
      kind: Kind.Command, slot: this.slot, epoch: this.epoch,
      frame: at, command, a, b,
    });
    this.transport.send(packet);
    this.outbox.push({ packet, left: COMMAND_RESENDS });
  }

  /**
   * Record a command, ignoring one already there.
   *
   * Commands are re-sent for several frames because the channel is unreliable
   * and, unlike input, a lost one has no redundancy to heal it -- a dropped
   * Pause would leave one peer paused and the other running, which is a desync
   * that never repairs. Re-sending only works if arriving twice is harmless,
   * hence the duplicate check: applying Pause twice would toggle it back.
   */
  private queueCommand(frame: number, command: Command, a: number,
                       b: number): boolean {
    const list = this.commands.get(frame) ?? [];
    for (const c of list) {
      if (c.command === command && c.a === a && c.b === b) return false;
    }
    list.push({ command, a, b });
    this.commands.set(frame, list);
    return true;
  }

  // ---- receiving --------------------------------------------------------

  private receive(data: Uint8Array): void {
    const p = decode(data);
    if (!p) return;
    if (p.slot === this.slot) return;        // our own packet, echoed back
    // A packet from a level we have already left, or from one we have not
    // started yet. Either way its frame numbers mean nothing to us: the peer's
    // redundancy will re-send whatever we miss once we are both on the same
    // build.
    if (p.epoch !== this.epoch) return;

    if (p.kind === Kind.Input) {
      // They are on our generation, so whatever we were repeating until they
      // said so has been said. Input is the acknowledgement: it is the one
      // thing a peer that has started the level cannot help sending.
      if (!this.heard) {
        this.heard = true;
        this.outbox = this.outbox.filter((c) => !c.untilHeard);
      }
      for (let i = 0; i < p.bits.length; i++) {
        const f = p.frame - i;
        if (f < 0) break;
        // Only fill gaps. A repeat of a frame we already have must never
        // overwrite it -- packets arrive out of order, and the first copy is
        // as authoritative as the last.
        if (this.input[p.slot][f] !== undefined) continue;
        this.input[p.slot][f] = p.bits[i];
        // A frame we already ran on a guess only owes a correction if the
        // guess was actually wrong.
        const g = this.guess[f];
        if (g !== undefined && g !== p.bits[i]) this.owe(f);
      }
      this.lead = Math.max(0, p.frame - this.frame);
      this.advanceConfirmed();
      if (p.hashFrame > 0) this.checkHash(p.hashFrame, p.hash);
      return;
    }

    if (p.command === Command.Start) {
      if (!this.started) this.begin(MODES[p.a] ?? "adventure", p.b);
      return;
    }
    // A peer that has gone. See `depart`: this one is deliberately not
    // scheduled, because the frame it would be scheduled on is one this peer
    // may never be able to reach -- the input that would carry it there left
    // with them.
    if (p.command === Command.Quit && p.b === 1) {
      if (!this.started) return;
      this.host.quit();
      this.started = false;
      this.onQuit?.((p.a === 1 ? 1 : 0) as Slot, true);
      return;
    }
    // Only a command we did not already have is worth re-simulating for. This
    // matters because commands are re-sent for a dozen frames: without the
    // check, every resend of a Pause already applied would demand a correction
    // back to a frame long since settled.
    const fresh = this.queueCommand(p.frame, p.command, p.a, p.b);
    if (fresh && p.frame < this.frame) this.owe(p.frame);
  }

  /**
   * Note that `f` and everything after it has to be simulated again.
   *
   * A frame older than the snapshot cannot be corrected by rewinding, because
   * there is nothing to rewind to. That should be unreachable -- input is only
   * predicted inside the window, and commands are scheduled beyond it -- so
   * reaching it means an assumption broke, and the honest answer is the same
   * one a desync gets: rebuild the level and replay the whole log, which is a
   * couple of hundred milliseconds and always correct.
   */
  private owe(f: number): void {
    if (this.rollbackOn && this.snapFrame >= 0 && f < this.snapFrame) {
      this.rebuilds++;
      this.resync();
      return;
    }
    if (this.owed < 0 || f < this.owed) this.owed = f;
  }

  /** Walk the confirmed frontier forward over every frame now known for real. */
  private advanceConfirmed(): void {
    while (this.input[this.other][this.confirmed] !== undefined) {
      this.lastRemote = this.input[this.other][this.confirmed] as number;
      this.confirmed++;
    }
    // Commands are deliberately never pruned. There are a handful per level --
    // a pause, a retry -- and a full replay has to be able to re-apply every
    // one of them from frame zero. `resetLog` is what clears them.
  }

  // ---- correction -------------------------------------------------------

  /**
   * Rewind to the snapshot and re-simulate, if anything has come in that makes
   * the last few frames wrong -- or if the snapshot itself has gone stale.
   *
   * Called once per tick rather than once per packet. Three packets arriving
   * between two frames then cost one rewind instead of three, which under a
   * jittery link is most of them.
   *
   * The stale case is not an optimisation, it is what keeps the safety net
   * connected. A frame simulated on a guess gets no digest, because a digest
   * over a guess would report a desync that correcting the guess fixes. Under
   * rollback nearly every frame is first simulated on a guess, so if nothing
   * ever rewound, nothing would ever be checked. Refreshing the snapshot drags
   * the session back through those frames once the truth is in, and they are
   * hashed on the way past.
   */
  private settle(): void {
    if (!this.rollbackOn || this.solo || !this.started) return;
    if (this.snapFrame < 0 || this.snapFrame > this.frame) return;

    const wrong = this.owed >= 0 && this.owed < this.frame;
    const stale = this.confirmed - this.snapFrame >= this.snapLag;
    if (!wrong && !stale) return;

    const target = this.frame;
    // As far forward as the settled frontier allows, but never past where we
    // have actually got to.
    const park = Math.min(this.confirmed, target);
    // Nothing to re-run and nowhere new to park: restoring would be a very
    // expensive way to do nothing.
    if (target === this.snapFrame && park <= this.snapFrame) return;

    this.host.load!(this.snap!);
    this.frame = this.snapFrame;
    this.owed = -1;
    if (target > this.snapFrame) {
      this.rollbacks++;
      const depth = target - this.snapFrame;
      if (depth > this.deepestRollback) this.deepestRollback = depth;
    }

    // Move the snapshot only when it has actually gone stale. Parking it on
    // every correction would mean a capture per correction, and a capture is
    // the dear operation: rewinding a few frames further costs 0.04 ms each,
    // where taking a snapshot costs a hundred times that.
    this.parkAt = stale && park > this.snapFrame ? park : -1;
    for (let f = this.frame; f < target; f++) {
      this.runFrame(f);
      if (this.frame <= f) break;            // a command rebuilt the level
    }
    // A snapshot due on the frame we are about to run next is taken here,
    // because the loop above never reaches it.
    if (this.parkAt === target) this.takeSnapshot(target);
    this.parkAt = -1;
  }

  /** The frame the snapshot should be re-taken on, during a re-simulation. */
  private parkAt = -1;

  private checkHash(frame: number, theirs: number): void {
    const mine = this.hashes.get(frame);
    if (mine === undefined) return;          // not there yet, or already aged out
    const hex = (theirs >>> 0).toString(16).padStart(8, "0");
    if (mine === hex) return;
    this.desyncs++;
    this.onDesync?.(frame, mine, hex);
    this.resync();
  }

  // ---- the loop ---------------------------------------------------------

  /**
   * Advance by elapsed wall time.
   *
   * Under lockstep a frame runs only once both players' input for it is known,
   * and otherwise the session stalls -- which is what lockstep does instead of
   * guessing. Under rollback it guesses, and stalls only when it has run so far
   * ahead of the peer that a correction could no longer reach back.
   */
  tick(dt: number): void {
    if (!this.started) return;
    this.drainOutbox();
    this.settle();
    this.scheduleLocal();
    this.acc += Math.min(dt, 0.25);          // clamp after a tab stall

    // A generous cap: a peer coming back from a stall should be able to catch
    // up quickly, and stepping is far cheaper than rendering.
    let budget = 60;
    while (this.acc >= this.timeStep && budget-- > 0) {
      // Deciding this frame's input HERE and not after the previous frame is
      // the difference between one frame of lag and two: committing ahead
      // freezes whatever the player was pressing a frame ago.
      this.scheduleLocal();
      if (!this.ready(this.frame)) {
        this.stalled = true;
        this.stalledFrames++;
        return;
      }
      this.stalled = false;
      const at = this.frame;
      this.runFrame(at);
      this.acc -= this.timeStep;
      // A command may have rebuilt the level under us and restarted the frame
      // count; the new level's first frame is next time round, not this one.
      if (this.frame <= at) break;
    }
  }

  private ready(frame: number): boolean {
    if (this.input[this.slot][frame] === undefined) return false;
    if (this.solo) return true;
    if (this.rollbackOn) {
      // Running further ahead than a correction could reach back would mean
      // guessing at frames we could never fix. Waiting is the honest failure.
      return frame - this.confirmed < this.maxRollback;
    }
    return this.input[this.other][frame] !== undefined;
  }

  private runFrame(frame: number): void {
    const replaying = frame < this.ran;

    // Before the step, because a correction has to reach the state the frame
    // started from, not the one it produced.
    if (frame === this.parkAt) this.takeSnapshot(frame);

    const pending = this.commands.get(frame);
    if (pending) {
      for (const c of pending) this.applyCommand(c.command, c.a, c.b);
      // Retry, Quit and Start all tear the level down and reset the frame
      // count. There is no "rest of this frame" to run: the log this frame was
      // indexed in no longer exists. Detected by the frame counter MOVING --
      // it equals `frame` on the way in, so testing it against `frame` alone
      // would abort every frame that carried any command at all.
      if (this.frame !== frame) return;
    }

    // The peer's input, or the best guess at it: whatever they were doing last.
    // A platformer holds keys for many frames at a time, so this is right far
    // more often than not, and being wrong costs one correction.
    let theirs = this.input[this.other][frame];
    const guess = theirs === undefined;
    if (guess) theirs = this.solo ? 0 : this.lastRemote;
    this.guess[frame] = guess ? (theirs as number) : undefined;

    const mine = this.input[this.slot][frame] ?? 0;
    const bits = this.slot === 0
      ? mine | ((theirs as number) << 3)
      : (theirs as number) | (mine << 3);
    this.log[frame] = bits;
    this.host.step(bits, frame, replaying);
    this.frame = frame + 1;
    if (this.frame > this.ran) this.ran = this.frame;

    // Only a frame both players' real input decided is worth a digest. One
    // taken over a guess would flag a desync that correcting the guess fixes.
    const settled = this.solo || !guess;
    if (settled && this.frame % this.hashEvery === 0) {
      const h = this.host.hash();
      if (h) {
        this.hashes.set(this.frame, h);
        // Keep a few seconds of history; a digest older than the peer's
        // round trip can never be checked against anything.
        if (this.hashes.size > 64) {
          const oldest = this.hashes.keys().next().value as number;
          this.hashes.delete(oldest);
        }
      }
    }
  }

  private applyCommand(command: Command, a: number, b: number): void {
    switch (command) {
      case Command.Pause: this.host.pause(); break;
      case Command.Retry: this.retryLevel(); break;
      case Command.Quit:
        this.host.quit();
        this.started = false;
        this.onQuit?.((a === 1 ? 1 : 0) as Slot, b === 1);
        break;
      case Command.Start: this.begin(MODES[a] ?? "adventure", b); break;
    }
  }

  /**
   * Retry restarts the level, so the frame counter and both input logs restart
   * with it. Anything else would leave the two peers indexing the same log at
   * different points -- and every snapshot in the ring now describes a level
   * that no longer exists.
   */
  private retryLevel(): void {
    this.host.retry();
    this.epoch = (this.epoch + 1) & 0xff;
    this.heard = false;
    this.resetLog();
  }

  /**
   * The combined input each frame was finally simulated with, indexed by frame.
   *
   * Written on every run of a frame, so after a correction it holds the truth
   * rather than the guess. That makes it a replayable log of the session -- the
   * thing the rollback test compares a straight re-simulation against, and the
   * thing a desync report would carry.
   */
  readonly log: number[] = [];

  // ---- recovery ---------------------------------------------------------

  /**
   * Rebuild the level and replay every input we have.
   *
   * With identical input logs and a deterministic engine this should be
   * unreachable, so reaching it means a genuine engine bug -- but the cost of
   * carrying the safety net is one function, because replay runs at hundreds
   * of times realtime. The same path serves late join and reconnect.
   */
  resync(): void {
    const upto = this.frame;
    this.host.start(this.mode, this.num);
    this.hashes.clear();
    this.frame = 0;
    this.ran = 0;
    this.owed = -1;
    this.snapFrame = -1;
    if (this.rollbackOn && !this.solo) this.takeSnapshot(0);
    for (let f = 0; f < upto; f++) {
      if (this.input[this.slot][f] === undefined) break;
      if (!this.rollbackOn && this.input[this.other][f] === undefined) break;
      this.runFrame(f);
      if (this.frame <= f) break;            // a command rebuilt the level
    }
  }

  /** How much of the level has been simulated, in seconds of play. */
  get elapsed(): number { return this.frame * this.timeStep; }

  /**
   * Bytes held by the snapshot, so a test can assert what "one snapshot, not a
   * ring" is supposed to mean: a figure that does not grow with the length of
   * the session.
   */
  get snapshotBytes(): number { return this.snap?.stats.bytes ?? 0; }
}
