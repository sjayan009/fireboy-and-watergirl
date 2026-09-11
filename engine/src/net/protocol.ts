/**
 * The wire format. Two packet kinds, both tiny.
 *
 * A player's whole input is THREE BITS per frame -- left, right, up -- so an
 * input packet carrying a 32-frame window still fits in 65 bytes, and a
 * session costs about 1.7 kB a second including the redundancy. That budget
 * is what lets every packet repeat recent history instead of the protocol
 * having acknowledgements, retransmission or ordering.
 *
 * Frames are absolute, counted from the start of the level. There is no
 * session-relative numbering to get out of step.
 *
 * ## The epoch
 *
 * Retry rebuilds the level and restarts the frame count at zero, which makes
 * every frame number ambiguous for as long as the old ones are still in flight.
 * Without a way to tell them apart, a peer that has just retried takes the
 * packets still arriving for frames 195-201 of the level it left and files them
 * as frames 195-201 of the level it just started -- and then plays them, some
 * seconds later, as if they were real. The symptom is a desync that appears
 * only after a retry on a link with any latency at all.
 *
 * So every packet carries the generation of the level it belongs to, and a peer
 * ignores anything from a generation it has already left.
 *
 * ## The trailer, and why it is outside the checksum
 *
 * An input packet now also carries what the two peers need to keep their CLOCKS
 * together: when it was sent, when the sender last heard from us and how long
 * it sat on that before answering (which is a round trip, measured without
 * spending a message on it), how far ahead the sender believes it is, and the
 * back half of the input history.
 *
 * All of that rides in a trailer AFTER the body's Fletcher-16 rather than
 * inside it, and that is a deployment decision rather than a design preference.
 * `decode` reads the body checksum from a fixed offset, so a client built
 * before this change validates the first `18 + n` bytes exactly as it always
 * did and ignores whatever follows -- which means a pair with one reloaded
 * browser and one stale one keeps playing through a deploy instead of dropping
 * every packet. The cost is that the trailer needs its own checksum, because
 * the body's does not cover it.
 *
 * The history split is the same story. `decode` refuses `n > BODY_HISTORY`, so
 * an old client handed a 32-frame packet would reject it outright. The body
 * therefore still carries at most sixteen frames and the rest goes in the
 * trailer, where an old client simply does not look.
 */

export const enum Kind {
  Input = 1,
  Command = 2,
}

/**
 * How many frames of history a packet's BODY may repeat.
 *
 * Frozen at sixteen forever: it is the number the deployed decoder bounds `n`
 * against, so raising it would reject packets at every client that has not
 * reloaded. Depth beyond this goes in the trailer.
 */
export const BODY_HISTORY = 16;

/**
 * How many frames of history a packet repeats in total.
 *
 * This is the real redundancy window, and it is the ceiling on how far a peer
 * may run ahead of what it has confirmed -- run further and a gap opens that no
 * single packet can fill. It went from sixteen to thirty-two because sixteen
 * made this project a conspicuous outlier: GGPO carries sixty-four frames of
 * redundancy against an eight-frame rollback window, eight times the depth,
 * and GekkoNet carries a hundred and twenty-eight. Here it was sixteen against
 * fourteen -- 1.14 times -- so a burst of loss at the edge of the window could
 * not be healed and the pair stalled.
 *
 * The two buffers are priced completely differently, which is why everybody
 * else sizes them apart. Rollback depth costs CPU on every correction;
 * redundancy costs bytes on a packet that was going to be sent anyway. Sixteen
 * more frames is sixteen more bytes -- 34 to 50 on the wire, 45 to 67 through
 * base64 -- against a re-simulation cost that this engine measures at 0.04 ms a
 * frame. Doubling the delay budget was the cheapest thing available.
 */
export const HISTORY = 32;

/** What the trailer may carry, which is everything past the body's sixteen. */
export const EXTRA_HISTORY = HISTORY - BODY_HISTORY;

/**
 * Marks a trailer as a trailer.
 *
 * Bytes past the body checksum are not, in general, ours: a transport is
 * allowed to pad, and a damaged packet can be any length at all. A magic byte
 * plus the trailer's own checksum is what separates "this sender speaks the
 * newer protocol" from "there is rubbish on the end of this".
 */
const TRAILER_MAGIC = 0xa7;

/** Fixed part of a trailer: magic, advantage, sent, echo, held, m, checksum. */
const TRAILER_FIXED = 15;

/** Things other than movement that change shared state. */
export const enum Command {
  /** Begin a level. `a` = mode index, `b` = level number. */
  Start = 1,
  /** Toggle the pause tray. */
  Pause = 2,
  /** Rebuild the current level. */
  Retry = 3,
  /** Leave to the level map. */
  Quit = 4,
}

