/** Selected-friend priority and playable-ready barriers without live services. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const ice = deferred();
const fixture = { pending: new Map(), channels: new Map(), opens: [], replies: [], ice: ice.promise,
  friends: Array.from({ length: 50 }, (_, i) => ({ id: `f${i}`, username: `friend${i}`, status: "accepted" })) };
globalThis.__lobbyFixture = fixture;
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.location = { search: "" };
const mocks = {
  auth: 'export const auth = () => ({ user: { id: "me" }, profile: { username: "mine" } }); export const onAuth = () => {}; export const onBeforeSignOut = () => {};',
  friends: 'export const listFriends = async () => globalThis.__lobbyFixture.friends;',
  ice: 'export const runtimeIceServers = () => globalThis.__lobbyFixture.ice;',
  connect: 'export const connect = async (transport) => ({ transport, kind: "relay" });',
  pair: `export class PairChannel {
    static open(id, me, signal) {
      const f = globalThis.__lobbyFixture; f.opens.push(id);
      const channel = new PairChannel(id); f.channels.set(id, channel);
      let resolve, reject; const work = new Promise((a,b) => { resolve=a; reject=b; });
      const aborted = () => { f.pending.delete(id); reject(new Error("closed")); };
      signal.addEventListener("abort", aborted, { once: true });
      f.pending.set(id, { resolve: () => { f.pending.delete(id); resolve(channel); }, reject });
      return work.finally(() => signal.removeEventListener("abort", aborted));
    }
    constructor(id) { this.id=id; this.closed=0; this.handlers=new Set(); this.statuses=new Set(); this.replies=new Set(); }
    onPresence() {} onInvite() {} onHandover() {} onSharing() {} onShowing() {} onResume() {} onCancel() {}
    onReply(fn) { this.replies.add(fn); }
    onStatus(fn) { this.statuses.add(fn); return () => this.statuses.delete(fn); }
    onBytes(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
    sendBytes() {} setActivity() {} invite() {} resume() {} cancel() {}
    reply(value) { globalThis.__lobbyFixture.replies.push(value); }
    async close() { this.closed++; this.handlers.clear(); this.statuses.clear(); }
  }`,
};
const bundle = await build({ stdin: { resolveDir: root, sourcefile: "lobby-preparation-entry.ts", contents: 'export { Lobby } from "./app/src/lobby.ts";' },
  bundle: true, write: false, platform: "node", format: "esm", alias: { "@engine": resolve(root, "engine/src") },
  define: { __ICE_SERVERS__: "null", __PATH_MANAGER__: "false", __LEGACY_RELAY_BATCHING__: "false", __ROLLBACK_SMOOTHING__: "false", __DESCENDANT_INTERPOLATION__: "false", "import.meta.env.DEV": "false" },
  plugins: [{ name: "local-lobby-fixture", setup(builder) {
    builder.onResolve({ filter: /(?:auth|friends|pairchannel|turn|connect)\.js$/ }, args => {
      const name = args.path.includes("pairchannel") ? "pair" : args.path.includes("turn.js") ? "ice" : args.path.split("/").at(-1).replace(".js", "");
      return { path: name, namespace: "lobby-mock" };
    });
    builder.onLoad({ filter: /.*/, namespace: "lobby-mock" }, args => ({ contents: mocks[args.path] }));
  } }] });
const { Lobby } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`)
  .catch(error => { throw new Error(error.message); });
const microtasks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const lobby = await Lobby.open();
try {
  await lobby.refresh(); await microtasks();
  assert.equal(lobby.list.length, 50);
  assert.equal(fixture.pending.size, 5, "background warmup consumed the selected-friend lane");
  const chosen = lobby.ensureChannel("f7"); await microtasks();
  assert.ok(fixture.pending.has("f7"), "selected friend waited behind unrelated fifteen-second joins");
  assert.equal(fixture.pending.size, 6, "join concurrency was not bounded");
  fixture.pending.get("f7").resolve(); const channel = await chosen;
  assert.equal(channel.id, "f7");
  const abort = new AbortController();
  const cancelled = lobby.ensureChannel("f8", abort.signal); await microtasks(); abort.abort();
  await assert.rejects(cancelled, /cancelled/);
  fixture.pending.get("f8").resolve(); await microtasks();
  assert.equal(lobby.list.find(f => f.id === "f8").connection, "connecting");
  assert.equal((await lobby.ensureChannel("f8")).id, "f8", "shared friendship subscription was orphaned after a consumer cancelled");

  const preparation = deferred();
  const joined = lobby.join({ session: "match", attempt: "attempt", from: "f7", fireboy: "me", mode: "adventure", num: 1 },
    { beforeReady: () => preparation.promise });
  await microtasks();
  assert.ok(fixture.replies.some(r => r.accepted && !r.ready), "acceptance waited on ICE or decorative preparation");
  assert.ok(!fixture.replies.some(r => r.ready));
  ice.resolve([]); await microtasks();
  assert.ok(!fixture.replies.some(r => r.ready), "ready published before pair/critical-art barrier");
  preparation.resolve(); const ready = await joined;
  assert.equal(fixture.replies.at(-1).ready, true);
  ready.transport.close();
} finally {
  await lobby.close();
  assert.equal(fixture.pending.size, 0, "lobby close leaked pending joins");
  for (const channel of fixture.channels.values()) assert.ok(channel.closed <= 1);
  delete globalThis.__lobbyFixture;
}
console.log("LOBBY PRIORITY / CANCELLATION / READY BARRIER PASSED");
