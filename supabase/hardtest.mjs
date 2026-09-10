/**
 * The database under pressure, rather than under inspection.
 *
 * `rlstest` asks whether the policies say the right thing. This asks what
 * happens when two people do the same thing at the same instant, when the same
 * write arrives two hundred times in a random order, and when a stranger walks
 * the entire public surface looking for a way in.
 *
 * Every claim here is one the design actually rests on:
 *
 *   * a username is claimed in ONE statement, so a race for it has exactly one
 *     winner rather than two;
 *   * `sync_progress` is monotonic and order-independent, which is what lets
 *     BOTH peers write without electing one of them;
 *   * unfriending takes the shared progress with it, because progress belongs
 *     to the pair and a pair that no longer exists has none;
 *   * and none of it is reachable without signing in.
 */
import { env } from "./connect.mjs";
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

const stamp = Date.now();
// Before anything is made: whatever a killed run left behind.
// `finally` cannot run when a process is killed, so the only
// reachable place to tidy those away is the start of the next run.
await sweepStaleTestUsers("hardtest");
const users = [];

const admin = (path, init = {}) => fetch(`${URL_}${path}`, {
  ...init,
  headers: {
    apikey: SECRET, Authorization: `Bearer ${SECRET}`,
    "content-type": "application/json", ...(init.headers ?? {}),
  },
});

