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

  console.log("\nthe leaderboard shows a pair without opening their row");
  {
    // The board is a projection, not a relaxed policy. Mallory can see the
    // ranked line and still cannot read the row it came from -- which is the
    // whole design: `pair_progress` keeps every members-only policy it has.
    await rpc(alice, "sync_progress", {
      their_id: bob.id,
      p_stats: [3, ...new Array(31).fill(-1)],
      p_times: [42, ...new Array(31).fill(0)],
      p_times_str: ["00:42", ...new Array(31).fill("")],
    });

    // Read back rather than assume. `sync_progress` is monotonic on purpose --
    // a time is only replaced by a faster one -- so what is stored after this
    // is whatever the pair's best actually is, which is the number the board
    // should be showing.
    const stored = (await api(alice, "/pair_progress?node=eq.1&select=best_time_s"))
      .body?.[0]?.best_time_s;
    const board = await rpc(mallory, "leaderboard", { p_node: 1 });
    const mine = (board.body ?? []).find((r) => r.best_time_s === stored);
    if (!mine) {
      console.log(`  stored ${JSON.stringify(stored)}, board said ` +
                  `${board.status} ${JSON.stringify(board.body).slice(0, 200)}`);
    }
    check("a stranger can see the entry", !!mine, true);
    check("with both names on it",
          [mine?.a_username, mine?.b_username].sort().join() ===
          [an, bn].sort().join(), true);
    check("and it is not hers", mine?.is_mine, false);
    check("but the row behind it is still hidden",
          (await api(mallory, "/pair_progress?select=node,best_time_s")).body?.length,
          0);
    check("while alice knows it is hers",
          ((await rpc(alice, "leaderboard", { p_node: 1 })).body ?? [])
            .find((r) => r.best_time_s === stored)?.is_mine, true);

    // Opting out is per account and takes the whole entry off: a row belongs to
    // two people and there is no half of it to publish.
    await api(bob, `/profiles?id=eq.${bob.id}`, {
      method: "PATCH", body: JSON.stringify({ hide_from_leaderboard: true }),
    });
    check("either player opting out removes the pair",
          ((await rpc(mallory, "leaderboard", { p_node: 1 })).body ?? [])
            .some((r) => r.best_time_s === stored), false);
    check("and neither can put the other back on",
          (await api(alice, `/profiles?id=eq.${bob.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hide_from_leaderboard: false }),
          })).body?.length ?? 0, 0);

    await api(bob, `/profiles?id=eq.${bob.id}`, {
      method: "PATCH", body: JSON.stringify({ hide_from_leaderboard: false }),
    });
  }

  console.log("\na recovery code works once, and only for its owner");
  {
    const minted = await rpc(alice, "generate_recovery_codes", {});
    const codes = minted.body ?? [];
    check("ten codes are issued", codes.length, 10);
    check("and they are shaped to be read aloud",
          /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(codes[0]), true);
    check("all ten are unused", (await rpc(alice, "recovery_codes_left", {})).body,
          10);

    // Never stored in the clear: the table holds bcrypt output, and there is no
    // policy by which anybody -- including alice -- may read even that.
    check("the codes are not readable by their owner",
          (await api(alice, "/mfa_recovery_codes?select=code_hash")).body?.length,
          0);

    check("somebody else's code is refused",
          (await rpc(bob, "redeem_recovery_code", { code: codes[0] })).body,
          false);
    check("a code that was never minted is refused",
          (await rpc(alice, "redeem_recovery_code", { code: "AAAAA-AAAAA" })).body,
          false);

    check("the real one is accepted",
          (await rpc(alice, "redeem_recovery_code", { code: codes[0] })).body,
          true);
    check("and the rest go with it -- they were spare keys to a lock that is "
          + "no longer there",
          (await rpc(alice, "recovery_codes_left", {})).body, 0);
    check("so the same code cannot be used twice",
          (await rpc(alice, "redeem_recovery_code", { code: codes[0] })).body,
          false);
  }

  console.log("\na block is only liftable by whoever cast it");
  {
    // The whole feature is this assertion. `block()` used to be a PATCH through
    // a policy that asked only whether you were one of the two people in the
    // row -- so the blocked party could set the status back to 'accepted' from
    // the browser, and a block either side can lift is not a block.
    const cast = await rpc(alice, "block_friend", { their_id: bob.id });
    check("alice can block bob", cast.status < 400, true);

    const row = await api(bob, `/friendships?select=status,blocked_by`);
    check("bob can see he is blocked", row.body?.[0]?.status, "blocked");

    const lift = await rpc(bob, "unblock_friend", { their_id: alice.id });
    check("but he cannot lift it", lift.status >= 400, true);

    const patch = await api(bob, `/friendships?user_a=eq.${lo}&user_b=eq.${hi}`, {
      method: "PATCH", body: JSON.stringify({ status: "accepted" }),
    });
    check("nor patch his way out of it",
          Array.isArray(patch.body) ? patch.body.length : patch.status, 0);

    // Deleting would be the other way out: drop the row, ask again, and the
    // block never happened.
    const drop = await api(bob, `/friendships?user_a=eq.${lo}&user_b=eq.${hi}`, {
      method: "DELETE",
    });
    check("nor delete it and start again",
          Array.isArray(drop.body) ? drop.body.length : drop.status, 0);

    const again = await rpc(bob, "request_friend",
                            { their_username: an });
    check("and asking again gets him nowhere", again.status >= 400, true);

    const still = await api(alice, "/friendships?select=status");
    check("so it is still a block", still.body?.[0]?.status, "blocked");

    const lifted = await rpc(alice, "unblock_friend", { their_id: bob.id });
    check("alice can lift her own", lifted.status < 400, true);
    const after = await api(bob, "/friendships?select=status,blocked_by");
    check("and they are friends again",
          [after.body?.[0]?.status, after.body?.[0]?.blocked_by],
          ["accepted", null]);
  }

  console.log("\nan account can delete itself, and only itself");
  {
    // `delete_me` borrows the owner's privilege to reach `auth.users`, which is
    // exactly the kind of function worth proving cannot be pointed anywhere
    // else. It takes no argument, so the only thing it can delete is the
    // caller -- and that is the assertion.
    const before = await admin(`/auth/v1/admin/users/${mallory.id}`);
    check("mallory exists to begin with", before.status, 200);

    const gone = await rpc(mallory, "delete_me", {});
    check("and can delete herself", gone.status < 400, true);

    const after = await admin(`/auth/v1/admin/users/${mallory.id}`);
    check("after which she does not exist", after.status >= 400, true);

    const others = await admin("/rest/v1/profiles?select=id&id=eq." + alice.id);
    check("and everybody else is untouched",
          (await others.json()).length, 1);
  }

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
