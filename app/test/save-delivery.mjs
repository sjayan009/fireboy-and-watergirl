/** Failure-isolated delivery with a virtual deadline clock; no real requests. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
let at = 0, serial = 0, owner = 'owner';
const jobs = new Map();
const savedTimers = [globalThis.setTimeout, globalThis.clearTimeout, Date.now];
globalThis.setTimeout = (fn, ms) => { jobs.set(++serial, { at: at + ms, fn }); return serial; };
globalThis.clearTimeout = id => jobs.delete(id);
Date.now = () => at;
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function advance(ms) {
  const target = at + ms;
  for (;;) {
    await flush();
    const next = [...jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    at = next[1].at; jobs.delete(next[0]); next[1].fn();
  }
  at = target; await flush();
}
let records = [], sent = [], authSwitch = false, hold;
const response = status => ({ ok: status === 200, status, headers: { get() { return null; } } });
globalThis.fetch = async (_url, options) => {
  const p = JSON.parse(options.body); sent.push(p.their_id);
  if (p.their_id === 'refused') return response(403);
  if (p.their_id.startsWith('hung')) return new Promise(() => {});
  if (p.their_id === 'newer') return new Promise(resolve => { hold = () => resolve(response(200)); });
  return response(200);
};
const supabase = { auth: { getSession: async () => {
  if (authSwitch) owner = 'different';
  return { data: { session: { user: { id: 'owner' }, access_token: 'fixture' } } };
} } };
globalThis.__delivery = {
  supabase, auth: () => ({ user: { id: owner } }),
  pendingFor: async wanted => records.filter(p => p.owner === wanted),
  acknowledge: async p => { records = records.filter(current => !(current.key === p.key && current.revision === p.revision)); },
  deliveryFailed: async (p, error, quarantine, retryAt) => {
    const current = records.find(r => r.key === p.key && r.revision === p.revision);
    if (current) Object.assign(current, { error, quarantine, retryAt, attempts: (current.attempts ?? 0) + 1 });
  }, retryDelivery: async () => {}, mergeProgress: () => {}, remember: async () => {},
};
globalThis.__SUPABASE_URL__ = 'https://fixture.invalid'; globalThis.__SUPABASE_KEY__ = 'fixture';
// The client is imported lazily inside pairsave.ts; point that at the fixture too.
const source = (await readFile(new URL('../src/pairsave.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?$/gm, '')
  .replaceAll('await import("./supabase.js")', 'globalThis.__delivery');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { drainOutbox, pairProgress } = await import(`data:text/javascript;base64,${Buffer.from('const { supabase, auth, pendingFor, acknowledge, deliveryFailed, retryDelivery, mergeProgress, remember } = globalThis.__delivery;\n' + js).toString('base64')}`);
const pending = friendId => ({ key: friendId, owner: 'owner', friendId, revision: 'r1', at: 0, stats: [], times: [], timesString: [] });
try {
  records = ['refused', 'hung', 'healthy'].map(pending);
  const mixed = drainOutbox(); await flush(); await advance(8001);
  assert.equal(await mixed, 1);
  assert.deepEqual(sent.sort(), ['healthy', 'hung', 'refused']);
  assert.equal(records.length, 2);
  assert.equal(records.find(p => p.friendId === 'refused').quarantine, true);
  assert(records.find(p => p.friendId === 'hung').retryAt > at);
  records = Array.from({ length: 5 }, (_, i) => pending(`hung${i}`)); sent = [];
  const bounded = drainOutbox(); await flush(); await advance(18001);
  assert.equal(await bounded, 0); assert.equal(records.length, 5);
  assert.equal(jobs.size, 0, 'drain extends a request beyond its overall time budget');
  records = [pending('newer')]; sent = [];
  const newer = drainOutbox(); await flush();
  records[0] = { ...records[0], revision: 'r2', stats: [3] };
  hold(); await newer;
  assert.equal(records[0].revision, 'r2', 'older success cannot erase newer revision');
  records = [pending('wrong-owner')]; sent = []; authSwitch = true;
  await drainOutbox(); assert.equal(sent.length, 0, 'account change before post never transmits');
  assert.equal(records.length, 1); authSwitch = false; owner = 'owner';
  navigator.locks = { request: async (_name, options, fn) => { assert.equal(options.ifAvailable, true); return fn(null); } };
  assert.equal(await drainOutbox(), 0); assert.equal(sent.length, 0, 'busy cross-tab lock never starts another drain');
  // A hanging selected-pair query cannot hold readiness forever, even if fetch ignores abort.
  globalThis.addEventListener = globalThis.removeEventListener = () => {};
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  supabase.from = () => {
    const query = { select() { return query; }, eq() { return query; }, abortSignal() { return query; },
      then() { return new Promise(() => {}); } };
    return query;
  };
  const projection = pairProgress({ data: { stats: [0], times: [0], timesString: [''] }, flush() {} });
  const waiting = assert.rejects(projection.adopt('friend'), /timed out/);
  await advance(12001); await waiting; assert.equal(projection.shared, false);
  const cancelled = new AbortController();
  const cancellation = assert.rejects(projection.adopt('friend', cancelled.signal), /abort/i);
  cancelled.abort(); await cancellation; projection.close(); assert.equal(jobs.size, 0);
  console.log('Mixed failures, hung requests, revision acknowledgement, ownership and cross-tab contention passed');
} finally {
  [globalThis.setTimeout, globalThis.clearTimeout, Date.now] = savedTimers;
}