async function api(user, path, init = {}) {
  const r = await fetch(`${URL_}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: PUB,
      ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
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

async function makeUser(tag) {
  const email = `fbwg_hard_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_${tag}!A`;
  const created = await (await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  })).json();
  if (!created.id) throw new Error("could not create a user");
  const s = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUB, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })).json();
  const u = { id: created.id, email, token: s.access_token, tag };
  users.push(u);
  return u;
}

try {
  console.log("two people, the same username, the same instant");
  {
    const a = await makeUser("racea");
    const b = await makeUser("raceb");
    const wanted = `race${stamp % 100000}`;
    // Issued together, so they are genuinely in flight at the same time rather
    // than one after the other.
    const [ra, rb] = await Promise.all([
      rpc(a, "claim_username", { new_username: wanted }),
      rpc(b, "claim_username", { new_username: wanted }),
    ]);
    const won = [ra, rb].filter((r) => r.status < 400).length;
    check("exactly one of them got the name", won, 1);

    // Asked as whoever WON, which is the only account that can answer it.
    // Read as `a` unconditionally this was a coin flip: when `b` won, `a` came
    // away profileless, RLS correctly showed a profileless account nothing, and
    // the suite reported 0 profiles for a name that one person plainly holds.
    // A test that fails half the time on the function guarding the invite gate
    // is worse than no test, because the next real regression looks like the
    // usual noise.
    const winner = ra.status < 400 ? a : b;
    const holders = await api(winner, `/profiles?username=eq.${wanted}&select=id`);
    check("and only one profile has it", holders.body?.length ?? 0, 1);
  }

  console.log("\none person, sixteen requests at once");
  {
    // The race that actually happened, and it is not two people. One client
    // sending the same call several times -- a double click, a retry, a flaky
    // connection -- had every request pass `select exists (... from profiles)`
    // before any of them had inserted the profile.
    //
    // When there was a gate this showed up as accounting: eight parallel calls
    // consumed THREE uses of one code while creating one profile. The codes are
    // gone and the race is not, so what is left to assert is the part that was
    // always the real requirement -- sixteen retries of one intention produce
    // one profile and one answer, rather than sixteen arguments about it.
    const u = await makeUser("barrier");
    const wanted = `bar${stamp % 100000}`;
    const all = await Promise.all(Array.from({ length: 16 }, () =>
      rpc(u, "claim_username", { new_username: wanted })));

    // Every one of them is a legitimate retry of the same intention, so every
    // one of them should succeed. Idempotent, not merely serialized.
    check("all sixteen are answered the same way",
          all.filter((r) => r.status < 400).length, 16);
    check("and all sixteen say the same name",
          new Set(all.map((r) => r.body?.username)).size, 1);

    const holders = await api(u, `/profiles?username=eq.${wanted}&select=id`);
    check("and there is one profile", holders.body?.length ?? 0, 1);
  }

  console.log("\nprogress converges however the writes are ordered");
  {
    const a = await makeUser("fuzza");
    const b = await makeUser("fuzzb");
    const an = `fa${stamp % 100000}`;
    const bn = `fb${stamp % 100000}`;
    await rpc(a, "claim_username", { new_username: an });
    await rpc(b, "claim_username", { new_username: bn });
    await rpc(a, "request_friend", { their_username: bn });
    await rpc(b, "accept_friend", { their_id: a.id });

    // A little deterministic generator, so a failure can be reproduced.
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    const best = { medal: new Array(32).fill(-1), time: new Array(32).fill(0) };
    const maps = [];
    for (let i = 0; i < 60; i++) {
      const stats = new Array(32).fill(-1);
      const times = new Array(32).fill(0);
      const strs = new Array(32).fill("");
      for (let n = 0; n < 32; n++) {
        if (rnd() < 0.4) continue;
        const medal = Math.floor(rnd() * 4);          // 0..3
        const secs = 20 + Math.floor(rnd() * 200);
        stats[n] = medal;
        times[n] = secs;
        strs[n] = `${String(Math.floor(secs / 60)).padStart(2, "0")}:` +
                  `${String(secs % 60).padStart(2, "0")}`;
        // What the answer has to be, whatever order these arrive in.
        best.medal[n] = Math.max(best.medal[n], medal);
        // A medal of 0 is a node reached and not finished, so it carries no
        // time at all -- 0016 drops one rather than putting an unplayed level
        // on the board with whatever seconds happened to be in the array.
        if (medal > 0 && (best.time[n] === 0 || secs < best.time[n])) {
          best.time[n] = secs;
        }
      }
      maps.push({ stats, times, strs, from: i % 2 === 0 ? a : b, other: i % 2 === 0 ? b : a });
    }

    // Shuffled, and sent in overlapping batches: the point is that no order
    // produces a different answer.
    for (let i = maps.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [maps[i], maps[j]] = [maps[j], maps[i]];
    }
    for (let i = 0; i < maps.length; i += 6) {
      await Promise.all(maps.slice(i, i + 6).map((m) =>
        rpc(m.from, "sync_progress", {
          their_id: m.other.id, p_stats: m.stats,
          p_times: m.times, p_times_str: m.strs,
        })));
    }

    const rows = await api(a, "/pair_progress?select=node,medal,best_time_s&order=node");
    const got = new Map((rows.body ?? []).map((r) =>
      [r.node, [r.medal, r.best_time_s ?? 0]]));
    let wrong = 0;
    for (let n = 0; n < 32; n++) {
      if (best.medal[n] < 0) continue;
      const [medal, secs] = got.get(n + 1) ?? [null, null];
      if (medal !== best.medal[n] || secs !== best.time[n]) wrong++;
    }
    console.log(`  ${maps.length} maps from both peers, ${got.size} nodes stored`);
    check("every node holds the best of everything ever sent", wrong, 0);
  }

  console.log("\nunfriending takes the shared progress with it");
  {
    const a = await makeUser("cuta");
    const b = await makeUser("cutb");
    const an = `xa${stamp % 100000}`;
    const bn = `xb${stamp % 100000}`;
    await rpc(a, "claim_username", { new_username: an });
    await rpc(b, "claim_username", { new_username: bn });
    await rpc(a, "request_friend", { their_username: bn });
    await rpc(b, "accept_friend", { their_id: a.id });
    const stats = new Array(32).fill(-1);
    stats[0] = 3;
    await rpc(a, "sync_progress", {
      their_id: b.id, p_stats: stats,
      p_times: new Array(32).fill(0), p_times_str: new Array(32).fill(""),
    });
    check("they have progress",
          (await api(a, "/pair_progress?select=node")).body?.length, 1);

    const lo = a.id < b.id ? a.id : b.id;
    const hi = a.id < b.id ? b.id : a.id;
    await api(a, `/friendships?user_a=eq.${lo}&user_b=eq.${hi}`, { method: "DELETE" });
    check("and none once the friendship is gone",
          (await api(a, "/pair_progress?select=node")).body?.length, 0);
  }

  console.log("\nthe whole surface, to somebody who has not signed in");
  {
    const tables = ["profiles", "friendships", "pair_progress", "solo_progress",
                    "schema_migrations"];
    const seen = [];
    for (const t of tables) {
      const r = await api(null, `/${t}?select=*&limit=1`);
      const rows = Array.isArray(r.body) ? r.body.length : -1;
      if (rows !== 0) seen.push(`${t}:${rows === -1 ? r.status : rows}`);
    }
    check("no table gives up a row", seen, []);

    const writes = [
      ["claim_username", { new_username: `anon${stamp % 10000}` }],
      ["request_friend", { their_username: "anybody" }],
      ["accept_friend", { their_id: users[0].id }],
      ["sync_progress", { their_id: users[0].id, p_stats: new Array(32).fill(3),
                          p_times: new Array(32).fill(30),
                          p_times_str: new Array(32).fill("00:30") }],
      ["remove_friend", { their_id: users[0].id }],
      ["block_friend", { their_id: users[0].id }],
      ["delete_me", {}],
      ["generate_recovery_codes", {}],
      ["redeem_recovery_code", { code: "AAAAA-AAAAA" }],
    ];
    const allowed = [];
    for (const [fn, args] of writes) {
      const r = await rpc(null, fn, args);
      if (r.status < 400) allowed.push(fn);
    }
    check("and no function will act for them", allowed, []);

    const inserted = await api(null, "/profiles", {
      method: "POST",
      body: JSON.stringify({ id: users[0].id, username: `anon${stamp % 10000}` }),
    });
    check("nor can they write a row directly", inserted.status >= 400, true);
  }

  console.log("\nnames that are trying it on");
  {
    const u = await makeUser("odd");
    const bad = ["a'; drop table profiles; --", "ab", "_leading", "trailing_",
                 "sp ace", "twenty_one_chars_long", "emoji" + String.fromCodePoint(0x1f600),
                 "", "with-dash", "sym$bol"];
    const accepted = [];
    for (const name of bad) {
      const r = await rpc(u, "claim_username",
                          { new_username: name });
      if (r.status < 400) accepted.push(name);
    }
    check("every one of them refused", accepted, []);

    // And the table is still there, which is the point of the first one.
    const alive = await api(u, "/profiles?select=id&limit=1");
    check("the profiles table survived", Array.isArray(alive.body), true);
  }
} finally {
  for (const u of users) {
    await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  }
  console.log(`
cleaned up ${users.length} test users`);
}

console.log("\n" + (failures === 0 ? "HARD TEST PASSED"
                                   : `HARD TEST FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
