/**
 * The wire format. Two packet kinds, both tiny.
 *
 * A player's whole input is THREE BITS per frame -- left, right, up -- so an
 * input packet carrying a 16-frame window still fits in 34 bytes, and a
 * session costs about 700 bytes a second including the redundancy. That budget
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
 */

export const enum Kind {
  Input = 1,
  Command = 2,
}

/** How many frames of history every input packet repeats. */
export const HISTORY = 16;

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

export function encodeInput(p: InputPacket): Uint8Array {
  const n = Math.min(p.bits.length, HISTORY);
  const out = new Uint8Array(16 + n + 2);
  const view = new DataView(out.buffer);
  out[0] = Kind.Input;
  out[1] = p.slot;
  view.setUint32(2, p.frame);
  view.setUint32(6, p.hashFrame);
  view.setUint32(10, p.hash);
  out[14] = p.epoch & 0xff;
  out[15] = n;
  for (let i = 0; i < n; i++) out[16 + i] = p.bits[i] & 7;
  const ck = fletcher16(out, 16 + n);
  out[16 + n] = ck & 0xff;
  out[17 + n] = ck >>> 8;
  return out;
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
  const ck = fletcher16(out, 10);
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
 * Fletcher-16 over a packet, excluding the two bytes that hold it.
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
 * Two bytes to make that impossible rather than merely unlikely.
 */
function fletcher16(data: Uint8Array, len: number): number {
  let a = 0;
  let b = 0;
  for (let i = 0; i < len; i++) {
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
 */
export function decode(data: Uint8Array): Packet | null {
  if (data.length < 1) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data[0] === Kind.Input) {
    if (data.length < 18) return null;
    const n = data[15];
    if (data.length < 18 + n || n > HISTORY) return null;
    if (fletcher16(data, 16 + n) !== (data[16 + n] | (data[17 + n] << 8))) {
      return null;
    }
    if (data[1] > 1) return null;                    // no such player
    const frame = view.getUint32(2);
    const hashFrame = view.getUint32(6);
    if (frame > MAX_FRAME || hashFrame > MAX_FRAME) return null;
    const bits: number[] = [];
    for (let i = 0; i < n; i++) bits.push(data[16 + i] & 7);
    return {
      kind: Kind.Input,
      slot: data[1],
      epoch: data[14],
      frame,
      hashFrame,
      hash: view.getUint32(10),
      bits,
    };
  }
  if (data[0] === Kind.Command) {
    if (data.length < 12) return null;
    if (fletcher16(data, 10) !== (data[10] | (data[11] << 8))) return null;
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
