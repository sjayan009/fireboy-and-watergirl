/** Read-only, local audit reproductions. No credentials or live services. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { LocalSave, MemorySave, setSaveStore } from '../engine/dist/game/save.js';
import { Game } from '../engine/dist/game/game.js';
import { GameHost } from '../engine/dist/net/gamehost.js';
import { GameView } from '../engine/dist/embed.js';

const storage = new Map();
let rejectWrite = false;
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => { if (rejectWrite) throw new Error('QuotaExceededError'); storage.set(key, value); },
  removeItem: key => storage.delete(key),
};
globalThis.addEventListener = globalThis.removeEventListener = () => {};
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
globalThis.cancelAnimationFrame = () => {};
const owner = 'audit-owner', friend = 'audit-friend';
let rpcCalls = [];
let resolveRpc;
let deferred = false;
const supabase = {
  rpc(name, args) {
    rpcCalls.push({ name, args });
    return deferred ? new Promise(resolve => { resolveRpc = resolve; }) : Promise.resolve({ data: [], error: null });
  },
  from() {
    const q = { select() { return q; }, eq() { return q; },
      then(resolve, reject) { return Promise.resolve({ data: [{ node: 3, medal: 2, best_time_s: 30, best_time_str: '00:30' }], error: null }).then(resolve, reject); } };
    return q;
  },
};
globalThis.__deepAudit = {
  supabase, LocalSave, auth: () => ({ user: { id: owner } }),
  pendingFor: async () => [], acknowledge: async () => {}, remember: async () => {}, mergeProgress: p => p,
};
async function loadAppSource(path, bindings) {
  const source = (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^import .*;\r?$/gm, '');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const injected = `const { ${bindings} } = globalThis.__deepAudit;\n` + js;
  return import(`data:text/javascript;base64,${Buffer.from(injected).toString('base64')}`);
}
const { soloProgress } = await loadAppSource('../app/src/solosave.ts', 'supabase, auth, LocalSave');
const { pairProgress } = await loadAppSource('../app/src/pairsave.ts', 'supabase, auth, acknowledge, mergeProgress, pendingFor, remember');
const findings = {};

// A response to the startup solo sync arrives after the pair map was adopted.
deferred = true;
const solo = soloProgress();
const pendingSync = solo.sync();
const pair = pairProgress(solo.store);
await pair.adopt(friend);
assert.equal(pair.store.data.stats[1], -1);
resolveRpc({ data: [{ node: 2, medal: 3, best_time_s: 20, best_time_str: '00:20' }], error: null });
await pendingSync;
assert.equal(pair.store.data.stats[1], 3);
const persisted = JSON.parse(storage.get('FBCookie:' + owner));
assert.equal(persisted.stats[2], 2);
findings.lateSoloResponse = { pairGainedSoloNode2: pair.store.data.stats[1], soloLocalSaveContainsPairNode3: persisted.stats[2] };

// The route cleanup sends solo.sync() before progress.release().
deferred = false;
rpcCalls = [];
await solo.sync();
assert.equal(rpcCalls[0].args.p_stats[2], 2);
findings.cleanupSync = { uploadedPairNode3ToSoloRpc: rpcCalls[0].args.p_stats[2] };
await pair.release(); pair.close(); solo.close();

// Legacy migration removes the only old copy before a potentially failing write.
storage.clear();
const legacy = JSON.stringify({ stats: [3], times: [20], timesString: ['00:20'] });
storage.set('FBCookie', legacy);
rejectWrite = true;
const quotaSolo = soloProgress();
assert.equal(storage.has('FBCookie'), false);
assert.equal(storage.has('FBCookie:' + owner), false);
assert.equal(quotaSolo.store.data.stats[0], 0);
findings.legacyQuota = { legacyCopyRemains: false, accountCopyExists: false, medalRecoveredInMemory: quotaSolo.store.data.stats[0] };
quotaSolo.close(); rejectWrite = false;

// Exercise the actual solo stepping method, with real game and fake visual capture.
setSaveStore(() => new MemorySave());
const game = new Game();
new GameHost(game).start('adventure', 1);
let confirmed = 0;
const viewStub = { game, frame: 0, captureVisuals() {}, onConfirmed() { confirmed++; } };
for (let i = 0; i < 52; i++) GameView.prototype.step.call(viewStub);
assert.equal(confirmed, 0);
findings.soloConfirmation = { simulatedFrames: viewStub.frame, confirmationCallbacks: confirmed };

// destroy() releases DOM listeners/audio, but not Game's singleton Stage handlers.
const stage = game.stage;
const keyboardListeners = () => [...stage.listeners.entries()].filter(([type]) => /key/i.test(type)).reduce((n, [, handlers]) => n + handlers.length, 0);
const beforeDestroy = keyboardListeners();
GameView.prototype.destroy.call({ destroyed: false, raf: 0, listeners: [], game, audio: null, sprites: null });
const afterDestroy = keyboardListeners();
assert.equal(afterDestroy, beforeDestroy);
assert(beforeDestroy >= 2);
const nextGame = new Game();
new GameHost(nextGame).start('adventure', 1);
assert.equal(keyboardListeners(), afterDestroy + 2);
findings.stageLifecycle = { beforeDestroy, afterDestroy, afterNextLevelStarted: keyboardListeners() };
// Leave this test process tidy, without altering any application implementation.
game.EndGame(); nextGame.EndGame();

await writeFile(new URL('deep-audit-20261002-checks.json', import.meta.url), JSON.stringify(findings, null, 2) + '\n');
console.log(JSON.stringify(findings, null, 2));
