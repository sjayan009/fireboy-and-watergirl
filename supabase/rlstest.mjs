/**
 * Row level security, proved the way it will actually be used.
 *
 * Not pgTAP with `set role`: three real users, created through the admin API,
 * signed in for real JWTs, talking to PostgREST exactly as the browser will.
 * That covers the whole path -- policy, grant, function security and the
 * anon-key surface -- rather than just the policy predicate, and it is the
 * path an attacker would take.
 *
 * The users are created and deleted by this script, so it can run repeatedly
 * against the real project without leaving anything behind.
 */
import { env } from "./connect.mjs";

const e = env();
const URL_ = e.SUPABASE_URL;
const PUB = e.SUPABASE_PUBLISHABLE_KEY;
const SECRET = e.SUPABASE_SECRET_KEY;

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

const admin = (path, init = {}) => fetch(`${URL_}${path}`, {
  ...init,
  headers: {
    apikey: SECRET, Authorization: `Bearer ${SECRET}`,
    "content-type": "application/json", ...(init.headers ?? {}),
  },
});

/** A PostgREST call as a particular user. */
async function api(user, path, init = {}) {
  const r = await fetch(`${URL_}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: PUB,
      Authorization: `Bearer ${user.token}`,
      "content-type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}

const rpc = (user, fn, args) =>
  api(user, `/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

const stamp = Date.now();
const users = [];
const codes = [];

/**
 * Mint an invite code with the secret key.
 *
 * `invite_codes` has no RLS policies at all, so this is the only way one comes
 * into being -- which is the point, and is itself asserted below.
 */
async function makeCode(uses = 1) {
  const code = `TEST-${stamp % 100000}-${codes.length}AA`;
  const r = await admin("/rest/v1/invite_codes", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ code, max_uses: uses, note: "rlstest" }),
  });
  if (!r.ok) throw new Error("could not mint a code: " + (await r.text()));
  codes.push(code);
  return code;
}

async function makeUser(tag) {
  const email = `fbwg_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_${tag}!A`;
  const created = await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const cu = await created.json();
  if (!cu.id) throw new Error("could not create a user: " + JSON.stringify(cu));

  const signin = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUB, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const s = await signin.json();
  if (!s.access_token) throw new Error("could not sign in: " + JSON.stringify(s));
  const u = { id: cu.id, email, token: s.access_token, tag };
  users.push(u);
  return u;
}

