/**
 * Row level security, proved the way it will actually be used.
 *
 * Not pgTAP with `set role`: real users, created through the admin API, signed
 * in for real JWTs, talking to PostgREST exactly as the browser will. That
 * covers the whole path -- policy, grant, function security and the anon-key
 * surface -- rather than just the policy predicate, and it is the path an
 * attacker would take.
 *
 * The users are created and deleted by this script, so it can run repeatedly
 * against the real project without leaving anything behind.
 *
 * ## What an audit found that these assertions did not
 *
 * Three of the negative tests here used to be weaker than they read.
 *
 *   * "mallory cannot insert herself into a friendship" used a row Mallory was
 *     not a member of, so it exercised the membership predicate and never the
 *     attack that works: inserting `{self, victim, accepted}`, which the server
 *     accepted with a 201.
 *   * The `pair_progress` verbs were tried by a complete stranger, who is
 *     refused by membership. The caller who could actually do damage is a
 *     member of a PENDING or BLOCKED pair, and a member of an accepted one
 *     writing around the monotonic RPC.
 *   * Nothing at all was asked of an authenticated account with no profile,
 *     which 0004 claimed was inert.
 *
 * All three now have the caller the bug needed, which is why the sections below
 * are named after the attacker rather than after the table.
 */
import { env, open } from "./connect.mjs";
import { sweepStaleTestUsers } from "./sweep.mjs";

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

/** Refused, however the refusal is spelled: a 4xx, or a write that hit no row. */
function refused(r) {
  return r.status >= 400 || (Array.isArray(r.body) && r.body.length === 0);
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
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}