/**
 * What a peer says about the clock, alongside its input.
 *
 * Every field is the SENDER's claim and none of it is trusted: `decode` clamps
 * the advantage and the session ignores a round trip that does not make sense.
 * A peer running a modified client can put any number here, and the worst it
 * may do is make its own partner run slightly slow.
 */
export interface Timing {
  /**
   * How many frames BEHIND the peer the sender believes itself to be.
   *
   * Negative means the sender is ahead. The sign is GGPO's, kept deliberately:
   * `local_frame_advantage = remoteFrame - localFrame`, which reads backwards
   * until you notice that "advantage" is about who has the greater claim on the
   * next frame rather than who has run more of them.
   */
  advantage: number;
  /** The sender's own monotonic clock when it sent this, in whole ms. */
  sent: number;
  /** The newest `sent` the sender had received from US when it answered. */
  echo: number;
  /** How long the sender sat on that before sending this, in ms. */
  held: number;
}

export interface InputPacket {
  kind: Kind.Input;
  slot: number;
  /** Which build of the level this belongs to. See "The epoch" above. */
  epoch: number;
  /** The newest frame in `bits`. Earlier entries count backwards from it. */
  frame: number;
  /** Newest first, up to HISTORY entries, three bits each. */
  bits: number[];
  /** A state digest the sender computed, for desync detection. */
  hashFrame: number;
  hash: number;
  /** Absent on a packet from a client built before the trailer existed. */
  timing?: Timing;
}

export interface CommandPacket {
  kind: Kind.Command;
  slot: number;
  /** Which build of the level this belongs to. See "The epoch" above. */
  epoch: number;
  /** The frame the command takes effect on. Both peers apply it there. */
  frame: number;
  command: Command;
  a: number;
  b: number;
}

export type Packet = InputPacket | CommandPacket;

/**
 * The widest advantage a packet may claim.
 *
 * Sixty-four frames is two and a half seconds at 26 Hz, far past anything a
 * real pair reaches and far short of a number that could make the dilation
 * below do something violent. A peer that claims more is clamped rather than
 * dropped: the input in the same packet is still good, and refusing it over a
 * field that only paces the clock would turn a nuisance into a disconnection.
 */
const MAX_ADVANTAGE = 64;

/** Milliseconds a `held` may claim, which is also what a uint16 can hold. */
const MAX_HELD = 65535;

export function encodeInput(p: InputPacket): Uint8Array {
  const n = Math.min(p.bits.length, BODY_HISTORY);
  const m = p.timing ? Math.min(Math.max(p.bits.length - BODY_HISTORY, 0), EXTRA_HISTORY) : 0;
  const trailer = p.timing ? TRAILER_FIXED + m : 0;
  const out = new Uint8Array(18 + n + trailer);
  const view = new DataView(out.buffer);
  out[0] = Kind.Input;
  out[1] = p.slot;
  view.setUint32(2, p.frame);
  view.setUint32(6, p.hashFrame);
  view.setUint32(10, p.hash);
  out[14] = p.epoch & 0xff;
  out[15] = n;
  for (let i = 0; i < n; i++) out[16 + i] = p.bits[i] & 7;
  const ck = fletcher16(out, 0, 16 + n);
  out[16 + n] = ck & 0xff;
  out[17 + n] = ck >>> 8;
  if (!p.timing) return out;

  const b = 18 + n;
  out[b] = TRAILER_MAGIC;
  // Two's complement in one byte; `decode` reads it back as signed.
  out[b + 1] = clamp(Math.round(p.timing.advantage), -MAX_ADVANTAGE, MAX_ADVANTAGE) & 0xff;
  view.setUint32(b + 2, p.timing.sent >>> 0);
  view.setUint32(b + 6, p.timing.echo >>> 0);
  view.setUint16(b + 10, clamp(Math.round(p.timing.held), 0, MAX_HELD));
  out[b + 12] = m;
  for (let i = 0; i < m; i++) out[b + 13 + i] = p.bits[BODY_HISTORY + i] & 7;
  const tck = fletcher16(out, b, b + 13 + m);
  out[b + 13 + m] = tck & 0xff;
  out[b + 14 + m] = tck >>> 8;
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function encodeCommand(p: CommandPacket): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  out[0] = Kind.Command;
  out[1] = p.slot;
  view.setUint32(2, p.frame);
  out[6] = p.command;
  out[7] = p.a;
  out[8] = p.b;
  out[9] = p.epoch & 0xff;
  const ck = fletcher16(out, 0, 10);
  out[10] = ck & 0xff;
  out[11] = ck >>> 8;
  return out;
}

