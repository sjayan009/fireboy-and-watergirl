// Local browser fixture; absent from the production build. No network account is used.
import "../src/ui/styles.css";
import { auth } from "../src/auth.js";
import { supabase } from "../src/supabase.js";
import { PairChannel } from "../src/net/pairchannel.js";
import { playScreen } from "../src/screens/play.js";

const side = new URLSearchParams(location.search).get("pair");
const owner = side === "right" ? "00000000-0000-4000-8000-000000000002" : "00000000-0000-4000-8000-000000000001";
const other = side === "right" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002";
const peers = Array.from({ length: side ? 1 : 50 }, (_, i) => ({ id: side ? other : `00000000-0000-4000-8000-${String(i + 2).padStart(12, "0")}`, username: i ? `Friend${i}` : "A_very_long_friend_name", status: "accepted", theirMove: false, ourMove: false, blockedByMe: false }));
const social = new URLSearchParams(location.search).has("social");
if (social) {
  peers.splice(4);
  peers[1] = { ...peers[1], username:"Incoming", status:"pending", ourMove:true };
  peers[2] = { ...peers[2], username:"Outgoing", status:"pending", theirMove:true };
  peers[3] = { ...peers[3], username:"Blocked", status:"blocked", blockedByMe:true };
}
const fixture = {
  peers, fail: "", calls: [] as string[], boardDelay: {} as Record<number,number>,
  board: [] as {rank:number; a_username:string; b_username:string; best_time_str:string; is_mine:boolean}[],
};
(window as any).socialFixture = fixture;
Object.assign(auth(), { stage: "in", user: { id: owner }, profile: { id: owner, username: "Temple explorer" }, session: null });
// Same response boundary as PostgREST, without contacting a real database.
const chain = (data: unknown) => new Proxy(Promise.resolve({ data, error: null }), {
  get(target, prop) { if (prop === "then") return target.then.bind(target); return () => chain(data); },
});
(supabase as any).from = (table: string) => chain(table === "friendships" ? peers.map(p => ({ user_a: owner, user_b: p.id, status: "accepted" })) : table === "profiles" ? peers : []);
(supabase as any).rpc = async (name: string, args: any = {}) => {
  fixture.calls.push(name);
  if (fixture.fail === name) return {data:null,error:{message:"Test connection interrupted"}};
  if (name === "list_friends") return {data:peers.map(p=>({...p})),error:null};
  if (name === "verified_leaderboard") {
    const data = fixture.board.map(r=>({...r, best_time_str: `${args.p_node}:00`}));
    await new Promise(resolve=>setTimeout(resolve,fixture.boardDelay[args.p_node] ?? 0));
    return {data,error:null};
  }
  const index = peers.findIndex(p => p.id === args.their_id);
  if (name === "remove_friend" && index >= 0) peers.splice(index,1);
  if (index >= 0 && ["accept_friend","block_friend","unblock_friend"].includes(name)) {
    peers[index] = {...peers[index], status:name === "block_friend" ? "blocked" : "accepted", blockedByMe:name === "block_friend",ourMove:false,theirMove:false};
  }
  if (name === "request_friend") {
    const existing = peers.find(p=>p.username.toLowerCase() === args.their_username.toLowerCase());
    if (existing?.ourMove) Object.assign(existing,{status:"accepted",ourMove:false,theirMove:false});
    else if (!existing) peers.push({id:`00000000-0000-4000-8000-${String(100+peers.length).padStart(12,"0")}`,username:args.their_username,status:"pending",ourMove:false,theirMove:true,blockedByMe:false});
  }
  return {data:[],error:null};
};
(PairChannel as any).open = (id: string) => {
  // Both endpoints run the real Lobby, GameView and batched transport. Only
  // the remote channel and account database are replaced by local fixtures.
  const bus = side ? new BroadcastChannel("fbwg-test-pair") : null;
  const handlers = new Map<string, Set<(data: any) => void>>();
  if (bus) bus.onmessage = ({ data }) => { for (const fn of handlers.get(data.event) ?? []) fn(data.value); };
  const send = (event: string, value: unknown) => bus?.postMessage({ event, value });
  return Promise.resolve(new Proxy({}, {
  get(_target, key) {
    if (key === "then") return undefined;
    if (key === "close") return () => { bus?.close(); return Promise.resolve(); };
    if (key === "onPresence") return (fn: any) => { fn([{ userId: id, username: "Friend", activity: "in_lobby" }]); return () => {}; };
    if (key === "onStatus") return (fn: any) => { fn("SUBSCRIBED"); return () => {}; };
    if (typeof key === "string" && key.startsWith("on")) return (fn: any) => {
      const event = key.slice(2).toLowerCase();
      const set = handlers.get(event) ?? new Set(); handlers.set(event,set); set.add(fn);
      return () => set.delete(fn);
    };
    if (key === "sendBytes") return (packets: string[]) => { for (const p of packets) send("bytes",Uint8Array.from(atob(p),c => c.charCodeAt(0))); };
    if (typeof key === "string") return (value: unknown) => send(key,value);
    return () => () => {};
  },
  }));
};
if (side) (window as any).RTCPeerConnection = undefined; // Exercise forced relay deterministically.
const fixtureHost = document.getElementById("app")!;
const screen = new URLSearchParams(location.search).get("screen");
if (screen === "watch") {
  void import("../src/screens/watch.js").then(({watchScreen}) => watchScreen(fixtureHost));
} else if (screen === "login" || screen === "signup") {
  void import("../src/screens/accounts.js").then(screens => (screen === "login" ? screens.loginScreen : screens.signUpScreen)(fixtureHost));
} else playScreen(fixtureHost);
