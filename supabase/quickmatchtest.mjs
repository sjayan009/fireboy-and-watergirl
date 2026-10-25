/**
 * Quick Match, proved with real accounts the way the browser uses it.
 *
 * Local only unless `FBWG_QUICKMATCH_LIVE=1`. The queue is shared by everybody
 * on a project, so against production a test account could be handed to a
 * real player who happened to be searching at that moment.
 */
import { env, open } from "./connect.mjs";
import { sweepStaleTestUsers } from "./sweep.mjs";

const e = env();
const URL_ = e.SUPABASE_URL;
const PUB = e.SUPABASE_PUBLISHABLE_KEY;
const SECRET = e.SUPABASE_SECRET_KEY;

if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL_) && process.env.FBWG_QUICKMATCH_LIVE !== "1") {
  console.log("quickmatch: skipped -- not a local stack (set FBWG_QUICKMATCH_LIVE=1 to run anyway)");
  process.exit(0);
}

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

const admin = (path, init = {}) => fetch(`${URL_}${path}`, {
  ...init,
  headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "content-type": "application/json", ...(init.headers ?? {}) },
});

async function api(user, path, init = {}) {
  const r = await fetch(`${URL_}/rest/v1${path}`, {
    ...init,
    headers: { apikey: PUB, Authorization: `Bearer ${user.token}`, "content-type": "application/json",
               Prefer: "return=representation", ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}
const rpc = (user, fn, args = {}) => api(user, `/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

const stamp = Date.now();
await sweepStaleTestUsers("quickmatch", "fbwg_qm_");
const users = [];

async function makeUser(tag) {
  const email = `fbwg_qm_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_${tag}!A`;
  const cu = await (await admin("/auth/v1/admin/users", {
    method: "POST", body: JSON.stringify({ email, password, email_confirm: true }),
  })).json();
  if (!cu.id) throw new Error("could not create a user: " + JSON.stringify(cu));
  const s = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: SECRET, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })).json();
  if (!s.access_token) throw new Error("could not sign in: " + JSON.stringify(s));
  const u = { id: cu.id, token: s.access_token, tag, name: `qm${tag}${stamp % 100000}` };
  users.push(u);
  const claimed = await rpc(u, "claim_username", { new_username: u.name });
  if (claimed.body?.username !== u.name) throw new Error("could not claim a name: " + JSON.stringify(claimed));
  return u;
}

const find = async (u, role = "either") => (await rpc(u, "quick_match_find", { p_role: role })).body?.[0] ?? null;
const row = async (db, a, b) => (await db.query(
  "select status, channel, match_request, match_block from public.friendships where user_a = least($1::uuid,$2::uuid) and user_b = greatest($1::uuid,$2::uuid)",
  [a.id, b.id])).rows[0] ?? null;
const map = (them, node, secs) => {
  const stats = new Array(32).fill(-1), times = new Array(32).fill(0), strs = new Array(32).fill("");
  stats[node - 1] = 3; times[node - 1] = secs;
  return { their_id: them.id, p_stats: stats, p_times: times, p_times_str: strs };
};

const db = await open({ quiet: true });
try {
  // Nobody else may be in the local queue for these to mean anything.
  await db.query("delete from play_private.quick_queue");
  const [alice, bob, carol, dave, erin] = await Promise.all(["alice", "bob", "carol", "dave", "erin"].map(makeUser));

  console.log("\nfinding each other");
  check("the first to search waits", await find(alice), null);
  const forBob = await find(bob);
  check("the second is matched with the first", forBob?.partner, alice.id);
  check("and is the one who hosts", forBob?.host, bob.id);
  const forAlice = await find(alice);
  check("the first hears about it on the next poll", forAlice?.partner, bob.id);
  check("both are given the same topic", forAlice?.topic, forBob?.topic);
  check("and agree who is Fireboy", forAlice?.fireboy, forBob?.fireboy);
  check("the row is a live match", (await row(db, alice, bob))?.status, "matched");

  console.log("\nwhat a match opens, and what it does not");
  const topic = forBob.topic;
  const canUse = async (u) => (await rpc(u, "can_use_pair_topic", { topic })).body;
  check("alice may use the topic", await canUse(alice), true);
  check("carol may not", await canUse(carol), false);
  const names = (r) => (r.body ?? []).map(f => f.id);
  check("a match is not a friend", names(await rpc(alice, "list_friends")).includes(bob.id), false);
  check("they can share a save", (await rpc(alice, "sync_progress", map(bob, 1, 40))).status, 200);
  check("both can read it", (await api(bob, `/pair_progress?select=node&user_a=eq.${[alice.id, bob.id].sort()[0]}`)).body?.length, 1);
  check("a third account cannot", (await api(carol, `/pair_progress?select=node&user_a=eq.${[alice.id, bob.id].sort()[0]}`)).body?.length, 0);
  check("nobody can watch it", (await rpc(alice, "match_consent", { p_match: crypto.randomUUID(), their_id: bob.id, p_on: true })).status >= 400, true);
  check("strangers already matched are not matched again", await find(carol), null);
  await rpc(carol, "quick_match_leave");

  console.log("\nbecoming friends mid-match");
  const one = await rpc(alice, "request_friend", { their_username: bob.name });
  check("one request keeps the match", one.body?.status, "matched");
  const before = (await row(db, alice, bob)).channel;
  const both = await rpc(bob, "request_friend", { their_username: alice.name });
  check("both asking is a friendship", both.body?.status, "accepted");
  check("and the game keeps its topic", (await row(db, alice, bob)).channel, before);
  check("the save is still theirs", (await api(alice, `/pair_progress?select=node&user_a=eq.${[alice.id, bob.id].sort()[0]}`)).body?.length, 1);
  await rpc(alice, "quick_match_end", { their_id: bob.id });
  check("ending a match that became a friendship changes nothing", (await row(db, alice, bob)).status, "accepted");

  console.log("\nfriends, last");
  // Two Fireboys waiting cannot take each other, so both are still there when
  // bob arrives -- alice, his friend, waiting longest.
  check("alice waits", await find(alice, "fireboy"), null);
  check("carol waits too", await find(carol, "fireboy"), null);
  const bc = await find(bob, "watergirl");
  check("bob gets the stranger, not his friend who has waited longer", bc?.partner, carol.id);
  check("and she is not marked a friend", bc?.friend, false);
  await rpc(bob, "quick_match_end", { their_id: carol.id });
  await find(carol); await rpc(carol, "quick_match_leave");
  const ab = await find(bob, "watergirl");
  check("with no stranger left, he gets his friend", ab?.partner, alice.id);
  check("marked as a friend", ab?.friend, true);
  check("on the topic they already share", ab?.topic, "pair:" + (await row(db, alice, bob)).channel);
  check("the row stays a friendship", (await row(db, alice, bob)).status, "accepted");
  const ba = await find(alice, "fireboy");
  check("alice hears about it too", [ba?.partner, ba?.friend, ba?.topic], [bob.id, true, ab?.topic]);
  check("a friend's heartbeat is always live", (await rpc(alice, "quick_match_touch", { their_id: bob.id })).body, true);
  await rpc(alice, "quick_match_end", { their_id: bob.id });
  check("and ending it leaves them friends", (await row(db, alice, bob)).status, "accepted");
  await rpc(alice, "quick_match_leave"); await rpc(bob, "quick_match_leave");

  console.log("\na match that ends");
  await find(dave, "fireboy");
  check("two Fireboys are not matched", await find(erin, "fireboy"), null);
  const de = await find(erin, "watergirl");
  check("a Watergirl is", de?.partner, dave.id);
  check("and the roles are what they asked for", de?.fireboy, dave.id);
  await find(dave);
  check("dave saves a time", (await rpc(dave, "sync_progress", map(erin, 2, 50))).status, 200);
  check("erin saves hers", (await rpc(erin, "sync_progress", map(dave, 2, 55))).status, 200);
  check("a heartbeat keeps it live", (await rpc(dave, "quick_match_touch", { their_id: erin.id })).body, true);
  await rpc(dave, "quick_match_end", { their_id: erin.id });
  check("leaving ends it", (await row(db, dave, erin)).status, "ended");
  check("the heartbeat says so", (await rpc(erin, "quick_match_touch", { their_id: dave.id })).body, false);
  check("the save is closed to them", (await api(dave, `/pair_progress?select=node&user_a=eq.${[dave.id, erin.id].sort()[0]}`)).body?.length, 0);
  check("writing to it is refused", (await rpc(dave, "sync_progress", map(erin, 3, 60))).status >= 400, true);
  const board = await rpc(carol, "leaderboard", { p_node: 2 });
  check("their time stays on the board", (board.body ?? []).some(r => [r.a_username, r.b_username].sort().join() === [dave.name, erin.name].sort().join()), true);

  console.log("\nblocking a stranger");
  check("erin blocks dave after the match", (await rpc(erin, "block_friend", { their_id: dave.id })).body?.status, "blocked");
  check("he is listed under her blocks", (await rpc(erin, "list_friends")).body?.find(f => f.id === dave.id)?.blockedByMe, true);
  await find(dave);
  check("and they are never matched again", await find(erin), null);
  await rpc(dave, "quick_match_leave"); await rpc(erin, "quick_match_leave");
  check("lifting it makes them strangers, not friends", (await rpc(erin, "unblock_friend", { their_id: dave.id })).body?.status, "ended");

  console.log("\na match nobody renews");
  await find(carol);
  const cd = await find(dave);
  check("carol and dave are matched", cd?.partner, carol.id);
  await rpc(carol, "request_friend", { their_username: dave.name });
  await db.query("update public.friendships set match_until = now() - interval '1 second' where user_a = least($1::uuid,$2::uuid) and user_b = greatest($1::uuid,$2::uuid)", [carol.id, dave.id]);
  await find(alice); await rpc(alice, "quick_match_leave");
  const lapsed = await row(db, carol, dave);
  check("it lapses, and the one request carried over stays pending", lapsed?.status, "pending");
  check("from the person who made it", (await rpc(dave, "list_friends")).body?.find(f => f.id === carol.id)?.ourMove, true);

  console.log("\nleaving the queue");
  await find(erin);
  await rpc(erin, "quick_match_leave");
  check("someone who left is not found", await find(alice), null);
  await rpc(alice, "quick_match_leave");
  check("a role must be one of the three", (await rpc(alice, "quick_match_find", { p_role: "both" })).status >= 400, true);
} finally {
  await db.query("delete from play_private.quick_queue").catch(() => {});
  await db.end();
  for (const u of users) await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  console.log(`\ncleaned up ${users.length} test users`);
}

console.log("\n" + (failures === 0 ? "QUICKMATCH PASSED" : `QUICKMATCH FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