/**
 * The largest frame number a packet may claim.
 *
 * Ten million frames is about four and a half days of continuous play in one
 * level, so nothing real comes near it -- but the field is a uint32, and a
 * packet whose bytes were damaged in flight can claim four billion. Input is
 * stored in an array indexed by frame, and writing to index 4,000,000,000 turns
 * it into a dictionary and the session into a memory leak.
 */
const MAX_FRAME = 10_000_000;

/**
 * Fletcher-16 over a range of a packet, excluding the two bytes that hold it.
 *
 * Both real transports already guarantee integrity -- an SCTP data channel
 * checksums every chunk, and the relay runs over TLS -- so this is not
 * defending against the wire. It is defending against the consequence of being
 * wrong about that, which is unusually bad here: received input only ever FILLS
 * GAPS and never overwrites, so a corrupt packet that happens to pass the shape
 * checks writes a wrong value into the input log permanently, and the real
 * value that arrives afterwards is ignored as already known. The peers then
 * disagree forever about a frame neither can revisit.
 *
 * Two bytes to make that impossible rather than merely unlikely. It takes a
 * range rather than a length because the trailer is checksummed on its own --
 * see the note at the top of this file.
 */
function fletcher16(data: Uint8Array, start: number, end: number): number {
  let a = 0;
  let b = 0;
  for (let i = start; i < end; i++) {
    a = (a + data[i]) % 255;
    b = (b + a) % 255;
  }
  return (b << 8) | a;
}

/**
 * Returns null for anything malformed, rather than throwing at a peer.
 *
 * "Malformed" has to include values that are the right SHAPE but impossible,
 * not just packets that are too short. A corrupted byte gave one test a packet
 * claiming to be from slot 200; the session indexed `input[200]`, found
 * undefined, and crashed mid-game. A parser that only checks lengths is a
 * parser that trusts whatever survived the wire.
 *
 * The trailer fails SOFT and the body fails hard, which is the whole reason
 * they have separate checksums: a damaged trailer costs the pair a clock
 * sample, and a damaged body could cost them the level.
 */
export function decode(data: Uint8Array): Packet | null {
  if (data.length < 1) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data[0] === Kind.Input) {
    if (data.length < 18) return null;
    const n = data[15];
    if (data.length < 18 + n || n > BODY_HISTORY) return null;
    if (fletcher16(data, 0, 16 + n) !== (data[16 + n] | (data[17 + n] << 8))) {
      return null;
    }
    if (data[1] > 1) return null;                    // no such player
    const frame = view.getUint32(2);
    const hashFrame = view.getUint32(6);
    if (frame > MAX_FRAME || hashFrame > MAX_FRAME) return null;
    const bits: number[] = [];
    for (let i = 0; i < n; i++) bits.push(data[16 + i] & 7);

    let timing: Timing | undefined;
    const b = 18 + n;
    // A trailer is only a trailer if it says so, is long enough to hold what it
    // claims, and checksums. Anything else is a shorter packet with rubbish on
    // the end, and the body above is still perfectly good.
    if (data.length >= b + TRAILER_FIXED && data[b] === TRAILER_MAGIC) {
      const m = data[b + 12];
      if (m <= EXTRA_HISTORY && data.length >= b + TRAILER_FIXED + m &&
          fletcher16(data, b, b + 13 + m) ===
            (data[b + 13 + m] | (data[b + 14 + m] << 8))) {
        timing = {
          // Back to signed: the byte holds two's complement.
          advantage: clamp((data[b + 1] << 24) >> 24, -MAX_ADVANTAGE, MAX_ADVANTAGE),
          sent: view.getUint32(b + 2),
          echo: view.getUint32(b + 6),
          held: view.getUint16(b + 10),
        };
        for (let i = 0; i < m; i++) bits.push(data[b + 13 + i] & 7);
      }
    }

    return {
      kind: Kind.Input,
      slot: data[1],
      epoch: data[14],
      frame,
      hashFrame,
      hash: view.getUint32(10),
      bits,
      ...(timing ? { timing } : {}),
    };
  }
  if (data[0] === Kind.Command) {
    if (data.length < 12) return null;
    if (fletcher16(data, 0, 10) !== (data[10] | (data[11] << 8))) return null;
    if (data[1] > 1) return null;                    // no such player
    const frame = view.getUint32(2);
    if (frame > MAX_FRAME) return null;
    // A command outside the four that exist would fall through every case and
    // do nothing, which is survivable -- but a packet claiming one is damaged,
    // and the honest answer to damaged is to drop it.
    if (data[6] < Command.Start || data[6] > Command.Quit) return null;
    return {
      kind: Kind.Command,
      slot: data[1],
      epoch: data[9],
      frame,
      command: data[6],
      a: data[7],
      b: data[8],
    };
  }
  return null;
}
