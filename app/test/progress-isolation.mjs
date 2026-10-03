/** Local service regressions. No live Supabase calls or credentials. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { LocalSave, MemorySave, normaliseSave, setSaveStore } from '../../engine/dist/game/save.js';
import { Game } from '../../engine/dist/game/game.js';
import { GameHost } from '../../engine/dist/net/gamehost.js';
import { GameView } from '../../engine/dist/embed.js';

const storage = new Map();
let rejectWrite = false, rejectRemember = false, owner = 'test-owner';
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => { if (rejectWrite) throw new Error('QuotaExceededError'); storage.set(key, value); },
  removeItem: key => storage.delete(key),
};
globalThis.addEventListener = globalThis.removeEventListener = () => {};
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
globalThis.cancelAnimationFrame = () => {};
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
let calls = [], replies = [], deferred = false, rpcError = null;
const supabase = {
  rpc(name, args) {
    calls.push({ name, args });
    return deferred ? new Promise(resolve => replies.push(resolve)) : Promise.resolve({ data: [], error: rpcError });
  },
  from() {
    const q = { select() { return q; }, eq() { return q; }, abortSignal() { return q; },
      then(resolve, reject) { return Promise.resolve({ data: [{ node: 3, medal: 2, best_time_s: 30, best_time_str: '00:30' }], error: null }).then(resolve, reject); } };
    return q;
  },
};
const mergeProgress = (a, b) => ({
  stats: Array.from({ length: 32 }, (_, i) => Math.max(a.stats[i] ?? -1, b.stats[i] ?? -1)),
  times: Array.from({ length: 32 }, (_, i) => { const valid = [a.times[i], b.times[i]].filter(t => t > 0); return valid.length ? Math.min(...valid) : 0; }),
  timesString: Array.from({ length: 32 }, (_, i) => b.times[i] > 0 && (!a.times[i] || b.times[i] < a.times[i]) ? b.timesString[i] : a.timesString[i] ?? ''),
});
const records = [];
globalThis.__progressTest = {
  supabase, LocalSave, normaliseSave, auth: () => ({ user: { id: owner } }),
  pendingFor: async () => records, acknowledge: async () => {}, deliveryFailed: async () => {}, retryDelivery: async () => {},
  remember: async (owner, friendId, data) => { if (rejectRemember) throw new Error('IndexedDB unavailable'); records.push({ ...data, owner, friendId }); }, mergeProgress,
};
async function load(path, bindings) {
  const source = (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^import .*;\r?$/gm, '');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(`const { ${bindings} } = globalThis.__progressTest;\n` + js).toString('base64')}`);
}
const { soloProgress } = await load('../src/solosave.ts', 'supabase, auth, LocalSave, normaliseSave, mergeProgress');
const { pairProgress } = await load('../src/pairsave.ts', 'supabase, auth, acknowledge, deliveryFailed, retryDelivery, mergeProgress, pendingFor, remember');

// Startup cloud completion cannot mutate an adopted pair or persist its results as solo.
deferred = true;
const solo = soloProgress(), pair = pairProgress(solo.store);
const sync = solo.sync();
await pair.adopt('friend');
assert.notEqual(pair.store.data, solo.store.data);
assert.notEqual(pair.store.data.stats, solo.store.data.stats);
pair.store.data.stats[2] = 3;
assert.equal(pair.current.stats[2], 2, 'progress panel reads confirmed canonical pair state');
pair.store.data.stats[2] = 2;
replies.shift()({ data: [{ node: 2, medal: 3, best_time_s: 20, best_time_str: '00:20' }], error: null });
await sync;
assert.equal(pair.store.data.stats[1], -1);
assert.equal(solo.store.data.stats[1], 3);
assert.equal(JSON.parse(storage.get('FBCookie:test-owner')).stats[2], -1);
deferred = false; calls = [];
await solo.sync();
assert.equal(calls[0].args.p_stats[2], -1, 'cleanup uploads canonical solo only');
await pair.release();
assert.equal(pair.store.data.stats[1], 3, 'release adopts fresh canonical cloud result');
pair.store.data.stats[4] = 2; pair.store.data.times[4] = 42;
pair.store.flush();
assert.equal(solo.store.data.stats[4], -1, 'engine flush cannot publish predicted progress');
pair.confirm(pair.store.data);
assert.equal(solo.store.data.stats[4], 2);
assert.equal(JSON.parse(storage.get('FBCookie:test-owner')).stats[4], 2, 'confirmed solo is immediately durable');
const unchangedRevision = solo.revision;
for (let i = 0; i < 100; i++) pair.confirm(pair.store.data);
assert.equal(solo.revision, unchangedRevision);
await solo.sync(); assert.equal(solo.pending, false);
pair.close(); solo.close();

// A new local revision during an in-flight RPC is sent again, not cleared by old acknowledgement.
storage.clear(); calls = []; replies = []; deferred = true;
const newer = soloProgress();
newer.store.data.stats[1] = 1; newer.store.data.times[1] = 50; newer.touched();
const inflight = newer.sync();
newer.store.data.stats[2] = 3; newer.store.data.times[2] = 40; newer.touched();
replies.shift()({ data: [], error: null });
for (let i = 0; i < 10; i++) await Promise.resolve();
assert.equal(calls.length, 2); assert.equal(newer.pending, true);
replies.shift()({ data: [], error: null }); await inflight;
assert.equal(newer.pending, false); newer.close();

// Failed destination writes retain both the original and earned in-memory progress.
storage.clear(); storage.set('FBCookie', JSON.stringify({ stats: [3], times: [20], timesString: ['00:20'] }));
rejectWrite = true;
const quota = soloProgress();
assert(storage.has('FBCookie'));
assert.equal(quota.store.data.stats[0], 3);
assert(quota.storageError);
quota.close(); rejectWrite = false;

// Closed/account-switched services cannot apply late replies to the current account.
storage.clear(); replies = []; deferred = true;
const stale = soloProgress(); const late = stale.sync(); stale.close(); owner = 'other-owner';
replies.shift()({ data: [{ node: 2, medal: 3, best_time_s: 20 }], error: null }); await late;
assert.equal(stale.store.data.stats[1], -1); owner = 'test-owner'; deferred = false;

// Cloud errors are observable and retry clears them only after acknowledgement.
rpcError = { message: 'offline' };
const offline = soloProgress(); let announcements = 0; offline.onChange(() => announcements++);
offline.store.data.stats[1] = 1; offline.store.data.times[1] = 20; offline.touched();
await offline.sync(); assert.equal(offline.pending, true); assert.equal(offline.lastError, 'offline');
rpcError = null; await offline.sync(); assert.equal(offline.pending, false); assert.equal(offline.lastError, null); assert(announcements > 2); offline.close();

// Exercise the installed SDK's header contract: an account switch before token capture cannot execute a query.
const originalRpc = supabase.rpc;
let executed = 0, authorization = '';
supabase.rpc = () => {
  const query = { setHeader(_name, value) { authorization = value; return query; }, abortSignal() { return query; },
    then(resolve, reject) { executed++; return Promise.resolve({ data: [], error: null }).then(resolve, reject); } };
  return query;
};
supabase.auth = { getSession: async () => ({ data: { session: { user: { id: owner }, access_token: 'fixture-token' } }, error: null }) };
const pinned = soloProgress(); await pinned.sync(); assert.equal(authorization, 'Bearer fixture-token'); pinned.close();
const guarded = soloProgress();
supabase.auth.getSession = async () => { owner = 'different-owner'; return { data: { session: { user: { id: owner }, access_token: 'different' } }, error: null }; };
const beforeSwitch = executed; await guarded.sync(); assert.equal(executed, beforeSwitch);
guarded.close(); owner = 'test-owner'; supabase.rpc = originalRpc;
supabase.auth.getSession = async () => ({ data: { session: { user: { id: owner }, access_token: 'fixture-token' } }, error: null });

// A failed local pair write is retried even if no more simulation frames confirm.
records.length = 0;
const retained = pairProgress(new MemorySave());
await retained.adopt('friend');
rejectRemember = true;
retained.store.data.stats[3] = 3; retained.store.data.times[3] = 40;
retained.confirm(retained.store.data);
for (let i = 0; i < 20; i++) await Promise.resolve();
assert.equal(retained.storageError, 'IndexedDB unavailable');
rejectRemember = false;
await retained.flushNow();
assert(records.some(p => p.friendId === 'friend' && p.stats[3] === 3));
assert.equal(retained.storageError, null);
retained.close(); records.length = 0;

// Actual solo stepping publishes once per completed authoritative step; disposal releases Stage ownership.
setSaveStore(() => new MemorySave());
const game = new Game(); new GameHost(game).start('adventure', 1);
let confirmed = 0;
const viewStub = { game, frame: 0, captureVisuals() {}, onConfirmed() { confirmed++; } };
for (let i = 0; i < 52; i++) GameView.prototype.step.call(viewStub);
assert.equal(confirmed, 52);
const stage = game.stage;
const count = () => [...stage.listeners.entries()].filter(([type]) => /key/i.test(type)).reduce((n, [, handlers]) => n + handlers.length, 0);
const before = count();
// A modal/background forced pause survives another command being in flight.
let acceptsPause = false, forcedPauses = 0;
const suspended = { suspensionPause: false, clearInput() {},
  session: { running: true, send(command, a) { assert.equal(command, 2); assert.equal(a, 1); forcedPauses++; return acceptsPause; } },
  pumpSuspensionPause() { GameView.prototype.pumpSuspensionPause.call(this); } };
GameView.prototype.pauseForSuspension.call(suspended);
assert.equal(suspended.suspensionPause, true);
acceptsPause = true; suspended.pumpSuspensionPause();
assert.equal(suspended.suspensionPause, false); suspended.pumpSuspensionPause(); assert.equal(forcedPauses, 2);
const destroyed = { destroyed: false, raf: 0, preparationGeneration: 0, listeners: [], game, audio: null, sprites: null, leave() {} };
GameView.prototype.destroy.call(destroyed); assert.equal(count(), before - 2);
GameView.prototype.destroy.call(destroyed); assert.equal(count(), before - 2);
const next = new Game(); new GameHost(next).start('adventure', 1); assert.equal(count(), before); next.dispose();
// Run the real authored finish sequence and remain on results while autosave acknowledges it.
storage.clear();
const completion = soloProgress(), completionProgress = pairProgress(completion.store);
setSaveStore(() => completionProgress.store);
const finishedGame = new Game(); new GameHost(finishedGame).start('adventure', 1);
const finishedView = { game: finishedGame, frame: 0, captureVisuals() {}, onConfirmed(v) { completionProgress.confirm(v.game.The_cookie.data); } };
for (let i = 0; i < 52; i++) GameView.prototype.step.call(finishedView);
for (let i = 0; i < 140; i++) {
  finishedGame.m_level.myContactListener.finish1 = 1; finishedGame.m_level.myContactListener.finish2 = 1;
  GameView.prototype.step.call(finishedView);
}
for (let i = 0; i < 45; i++) GameView.prototype.step.call(finishedView);
assert(finishedGame.children.some(c => c.symbol === 'Recuento'));
assert(completion.store.data.stats[0] > 0);
assert(JSON.parse(storage.get('FBCookie:test-owner')).stats[0] > 0);
await completion.sync(); assert.equal(completion.pending, false);
finishedGame.dispose(); completionProgress.close(); completion.close(); setSaveStore(null);
console.log('Progress isolation, autosave, stale acknowledgements, migration and lifecycle regressions passed');