const rpc = (user, fn, args) =>
  api(user, `/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

const stamp = Date.now();
// Before anything is made: whatever a killed run left behind.
// `finally` cannot run when a process is killed, so the only
// reachable place to tidy those away is the start of the next run.
await sweepStaleTestUsers("rlstest");
const users = [];

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

/** The whole map, as `Recuent` computes it, with one edit applied. */
function map(them, edit) {
  const stats = new Array(32).fill(-1);
  const times = new Array(32).fill(0);
  const strs = new Array(32).fill("");
  edit(stats, times, strs);
  return { their_id: them.id, p_stats: stats, p_times: times, p_times_str: strs };
}

const pairOf = (x, y) => (x.id < y.id ? [x.id, y.id] : [y.id, x.id]);

try {
  console.log("four users, created and signed in for real");
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const mallory = await makeUser("mallory");
  // An account that signed up and never redeemed an invite. 0004 said such an
  // account is inert; until 0013 it could read the whole user directory and
  // forge itself into somebody else's friendship.
  const nobody = await makeUser("nobody");
  check("all four have sessions",
        [alice, bob, mallory, nobody].every((u) => u.token.length > 20), true);

  // ---- what is left of the door -------------------------------------------
  //
  // The invite gate is gone: `20260910000000_open_the_gate` took the code off
  // `claim_username`, because this deployment is meant to be publicly playable.
  // What used to be asserted here -- refused without a code, refused with a
  // made-up one, refused with somebody else's spent one -- describes a product
  // that no longer exists. Replaced rather than deleted, because what holds the
  // door now is still worth a test.
  console.log("\nthe way in, now that there is no code");

  // A confirmed account needs nothing else. An UNCONFIRMED one never reaches
  // this function at all -- GoTrue refuses it a token outright -- which is
  // where email verification is enforced now.
  const nogate = await rpc(alice, "claim_username",
                           { new_username: `x${stamp % 100000}` });
  check("a confirmed account claims a name with no code", nogate.status, 200);


  console.log("\nusernames");
  const an = `alice${stamp % 100000}`;
  const bn = `bob${stamp % 100000}`;
  const mn = `mal${stamp % 100000}`;
  check("alice claims a name",
        (await rpc(alice, "claim_username",
                   { new_username: an })).body?.username,
        an);
  check("bob claims his",
        (await rpc(bob, "claim_username",
                   { new_username: bn })).body?.username,
        bn);

  // A third account, arriving the same way as the first two and needing nothing
  // from either of them.
  const spent = await rpc(mallory, "claim_username", {
    new_username: `m${stamp % 100000}`,
  });
  check("a third confirmed account gets in on its own", spent.status, 200);

  check("renaming asks for nothing further",
        (await rpc(alice, "claim_username", { new_username: an })).body?.username,
        an);

  const taken = await rpc(mallory, "claim_username", {
    new_username: an.toUpperCase(),
  });
  // A row of nulls since the claim is metered (20261005040000) -- a raise
  // would roll back the charge -- and a 409 on a database from before it.
  check("the same name in different case is refused",
        taken.status >= 400 || taken.body?.id == null, true);

  const bad = await rpc(mallory, "claim_username", {
    new_username: "no",
  });
  check("a too-short name is refused", bad.status >= 400, true);

  // Mallory is a legitimate third user, not a broken one: the point of her is
  // that everything she is refused below is refused for the right reason.
  check("mallory claims hers with the code the failures did not spend",
        (await rpc(mallory, "claim_username",
                   { new_username: mn })).body?.username,
        mn);

  // A username used to have to be findable "or nobody can add a friend", and
  // that turned out to be false -- which is why this assertion is inverted now.
  //
  // Adding a friend goes through `request_friend(their_username)`, a definer
  // function that resolves the name server-side. The client never needed to
  // read a stranger's row, and `20260912000000_tighten_reads` stopped letting
  // it: a readable-by-name profiles table is a table anybody can walk, and
  // since the invite gate came down "anybody" means anybody.
  const found = await api(bob, `/profiles?username=eq.${an}&select=id,username`);
  check("bob cannot look alice up before they are anything to each other",
        Array.isArray(found.body) ? found.body.length : found.status, 0);


  const hijack = await api(mallory, `/profiles?id=eq.${alice.id}`, {
    method: "PATCH", body: JSON.stringify({ display_name: "owned" }),
  });
  check("mallory cannot rewrite alice's profile", refused(hijack), true);

  console.log("\nan account that never redeemed an invite is actually inert");
  {
    // Every one of these was reachable before 0013. The first is how the
    // attacker got the victim's id, and the rest are what they did with it.
    check("it cannot read the user directory",
          (await api(nobody, "/profiles?select=id")).body?.length, 0);
    check("nor look a name up",
          (await api(nobody, `/profiles?username=eq.${an}&select=id`)).body?.length,
          0);
    check("nor see any friendship",
          (await api(nobody, "/friendships?select=status")).body?.length, 0);
    check("nor any progress",
          (await api(nobody, "/pair_progress?select=node")).body?.length, 0);

    const [lo, hi] = pairOf(nobody, alice);
    check("nor insert itself into one",
          refused(await api(nobody, "/friendships", {
            method: "POST",
            body: JSON.stringify({
              user_a: lo, user_b: hi, status: "accepted", requested_by: nobody.id,
            }),
          })), true);
    check("nor ask to be a friend",
          (await rpc(nobody, "request_friend", { their_username: an })).status >= 400,
          true);
    check("nor sync a map",
          (await rpc(nobody, "sync_progress", map(alice, (s) => { s[0] = 3; })))
            .status >= 400, true);
    check("and the board tells it nothing",
          (await rpc(nobody, "leaderboard", { p_node: 1 })).body?.length ?? 0, 0);
  }

  console.log("\nfriendship");
  const req = await rpc(alice, "request_friend", { their_username: bn });
  check("alice requests bob", req.body?.status, "pending");
  check("the pair is stored in one canonical order",
        req.body?.user_a < req.body?.user_b, true);

  const selfReq = await rpc(alice, "request_friend", { their_username: an });
  check("you cannot befriend yourself", selfReq.status >= 400, true);

  const selfAccept = await rpc(alice, "accept_friend", { their_id: bob.id });
  check("you cannot accept your own request", selfAccept.status >= 400, true);

  console.log("\nand a friendship cannot be forged into existence");
  {
    // THE bug. Not "somebody else's row" -- the attacker's own row, with the
    // victim in it, inserted straight at the table with `status: accepted`.
    // The server used to return 201 and store it, which handed the forger the
    // pair's private Realtime topic, their presence, their invitations and
    // every row of their shared progress.
    const [lo, hi] = pairOf(mallory, alice);
    const forge = await api(mallory, "/friendships", {
      method: "POST",
      body: JSON.stringify({
        user_a: lo, user_b: hi, status: "accepted", requested_by: mallory.id,
      }),
    });
    check("mallory cannot insert an accepted friendship with alice",
          refused(forge), true);

    const asPending = await api(mallory, "/friendships", {
      method: "POST",
      body: JSON.stringify({
        user_a: lo, user_b: hi, status: "pending", requested_by: mallory.id,
      }),
    });
    check("nor even a pending one, directly", refused(asPending), true);

    // Through the front door, so there is a real pending row to attack.
    check("she can ask properly",
          (await rpc(mallory, "request_friend", { their_username: an })).body?.status,
          "pending");

    const promote = await api(mallory,
      `/friendships?user_a=eq.${lo}&user_b=eq.${hi}`, {
        method: "PATCH", body: JSON.stringify({ status: "accepted" }),
      });
    check("and cannot promote her own request to accepted", refused(promote), true);

    const reassign = await api(mallory,
      `/friendships?user_a=eq.${lo}&user_b=eq.${hi}`, {
        method: "PATCH", body: JSON.stringify({ requested_by: alice.id }),
      });
    check("nor say that alice was the one who asked", refused(reassign), true);

    const wrongWay = await rpc(mallory, "accept_friend", { their_id: alice.id });
    check("nor accept it through the function either",
          wrongWay.status >= 400, true);

    check("the row is still pending",
          (await api(alice, `/friendships?user_a=eq.${lo}&user_b=eq.${hi}` +
                            "&select=status,requested_by")).body?.[0]?.status,
          "pending");
    check("with mallory still the one who asked",
          (await api(alice, `/friendships?user_a=eq.${lo}&user_b=eq.${hi}` +
                            "&select=requested_by")).body?.[0]?.requested_by,
          mallory.id);

    // And the recipient can still do the one thing they are for.
    check("alice, who was asked, can accept",
          (await rpc(alice, "accept_friend", { their_id: mallory.id })).body?.status,
          "accepted");
    check("and can leave again",
          (await rpc(alice, "remove_friend", { their_id: mallory.id })).body, true);
  }

  const acc = await rpc(bob, "accept_friend", { their_id: alice.id });
  check("bob accepts alice", acc.body?.status, "accepted");

  const peek = await api(mallory, "/friendships?select=user_a,user_b,status");
  check("mallory cannot see other people's friendships",
        Array.isArray(peek.body) ? peek.body.length : peek.status, 0);

  console.log("\npair progress");
  const [lo, hi] = pairOf(alice, bob);

  const first = await rpc(alice, "sync_progress", map(bob, (stats, times, strs) => {
    stats[0] = 2; times[0] = 41; strs[0] = "00:41";
  }));
  check("alice records a medal", first.body, 1);

  // Both peers compute the same result and both write it. The write has to be
  // idempotent and monotonic or whoever arrives second undoes the better run.
  const again = await rpc(bob, "sync_progress", map(alice, (stats, times, strs) => {
    stats[0] = 1; times[0] = 99; strs[0] = "01:39";
  }));
  check("a worse result changes nothing", again.body, 0);

  const better = await rpc(bob, "sync_progress", map(alice, (stats, times, strs) => {
    stats[0] = 3; times[0] = 30; strs[0] = "00:30";
  }));
  check("a better one does", better.body, 1);
  check("and it is what is stored",
        (await api(alice, "/pair_progress?node=eq.1&select=medal,best_time_s," +
                          "best_time_str")).body?.[0],
        { medal: 3, best_time_s: 30, best_time_str: "00:30" });

  const synced = await rpc(alice, "sync_progress", map(bob, (stats) => {
    stats[0] = 3;            // node 1, already at 3
    stats[1] = 0;            // node 2 and 3 unlocked by finishing it
    stats[2] = 0;
  }));
  check("finishing opens the adjacent nodes", synced.body, 2);

  const mine = await api(bob, "/pair_progress?select=node,medal&order=node");
  check("bob sees the pair's progress",
        mine.body?.map((r) => [r.node, r.medal]), [[1, 3], [2, 0], [3, 0]]);

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

  const ragged = await rpc(alice, "sync_progress", {
    their_id: bob.id, p_stats: new Array(32).fill(-1),
    p_times: [1, 2, 3], p_times_str: new Array(32).fill(""),
  });
  check("nor one whose OTHER arrays are the wrong length",
        ragged.status >= 400, true);

  console.log("\nwhat a member of the pair still cannot write");
  {
    // The RPC is monotonic. The table was not, and every one of these went
    // round it: either member could lower a medal, erase a time, or delete the
    // pair's history outright.
    check("alice cannot insert a row by hand",
          refused(await api(alice, "/pair_progress", {
            method: "POST",
            body: JSON.stringify({ user_a: lo, user_b: hi, node: 9, medal: 3 }),
          })), true);
    check("nor patch a medal down",
          refused(await api(alice, `/pair_progress?node=eq.1&user_a=eq.${lo}`, {
            method: "PATCH", body: JSON.stringify({ medal: 0 }),
          })), true);
    check("nor delete the pair's history",
          refused(await api(alice, `/pair_progress?user_a=eq.${lo}`, {
            method: "DELETE",
          })), true);
    check("and it is all still there",
          (await api(bob, "/pair_progress?select=node&order=node")).body?.length, 3);
  }

  console.log("\nnor anything a client claims about a time");
  {
    // The board ranks `best_time_s` ascending and prints `best_time_str`, and
    // both used to be whatever the caller said. Zero seconds took the top of
    // every level; the label was free text beside it.
    check("a level cannot be finished in one second",
          (await rpc(alice, "sync_progress", map(bob, (s, t) => {
            s[3] = 3; t[3] = 1;
          }))).status >= 400, true);
    check("nor in longer than the timer can display",
          (await rpc(alice, "sync_progress", map(bob, (s, t) => {
            s[3] = 3; t[3] = 100000;
          }))).status >= 400, true);
    check("nor with a medal that does not exist",
          (await rpc(alice, "sync_progress", map(bob, (s) => { s[3] = 9; })))
            .status >= 400, true);

    // A plausible time with a lying label. The label is derived, so the lie
    // simply does not survive the write.
    await rpc(alice, "sync_progress", map(bob, (s, t, str) => {
      s[3] = 3; t[3] = 63; str[3] = "00:01 WORLD RECORD";
    }));
    check("and the label on the board is computed, not accepted",
          (await api(alice, "/pair_progress?node=eq.4&select=best_time_s," +
                            "best_time_str")).body?.[0],
          { best_time_s: 63, best_time_str: "01:03" });

    // Zero means "no time recorded", which is what an unlocked-but-unfinished
    // node has -- it must not become a zero-second entry on the board.
    await rpc(alice, "sync_progress", map(bob, (s, t) => { s[4] = 0; t[4] = 0; }));
    check("a node merely unlocked carries no time at all",
          (await api(alice, "/pair_progress?node=eq.5&select=medal,best_time_s"))
            .body?.[0],
          { medal: 0, best_time_s: null });
  }

  console.log("\nand none of it is visible to anyone else");
  {
    const spy = await api(mallory, "/pair_progress?select=node,medal");
    check("select", Array.isArray(spy.body) ? spy.body.length : spy.status, 0);
    check("insert",
          refused(await api(mallory, "/pair_progress", {
            method: "POST",
            body: JSON.stringify({ user_a: lo, user_b: hi, node: 9, medal: 3 }),
          })), true);
    check("update",
          refused(await api(mallory, `/pair_progress?node=eq.1&user_a=eq.${lo}`, {
            method: "PATCH", body: JSON.stringify({ medal: 0 }),
          })), true);
    check("delete",
          refused(await api(mallory, `/pair_progress?node=eq.1&user_a=eq.${lo}`, {
            method: "DELETE",
          })), true);
    check("the pair's medal survived all of that",
          (await api(alice, "/pair_progress?node=eq.1&select=medal")).body?.[0]?.medal,
          3);
    check("and mallory cannot sync a whole map into it",
          (await rpc(mallory, "sync_progress", {
            their_id: alice.id,
            p_stats: new Array(32).fill(3),
            p_times: new Array(32).fill(30),
            p_times_str: new Array(32).fill("00:30"),
          })).status >= 400, true);
  }

  console.log("\nnor to somebody who has only ASKED to be a friend");
  {
    // The state the old policies could not see. `is_member` is true the moment
    // a request exists, so a pending friendship used to carry every
    // `pair_progress` verb -- and asking to be somebody's friend is a thing
    // anybody can do to anybody.
    check("mallory asks alice again",
          (await rpc(mallory, "request_friend", { their_username: an }))
            .body?.status, "pending");
    const [plo, phi] = pairOf(mallory, alice);
    check("she cannot read a pending pair's progress",
          (await api(mallory, `/pair_progress?user_a=eq.${plo}&select=node`))
            .body?.length, 0);
    check("nor write one directly",
          refused(await api(mallory, "/pair_progress", {
            method: "POST",
            body: JSON.stringify({ user_a: plo, user_b: phi, node: 1, medal: 3 }),
          })), true);
    check("nor sync one",
          (await rpc(mallory, "sync_progress", map(alice, (s) => { s[0] = 3; })))
            .status >= 400, true);
    check("and alice cannot either, from her side of the same row",
          (await rpc(alice, "sync_progress", map(mallory, (s) => { s[0] = 3; })))
            .status >= 400, true);
    // Tidied up, so the block section below starts from the pair it expects.
    await rpc(alice, "remove_friend", { their_id: mallory.id });
  }

  console.log("\nthe leaderboard shows a pair without opening their row");
  {
    // The board is a projection, not a relaxed policy. Mallory can see the
    // ranked line and still cannot read the row it came from -- which is the
    // whole design: `pair_progress` keeps every members-only policy it has.
    const stored = (await api(alice, "/pair_progress?node=eq.1&select=best_time_s"))
      .body?.[0]?.best_time_s;

    /**
     * This pair's line, found by WHO is on it.
     *
     * It used to be found by matching `best_time_s`, which is a property the
     * board is full of: any other pair that happened to finish node 1 in the
     * same number of seconds answered to it, and the assertions then made
     * statements about somebody else's row -- "with both names on it" fails,
     * "alice knows it is hers" fails, and opting out appears not to work. The
     * board is shared across the whole project, so a test that assumes it is
     * empty is a test that passes only on a clean database.
     */
    const ours = (rows) => (rows ?? []).find((r) =>
      [r.a_username, r.b_username].sort().join() === [an, bn].sort().join());

    const board = await rpc(mallory, "leaderboard", { p_node: 1, p_limit: 100 });
    const entry = ours(board.body);
    if (!entry) {
      console.log(`  stored ${JSON.stringify(stored)}, board said ` +
                  `${board.status} ${JSON.stringify(board.body).slice(0, 300)}`);
    }
    check("a stranger can see the entry", !!entry, true);
    // The board shows the slower of the two players' own bests -- a time BOTH
    // of them reported -- so one friend cannot put the pair on it alone.
    // Alice sent 41 s and bob 30 s, so the pair's best is 30 and the board's 41.
    check("with the time both of them reported", entry?.best_time_s, 41);
    check("and it is not hers", entry?.is_mine, false);
    check("but the row behind it is still hidden",
          (await api(mallory, "/pair_progress?select=node,best_time_s")).body?.length,
          0);
    check("while alice knows it is hers",
          ours((await rpc(alice, "leaderboard", { p_node: 1, p_limit: 100 })).body)
            ?.is_mine, true);

    // Opting out is per account and takes the whole entry off: a row belongs to
    // two people and there is no half of it to publish.
    await api(bob, `/profiles?id=eq.${bob.id}`, {
      method: "PATCH", body: JSON.stringify({ hide_from_leaderboard: true }),
    });
    check("either player opting out removes the pair",
          !!ours((await rpc(mallory, "leaderboard", { p_node: 1, p_limit: 100 }))
            .body), false);
    check("and neither can put the other back on",
          refused(await api(alice, `/profiles?id=eq.${bob.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hide_from_leaderboard: false }),
          })), true);

    await api(bob, `/profiles?id=eq.${bob.id}`, {
      method: "PATCH", body: JSON.stringify({ hide_from_leaderboard: false }),
    });
  }

  console.log("\nrecovery codes cannot be minted by the session they protect");
  {
    // 0012 asked only whether somebody was signed in, which made the feature a
    // way around itself: a password-only session minted ten codes and handed
    // one straight back to `redeem_recovery_code` to unenrol a factor it had
    // never answered. See `mfatest.mjs` for the same rule proved against a
    // session that HAS answered one.
    const minted = await rpc(alice, "generate_recovery_codes", {});
    check("an account with no second factor has nothing to recover from",
          minted.status >= 400, true);
    check("and no codes were made", (await rpc(alice, "recovery_codes_left", {})).body,
          0);
    check("the hashes are unreadable in any case",
          (await api(alice, "/mfa_recovery_codes?select=code_hash")).body?.length ?? 0,
          0);
    check("a code that was never minted is refused",
          (await rpc(alice, "redeem_recovery_code", { code: "AAAAA-AAAAA" })).body,
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

    // Being blocked must read exactly like the blocker not existing -- that is
    // why `request_friend` answers a blocked pair with nulls -- so none of the
    // three reads that used to say otherwise may say it now.
    const row = await api(bob, `/friendships?select=status,blocked_by`);
    check("bob cannot see the block in the table", row.body?.length, 0);
    const listed = await rpc(bob, "list_friends", {});
    check("nor in his friends list",
          (listed.body ?? []).filter((f) => f.id === alice.id).length, 0);
    check("nor read alice's profile any more",
          (await api(bob, `/profiles?id=eq.${alice.id}&select=username`)).body?.length,
          0);
    check("while alice still sees the block she has to be able to lift",
          (await rpc(alice, "list_friends", {})).body
            ?.find((f) => f.id === bob.id)?.blockedByMe, true);

    const lift = await rpc(bob, "unblock_friend", { their_id: alice.id });
    check("but he cannot lift it", lift.status >= 400, true);

    check("nor patch his way out of it",
          refused(await api(bob, `/friendships?user_a=eq.${lo}&user_b=eq.${hi}`, {
            method: "PATCH", body: JSON.stringify({ status: "accepted" }),
          })), true);

    // Deleting would be the other way out: drop the row, ask again, and the
    // block never happened.
    check("nor delete it and start again",
          refused(await api(bob, `/friendships?user_a=eq.${lo}&user_b=eq.${hi}`, {
            method: "DELETE",
          })), true);
    check("nor through the function that does the same thing",
          (await rpc(bob, "remove_friend", { their_id: alice.id })).body, false);

    // Blocked answers exactly as a name nobody has does: a row of nulls, not an
    // error. It used to raise, and raising is what `20260913010000` had to stop
    // doing -- a raise rolls back the attempt it was just charged for, which
    // would leave the one call that still resolves a username free to be asked
    // forever. Indistinguishable from "no such user" is the point either way.
    const asked = await rpc(bob, "request_friend", { their_username: an });
    check("and asking again gets him nowhere", asked.status, 200);
    // `rpc` here hands back a PARSED body, unlike the one in realtimetest.mjs,
    // which returns text. Two helpers of the same name, two contracts.
    check("with the same answer a name nobody has would give",
          asked.body?.user_a ?? null, null);

    // A blocked pair's progress is kept -- 0009 chose that deliberately -- and
    // is nobody's to read or write until the block is lifted.
    check("neither of them can read the pair's progress while it stands",
          [(await api(alice, "/pair_progress?select=node")).body?.length,
           (await api(bob, "/pair_progress?select=node")).body?.length], [0, 0]);
    check("nor sync into it",
          (await rpc(bob, "sync_progress", map(alice, (s) => { s[0] = 3; })))
            .status >= 400, true);

    const still = await api(alice, "/friendships?select=status");
    check("so it is still a block", still.body?.[0]?.status, "blocked");

    const lifted = await rpc(alice, "unblock_friend", { their_id: bob.id });
    check("alice can lift her own", lifted.status < 400, true);
    const back = await api(bob, "/friendships?select=status,blocked_by");
    check("and they are friends again",
          [back.body?.[0]?.status, back.body?.[0]?.blocked_by],
          ["accepted", null]);
    check("with every level they finished still there",
          (await api(bob, "/pair_progress?select=node")).body?.length, 5);
  }

  console.log("\na request cannot be blocked into a friendship");
  {
    // request, block, unblock: three calls by ONE person used to end at
    // 'accepted', because block took a pending row and unblock restores
    // whatever it lifts to 'accepted'. Only a friendship can be blocked now.
    const pusher = await makeUser("pusher");
    const target = await makeUser("target");
    const pn = `psh${stamp % 100000}`;
    const tn = `tgt${stamp % 100000}`;
    await rpc(pusher, "claim_username", { new_username: pn });
    await rpc(target, "claim_username", { new_username: tn });
    const sent = await rpc(pusher, "request_friend", { their_username: tn });
    check("the request is pending", sent.body?.status, "pending");
    check("its sender cannot block it",
          (await rpc(pusher, "block_friend", { their_id: target.id })).status >= 400,
          true);
    check("so there is nothing to unblock",
          (await rpc(pusher, "unblock_friend", { their_id: target.id })).status >= 400,
          true);
    check("nor can its recipient block it -- a request is declined",
          (await rpc(target, "block_friend", { their_id: pusher.id })).status >= 400,
          true);
    check("and it is still only a request",
          (await api(target, "/friendships?select=status")).body?.[0]?.status,
          "pending");
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

    const post = await admin(`/auth/v1/admin/users/${mallory.id}`);
    check("after which she does not exist", post.status >= 400, true);

    const others = await admin("/rest/v1/profiles?select=id&id=eq." + alice.id);
    check("and everybody else is untouched",
          (await others.json()).length, 1);

    // An account with no profile has to be able to leave too, or the invite
    // gate becomes a trap.
    check("and so can an account that never claimed a name",
          (await rpc(nobody, "delete_me", {})).status < 400, true);
  }

  console.log("\nan anonymous caller sees nothing");
  for (const [what, path] of [["profiles", "/profiles?select=username"],
                              ["friendships", "/friendships?select=status"],
                              ["progress", "/pair_progress?select=node"]]) {
    const r = await fetch(`${URL_}/rest/v1${path}`, { headers: { apikey: PUB } });
    const body = await r.json().catch(() => null);
    check(what, Array.isArray(body) ? body.length : r.status, 0);
  }
  // ---- what a signed-in stranger can reach --------------------------------

  console.log("\nan account nobody knows cannot look around");
  {
    // Signing up needs nothing but a confirmed address now, so "some
    // authenticated caller" and "anybody at all" are the same set of people.
    // All of this was true and harmless while an invite code stood in front of
    // it, and stopped being either when the gate came down.
    const stranger = await makeUser("stranger");
    const sname = `str${stamp % 100000}`;
    await rpc(stranger, "claim_username", { new_username: sname });

    const seen = await api(stranger, "/profiles?select=id,username");
    const rows = Array.isArray(seen.body) ? seen.body : [];
    check("it reads exactly one profile -- its own", rows.length, 1);
    check("and that one is itself", rows[0]?.username, sname);
    // Said plainly, because it is the point: user ids are what a topic derived
    // from two players is built out of, and not being able to list them is what
    // stops such a topic being reachable at scale.
    check("so it collects nobody else's id",
          rows.some((r) => r.id !== stranger.id), false);

    for (const t of ["friendships", "pair_progress", "solo_progress"]) {
      const r = await api(stranger, `/${t}?select=*`);
      check(`nor reads ${t}`,
            Array.isArray(r.body) ? r.body.length : r.status, 0);
    }

    // The half the old "a username has to be findable" assertion was actually
    // protecting -- proved on two accounts of its own, because asking to be
    // somebody's friend is not a read. Done on alice or bob it would have
    // changed what their own requests meant further up: `request_friend` reads
    // a crossed request as an acceptance.
    const hopeful = await makeUser("hopeful");
    const wanted = await makeUser("wanted");
    const wname = `wnt${stamp % 100000}`;
    await rpc(hopeful, "claim_username", { new_username: `hpf${stamp % 100000}` });
    await rpc(wanted, "claim_username", { new_username: wname });

    const blind = await api(hopeful, `/profiles?username=eq.${wname}&select=id`);
    check("a stranger cannot see the person they are about to add",
          Array.isArray(blind.body) ? blind.body.length : blind.status, 0);
    const asked = await rpc(hopeful, "request_friend", { their_username: wname });
    check("and can add them anyway -- the name is resolved server-side",
          asked.status < 400, true);
    const named = await api(hopeful, `/profiles?username=eq.${wname}&select=username`);
    check("after which there is a row, so the name can be shown",
          named.body?.[0]?.username, wname);
  }

  // ---- asking to be a friend costs something -------------------------------

  console.log("\nand cannot ask to be everybody's friend");
  {
    // `request_friend` answers differently for a name somebody has and one
    // nobody does, which makes it an existence oracle -- the last one, now that
    // `profiles` is closed. Five an hour is what makes it a useless one.
    const noisy = await makeUser("noisy");
    await rpc(noisy, "claim_username", { new_username: `nsy${stamp % 100000}` });

    const tries = [];
    for (let i = 1; i <= 7; i++) {
      tries.push((await rpc(noisy, "request_friend",
                            { their_username: `ghost${stamp}${i}` })).status);
    }
    check("five attempts at names nobody has are allowed",
          tries.slice(0, 5).every((s) => s < 400), true);
    check("and the sixth is refused", tries[5] >= 400, true);

    // The half that is easy to get wrong. A raise rolls its own transaction
    // back, so an earlier version of this counted the attempt and then undid
    // the count on its way out -- seven probes, budget still reading zero.
    // Charging only for SUCCESS would leave probing free, which is the opposite
    // of the point.
    check("so a failed probe costs the same as a real request",
          tries[6] >= 400, true);
  }

  // ---- the grants themselves, read out of the catalogue -------------------

  console.log("\nand the surface matches what this project claims");
  {
    const db = await open({ quiet: true });
    try {
      // Asserted as a SET, not as a list of names. The failure worth catching
      // is a function added LATER that arrives with Supabase's default grant --
      // which is how `has_password` shipped reachable by anybody holding the
      // publishable key. Listing known names would not have caught that; asking
      // whether the set is empty does.
      const open_ = (await db.query(`
        select p.proname
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and has_function_privilege('anon', p.oid, 'execute')
         order by p.proname`)).rows.map((r) => r.proname);
      check("no function in public is executable by anon", open_, []);

      // Both halves of the revoke are needed and each hides the other's
      // absence: PUBLIC's default keeps `anon` able to execute however many
      // named revokes run, and a named grant survives `revoke ... from public`.
      const authed = (await db.query(`
        select count(*)::int as n
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and has_function_privilege('authenticated', p.oid, 'execute')`))
        .rows[0].n;
      check("while a signed-in player still has plenty", authed > 20, true);

      // A topic derived from who the players ARE cannot be revoked: the name is
      // a fact about them. `20260906000000_watch_topic_contract` removed the
      // last arm that honoured `watch:<lo>:<hi>`, on both the read and the
      // publish side.
      const srcOf = async (name) => (await db.query(`
        select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = $1`, [name])).rows[0].prosrc;

      const watch = await srcOf("can_watch_pair_topic");
      check("watching no longer accepts a topic built from two user ids",
            /theirs\.user_a/.test(watch), false);
      check("and requires a consent that can be withdrawn",
            /consent_a/.test(watch) && /expires_at/.test(watch), true);

      const feed = await srcOf("can_feed_watch_topic");
      check("nor does publishing to one",
            /f\.user_a::text/.test(feed), false);
    } finally {
      await db.end();
    }
  }

} finally {
  for (const u of users) {
    await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  }
  console.log(`
cleaned up ${users.length} test users`);
}

console.log("\n" + (failures === 0 ? "RLS PASSED" : `RLS FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
