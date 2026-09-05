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
Object.assign(auth(), { stage: "in", user: { id: owner }, profile: { id: owner, username: "Temple explorer" }, session: null });
// Same response boundary as PostgREST, without contacting a real database.
const chain = (data: unknown) => new Proxy(Promise.resolve({ data, error: null }), {
  get(target, prop) { if (prop === "then") return target.then.bind(target); return () => chain(data); },
});
(supabase as any).from = (table: string) => chain(table === "friendships" ? peers.map(p => ({ user_a: owner, user_b: p.id, status: "accepted" })) : table === "profiles" ? peers : []);
(supabase as any).rpc = (name: string) => chain(name === "list_friends" ? peers : []);
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
playScreen(document.getElementById("app")!);
