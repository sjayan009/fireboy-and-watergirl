import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { encodeInput, encodeCommand, decode } from '../engine/dist/net/protocol.js';
import { replay } from '../engine/dist/netlink.js';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64')}`;
const base64 = moduleUrl(await readFile(new URL('../app/src/net/base64.ts', import.meta.url), 'utf8'));
const source = (await readFile(new URL('../app/src/net/realtime.ts', import.meta.url), 'utf8'))
  .replace('from "./base64.js"', `from ${JSON.stringify(base64)}`)
  .replaceAll(/from "@engine\/(.+?)"/g, (_, path) => `from ${JSON.stringify(new URL(`../engine/dist/${path}`, import.meta.url).href)}`);
const { RealtimeTransport } = await import(moduleUrl(source));
let now = 10000, next = 0;
const timers = new Map();
const saved = { now: Date.now, set: globalThis.setTimeout, clear: globalThis.clearTimeout };
Date.now = () => now;
globalThis.setTimeout = (fn, delay) => { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
function advance(ms) {
  const end = now + ms;
  for (;;) {
    const event = [...timers].sort((a,b) => a[1].at-b[1].at)[0];
    if (!event || event[1].at > end) break;
    timers.delete(event[0]); now = event[1].at; event[1].fn();
  }
  now = end;
}
const packet = (frame, bits, epoch = 0) => encodeInput({ kind:1, slot:0, epoch, frame, bits,
  hash:0, hashFrame:0, timing:{ sent:now, echo:0, held:0, advantage:0 } });
const make = options => {
  const messages = [];
  const tr = new RealtimeTransport({ onBytes:() => () => {}, onStatus:() => () => {},
    sendBytes(packets) { messages.push({ at:now, packets:packets.map(p => new Uint8Array(Buffer.from(p,'base64'))) }); },
  }, { now:() => now, ...options });
  return { tr, messages };
};
try {
  const { tr, messages } = make();
  tr.send(packet(0,[0]));
  advance(10); tr.send(packet(1,[2,0]));
  assert.equal(messages.at(-1).at, now, 'key down waits');
  advance(10); tr.send(packet(2,[0,2,0]));
  assert.equal(messages.at(-1).at, now, 'key up waits');
  const edgeAt = now, count = messages.length;
  for(let f=3; f<=5; f++) { advance(30); tr.send(packet(f,Array(f+1).fill(0))); }
  assert.equal(messages.length, count);
  advance(25);
  assert.equal(messages.length, count+1);
  assert.equal(messages.at(-1).at-edgeAt, 115, 'hold deadline moved');
  assert.equal(messages.at(-1).packets.length, 1, 'hold retained old packets');
  assert.equal(decode(messages.at(-1).packets[0]).frame, 5);
  advance(5); tr.send(packet(0,[0],1));
  assert.equal(messages.at(-1).at,now, 'epoch boundary waits');
  advance(5); tr.send(encodeCommand({kind:2,slot:0,epoch:1,frame:0,command:2,a:0,b:0}));
  assert.equal(decode(messages.at(-1).packets[0]).kind,2,'command waits');
  advance(5); tr.send(packet(1,[0,0],1));
  tr.discardPending(); const discarded = messages.length; advance(200);
  assert.equal(messages.length,discarded,'promotion leaked a heartbeat');
  tr.close(); assert.equal(timers.size,0);

  const uncoalesced = make();
  uncoalesced.tr.send(packet(100, Array(32).fill(0)));
  uncoalesced.tr.sendUncoalesced([packet(60, Array(32).fill(0)),
    packet(80, Array(32).fill(0)), packet(100, Array(32).fill(0))]);
  assert.deepEqual(uncoalesced.messages.at(-1).packets.map(bytes => decode(bytes).frame),
    [60, 80, 100], 'recovery coalesced away the missing older history');
  uncoalesced.tr.close();

  const legacy = make({legacyBatching:true});
  legacy.tr.send(packet(0,[0])); advance(10); legacy.tr.send(packet(1,[2,0]));
  assert.equal(legacy.messages.length,1,'rollback switch no longer batches');
  advance(220); assert.equal(legacy.messages.length,2); legacy.tr.close();

  // The exact full replay survives coalescing and loss of every fifth publish.
  const recovery = make(), frames = 600;
  const inputs = Array.from({length:frames}, (_,f) => Math.floor(f/17)%3 === 0 ? 2 : Math.floor(f/17)%3 === 1 ? 1 : 0);
  for(let f=0; f<frames; f++) {
    recovery.tr.send(packet(f,inputs.slice(Math.max(0,f-31),f+1).reverse()));
    advance(1000/26);
  }
  recovery.tr.close();
  const received = Array(frames);
  recovery.messages.forEach((message,i) => {
    if(i%5 === 2 && i < recovery.messages.length-2) return;
    for(const bytes of message.packets) {
      const p = decode(bytes);
      p.bits.forEach((bit,j) => { if(p.frame-j>=0) received[p.frame-j]=bit; });
    }
  });
  assert.deepEqual(received,inputs,'redundancy failed to reconstruct skipped/lost logical frames');
  const original = replay('adventure',1,inputs.map(bit => [bit,0])).hash();
  const healed = replay('adventure',1,received.map(bit => [bit,0])).hash();
  assert.equal(healed,original);
  console.log(`RELAY EDGES PASSED: down/up/epoch/command immediate, hold 115ms, packet-loss replay hash ${healed}`);
} finally { Date.now=saved.now; globalThis.setTimeout=saved.set; globalThis.clearTimeout=saved.clear; }