try {
  console.log("three users, created and signed in for real");
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const mallory = await makeUser("mallory");
  check("all three have sessions",
        [alice, bob, mallory].every((u) => u.token.length > 20), true);

  console.log("\ninvite codes");
  const aliceCode = await makeCode();
  const bobCode = await makeCode();
  const malloryCode = await makeCode();

  const nogate = await rpc(alice, "claim_username", { new_username: `x${stamp % 100000}` });
  check("no profile without an invite code", nogate.status >= 400, true);

  const guess = await rpc(alice, "claim_username", {
    new_username: `x${stamp % 100000}`, invite_code: "NOPE-NOPE-NOPE",
  });
  check("and not with a made-up one", guess.status >= 400, true);

  const peekCodes = await api(alice, "/invite_codes?select=code");
  check("a signed-in user cannot enumerate codes",
        Array.isArray(peekCodes.body) ? peekCodes.body.length : peekCodes.status, 0);

  console.log("\nusernames");
  const an = `alice${stamp % 100000}`;
  const bn = `bob${stamp % 100000}`;
  check("alice claims a name",
        (await rpc(alice, "claim_username",
                   { new_username: an, invite_code: aliceCode })).body?.username,
        an);
  check("bob claims his",
        (await rpc(bob, "claim_username",
                   { new_username: bn, invite_code: bobCode })).body?.username,
        bn);

  const spent = await rpc(mallory, "claim_username", {
    new_username: `m${stamp % 100000}`, invite_code: aliceCode,
  });
  check("a code spent by someone else is refused", spent.status >= 400, true);

  // Alice is already through the gate, so renaming costs no second code.
  check("renaming needs no further code",
        (await rpc(alice, "claim_username", { new_username: an })).body?.username,
        an);

  const taken = await rpc(mallory, "claim_username", {
    new_username: an.toUpperCase(), invite_code: malloryCode,
  });
  check("the same name in different case is refused", taken.status >= 400, true);

  const bad = await rpc(mallory, "claim_username", {
    new_username: "no", invite_code: malloryCode,
  });
  check("a too-short name is refused", bad.status >= 400, true);

  // A username has to be findable or nobody can add a friend.
  const found = await api(bob, `/profiles?username=eq.${an}&select=id,username`);
  check("bob can look alice up by name", found.body?.[0]?.username, an);

  const hijack = await api(mallory, `/profiles?id=eq.${alice.id}`, {
    method: "PATCH", body: JSON.stringify({ display_name: "owned" }),
  });
  check("mallory cannot rewrite alice's profile",
        Array.isArray(hijack.body) ? hijack.body.length : hijack.status, 0);

  console.log("\nfriendship");
  const req = await rpc(alice, "request_friend", { their_username: bn });
  check("alice requests bob", req.body?.status, "pending");
  check("the pair is stored in one canonical order",
        req.body?.user_a < req.body?.user_b, true);

  const selfReq = await rpc(alice, "request_friend", { their_username: an });
  check("you cannot befriend yourself", selfReq.status >= 400, true);

  const selfAccept = await rpc(alice, "accept_friend", { their_id: bob.id });
  check("you cannot accept your own request", selfAccept.status >= 400, true);

  const acc = await rpc(bob, "accept_friend", { their_id: alice.id });
  check("bob accepts", acc.body?.status, "accepted");

  const peek = await api(mallory, "/friendships?select=user_a,user_b,status");
  check("mallory cannot see other people's friendships",
        Array.isArray(peek.body) ? peek.body.length : peek.status, 0);

  const forge = await api(mallory, "/friendships", {
    method: "POST",
    body: JSON.stringify({
      user_a: alice.id < bob.id ? alice.id : bob.id,
      user_b: alice.id < bob.id ? bob.id : alice.id,
      requested_by: mallory.id, status: "accepted",
    }),
  });
  check("mallory cannot insert herself into a friendship",
        forge.status >= 400, true);

  console.log("\npair progress");
  const rec = await rpc(alice, "record_progress", {
    their_id: bob.id, p_node: 1, p_medal: 2, p_time_s: 41, p_time_str: "00:41",
  });
  check("alice records a medal", [rec.body?.node, rec.body?.medal], [1, 2]);

  // Both peers compute the same result and both write it. The write has to be
  // idempotent and monotonic or whoever arrives second undoes the better run.
  const again = await rpc(bob, "record_progress", {
    their_id: alice.id, p_node: 1, p_medal: 1, p_time_s: 99, p_time_str: "01:39",
  });
  check("a worse result never overwrites a better one",
        [again.body?.medal, again.body?.best_time_s], [2, 41]);

  const better = await rpc(bob, "record_progress", {
    their_id: alice.id, p_node: 1, p_medal: 3, p_time_s: 30, p_time_str: "00:30",
  });
  check("a better one does",
        [better.body?.medal, better.body?.best_time_s, better.body?.best_time_str],
        [3, 30, "00:30"]);

  // The whole map in one statement. The client sends the picture `Recuent`
  // computed -- unlocks included -- rather than re-stating the adjacency rules
  // that already live in the ported game.
  const map = (them, edit) => {
    const stats = new Array(32).fill(-1);
    const times = new Array(32).fill(0);
    const strs = new Array(32).fill("");
    edit(stats, times, strs);
    return { their_id: them.id, p_stats: stats, p_times: times, p_times_str: strs };
  };

  const synced = await rpc(alice, "sync_progress", map(bob, (stats) => {
    stats[0] = 3;            // node 1, already at 3
    stats[1] = 0;            // node 2 and 3 unlocked by finishing it
    stats[2] = 0;
  }));
  check("finishing opens the adjacent nodes", synced.body, 2);

  const mine = await api(bob, "/pair_progress?select=node,medal&order=node");
  check("bob sees the pair's progress",
        mine.body?.map((r) => [r.node, r.medal]), [[1, 3], [2, 0], [3, 0]]);

  const worse = await rpc(bob, "sync_progress", map(alice, (stats, times, strs) => {
    stats[0] = 1; times[0] = 300; strs[0] = "05:00";
    stats[1] = 0; stats[2] = 0;
  }));
  check("and a worse map changes nothing at all", worse.body, 0);

  const locked = await rpc(bob, "sync_progress",
                           map(alice, (stats) => { stats[0] = 3; }));
  check("a node sent as locked cannot re-lock an open one", locked.body, 0);
  const after = await api(bob, "/pair_progress?select=node,medal&order=node");
  check("so the map is as it was",
        after.body?.map((r) => [r.node, r.medal]), [[1, 3], [2, 0], [3, 0]]);

  const short = await rpc(alice, "sync_progress",
                          { their_id: bob.id, p_stats: [3], p_times: [0],
                            p_times_str: [""] });
  check("a map that is not 32 nodes is refused", short.status >= 400, true);

  console.log("\nand none of it is visible to anyone else");
  const spy = await api(mallory, "/pair_progress?select=node,medal");
  check("select", Array.isArray(spy.body) ? spy.body.length : spy.status, 0);

  const lo = alice.id < bob.id ? alice.id : bob.id;
  const hi = alice.id < bob.id ? bob.id : alice.id;
  const ins = await api(mallory, "/pair_progress", {
    method: "POST",
    body: JSON.stringify({ user_a: lo, user_b: hi, node: 9, medal: 3 }),
  });
  check("insert", ins.status >= 400, true);

  const upd = await api(mallory, `/pair_progress?node=eq.1&user_a=eq.${lo}`, {
    method: "PATCH", body: JSON.stringify({ medal: 0 }),
  });
  check("update", Array.isArray(upd.body) ? upd.body.length : upd.status, 0);

  const del = await api(mallory, `/pair_progress?node=eq.1&user_a=eq.${lo}`, {
    method: "DELETE",
  });
  check("delete", Array.isArray(del.body) ? del.body.length : del.status, 0);

  const still = await api(alice, "/pair_progress?node=eq.1&select=medal");
  check("the pair's medal survived all of that", still.body?.[0]?.medal, 3);

  const rogue = await rpc(mallory, "record_progress", {
    their_id: alice.id, p_node: 1, p_medal: 3, p_time_s: 1, p_time_str: "00:01",
  });
  check("and mallory cannot record for a pair she is not in",
        rogue.status >= 400, true);

  const rogueMap = await rpc(mallory, "sync_progress", {
    their_id: alice.id,
    p_stats: new Array(32).fill(3),
    p_times: new Array(32).fill(1),
    p_times_str: new Array(32).fill("00:01"),
  });
  check("nor sync a whole map into it", rogueMap.status >= 400, true);

  console.log("\nan anonymous caller sees nothing");
  for (const [what, path] of [["profiles", "/profiles?select=username"],
                              ["friendships", "/friendships?select=status"],
                              ["progress", "/pair_progress?select=node"]]) {
    const r = await fetch(`${URL_}/rest/v1${path}`, { headers: { apikey: PUB } });
    const body = await r.json().catch(() => null);
    check(what, Array.isArray(body) ? body.length : r.status, 0);
  }
} finally {
  for (const u of users) {
    await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  }
  for (const c of codes) {
    await admin(`/rest/v1/invite_codes?code=eq.${c}`, { method: "DELETE" });
  }
  console.log(`\ncleaned up ${users.length} test users and ${codes.length} codes`);
}

console.log("\n" + (failures === 0 ? "RLS PASSED" : `RLS FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
