/**
 * The second factor, proved where it actually has to hold.
 *
 * `auth.ts` shows a code prompt and holds the app at the `locked` stage until
 * it is answered. That is a screen. Supabase issues the session either way --
 * a password sign-in is a perfectly valid `aal1` JWT -- and until 0013 every
 * policy and every security-definer function in the schema authorized on
 * `auth.uid()` alone. So the factor guarded the SPA and nothing underneath it,
 * and a stolen password reached the whole account by skipping the one screen
 * that asked for the code, including `delete_me`.
 *
 * There is no browser in this test on purpose. It enrols a real TOTP factor
 * through the auth API, computes the codes the way an authenticator app does,
 * and then holds TWO tokens for the same account: the `aal1` one from the
 * password sign-in and the `aal2` one the challenge returned. Every assertion
 * below is the same request made with each of them.
 *
 * The one deliberate asymmetry is recovery. `generate_recovery_codes` must be
 * unreachable at `aal1` -- otherwise the codes are a way around the factor
 * rather than a way back to it, which is exactly what 0012 shipped -- and
 * `redeem_recovery_code` must stay reachable at `aal1`, because the person
 * using one is by definition the person who cannot reach `aal2`.
 */
import { createHmac } from "node:crypto";
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

const admin = (path, init = {}) => fetch(`${URL_}${path}`, {
  ...init,
  headers: {
    apikey: SECRET, Authorization: `Bearer ${SECRET}`,
    "content-type": "application/json", ...(init.headers ?? {}),
  },
});

async function as(token, path, init = {}) {
  const r = await fetch(`${URL_}${path}`, {
    ...init,
    headers: {
      apikey: PUB, Authorization: `Bearer ${token}`,
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

const api = (token, path, init) => as(token, `/rest/v1${path}`, init);
const rpc = (token, fn, args) =>
  api(token, `/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

/** Refused, however the refusal is spelled. */
const refused = (r) =>
  r.status >= 400 || (Array.isArray(r.body) && r.body.length === 0);

/** A six-digit code from a TOTP secret, exactly as an authenticator app would. */
function totp(base32, at = Date.now()) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of base32.replace(/=+$/, "")) {
    bits += A.indexOf(c).toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac("sha1", bytes).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3])
            % 1000000;
  return String(n).padStart(6, "0");
}

/** What a JWT says about itself, without verifying it -- this is a readout. */
function claim(token, name) {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString())[name];
}

const stamp = Date.now();
// Before anything is made: whatever a killed run left behind.
// `finally` cannot run when a process is killed, so the only
// reachable place to tidy those away is the start of the next run.
await sweepStaleTestUsers("mfatest");
const users = [];
const codes = [];

async function makeUser(tag) {
  const email = `fbwg_mfa_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_${tag}!A`;
  const created = await (await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  })).json();
  if (!created.id) throw new Error("could not create a user");
  // The secret key, because Supabase lets it past Turnstile and a test
  // cannot solve one.
  const s = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SECRET, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })).json();
  const u = { id: created.id, email, password, token: s.access_token, tag };
  users.push(u);
  return u;
}

/** Enrol a factor and answer it, returning the raised session and the secret. */
async function enrol(user) {
  const enrolled = await as(user.token, "/auth/v1/factors", {
    method: "POST",
    body: JSON.stringify({ factor_type: "totp", friendly_name: `t${stamp}` }),
  });
  const factorId = enrolled.body?.id;
  const secret = enrolled.body?.totp?.secret;
  if (!factorId || !secret) {
    throw new Error("could not enrol: " + JSON.stringify(enrolled.body));
  }
  const challenge = await as(user.token,
    `/auth/v1/factors/${factorId}/challenge`, { method: "POST" });
  const verified = await as(user.token, `/auth/v1/factors/${factorId}/verify`, {
    method: "POST",
    body: JSON.stringify({
      challenge_id: challenge.body?.id, code: totp(secret),
    }),
  });
  if (!verified.body?.access_token) {
    throw new Error("could not verify: " + JSON.stringify(verified.body));
  }
  return { factorId, secret, strong: verified.body.access_token };
}

/**
 * Answer the factor from another session, raising THAT session to aal2.
 *
 * Retried once a TOTP window later, in case the code just used for enrolling
 * is refused as already spent.
 */
async function answer(token, factorId, secret) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 31000));
    const challenge = await as(token, `/auth/v1/factors/${factorId}/challenge`,
                               { method: "POST" });
    const verified = await as(token, `/auth/v1/factors/${factorId}/verify`, {
      method: "POST",
      body: JSON.stringify({ challenge_id: challenge.body?.id, code: totp(secret) }),
    });
    if (verified.body?.access_token) {
      return { token: verified.body.access_token,
               refresh: verified.body.refresh_token };
    }
  }
  throw new Error("could not answer the factor from a second session");
}

/** Another password sign-in: a second, separate `aal1` session. */
async function signInAgain(user) {
  // The secret key, because Supabase lets it past Turnstile and a test
  // cannot solve one.
  return (await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SECRET, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  })).json()).access_token;
}

try {
  console.log("one account, one factor, and two tokens for it");
  const me = await makeUser("me");
  const friend = await makeUser("friend");
  const name = `mfa${stamp % 100000}`;
  const fname = `fri${stamp % 100000}`;
  await rpc(me.token, "claim_username",
            { new_username: name });
  await rpc(friend.token, "claim_username",
            { new_username: fname });
  await rpc(me.token, "request_friend", { their_username: fname });
  await rpc(friend.token, "accept_friend", { their_id: me.id });

  const weak = me.token;                       // the password sign-in
  // The answered challenge. NB: answering it raises the session it was asked
  // from, so `weak` and `strong` are two tokens for ONE session -- which is
  // why the checks against GoTrue below sign in afresh.
  const { strong, factorId, secret } = await enrol(me);

  check("the password session is aal1", claim(weak, "aal"), "aal1");
  check("and the answered one is aal2", claim(strong, "aal"), "aal2");

  const [lo, hi] = me.id < friend.id ? [me.id, friend.id] : [friend.id, me.id];
  const topic = "pair:" + (await (await admin(
    `/rest/v1/friendships?select=channel&user_a=eq.${lo}&user_b=eq.${hi}`)).json())[0]?.channel;

  console.log("\nwhat the aal1 token can still do, now that a factor exists");
  {
    // Every one of these worked before 0013, which is what made the code
    // prompt decoration: the attacker never loads the page.
    check("read the user directory",
          (await api(weak, "/profiles?select=id")).body?.length, 0);
    check("read its own friendships",
          (await api(weak, "/friendships?select=status")).body?.length, 0);
    check("read the pair's progress",
          (await api(weak, "/pair_progress?select=node")).body?.length, 0);
    check("rename the account",
          refused(await rpc(weak, "claim_username", { new_username: name + "x" })),
          true);
    check("ask somebody to be a friend",
          refused(await rpc(weak, "request_friend", { their_username: fname })),
          true);
    check("write the pair's progress",
          refused(await rpc(weak, "sync_progress", {
            their_id: friend.id,
            p_stats: new Array(32).fill(3),
            p_times: new Array(32).fill(30),
            p_times_str: new Array(32).fill("00:30"),
          })), true);
    check("turn its leaderboard entry off",
          refused(await api(weak, `/profiles?id=eq.${me.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hide_from_leaderboard: true }),
          })), true);
    check("read the board",
          (await rpc(weak, "leaderboard", { p_node: 1 })).body?.length ?? 0, 0);
    check("join the pair's private Realtime topic",
          (await rpc(weak, "can_use_pair_topic", { topic })).body, false);
    check("delete the account",
          refused(await rpc(weak, "delete_me", {})), true);
    check("mint recovery codes",
          refused(await rpc(weak, "generate_recovery_codes", {})), true);

    // Not Postgres: GoTrue's own user endpoint, which no policy here reaches.
    // GoTrue refuses with `insufficient_aal` -- and pinned so an upgrade that
    // stops doing so is a failure rather than a surprise. Changing the address
    // is how an account is taken over, because the address is where password
    // resets go.
    //
    // From a FRESH password session. GoTrue reads the assurance level from the
    // session row, not from the token, and `weak`'s session was raised to aal2
    // when the factor was answered from it -- so `weak` would be let through,
    // and a run against a stack that does let it through changes the password
    // every test after this one signs in with.
    const fresh = await signInAgain(me);
    const pw = await as(fresh, "/auth/v1/user", {
      method: "PUT", body: JSON.stringify({ password: `${me.password}x` }),
    });
    check("change the password",
          [pw.status, pw.body?.error_code], [401, "insufficient_aal"]);
    const mail = await as(fresh, "/auth/v1/user", {
      method: "PUT", body: JSON.stringify({ email: `moved_${me.email}` }),
    });
    check("move the account to another address",
          [mail.status, mail.body?.error_code], [401, "insufficient_aal"]);
  }

  console.log("\nand what the aal2 token does instead");
  {
    check("reads the directory",
          (await api(strong, `/profiles?username=eq.${fname}&select=id`))
            .body?.length, 1);
    check("reads its friendships",
          (await api(strong, "/friendships?select=status")).body?.[0]?.status,
          "accepted");
    check("writes the pair's progress",
          (await rpc(strong, "sync_progress", {
            their_id: friend.id,
            p_stats: [3, ...new Array(31).fill(-1)],
            p_times: [44, ...new Array(31).fill(0)],
            p_times_str: ["00:44", ...new Array(31).fill("")],
          })).body, 1);
    check("and reads it back",
          (await api(strong, "/pair_progress?node=eq.1&select=best_time_s"))
            .body?.[0]?.best_time_s, 44);
    check("joins the pair's topic",
          (await rpc(strong, "can_use_pair_topic", { topic })).body, true);
  }

  console.log("\na signed-out session cannot reach recovery");
  {
    // Its token outlives the session by up to an hour. The recovery functions
    // used to read only the token, so a thief kept after "sign out everywhere"
    // could mint codes, spend one and take the factor off.
    const ended = await answer(await signInAgain(me), factorId, secret);
    await fetch(`${URL_}/auth/v1/logout?scope=local`, {
      method: "POST", headers: { apikey: PUB, Authorization: `Bearer ${ended.token}` },
    });
    check("its aal2 token cannot mint codes",
          refused(await rpc(ended.token, "generate_recovery_codes", {})), true);
    check("nor spend one",
          refused(await rpc(ended.token, "redeem_recovery_code", { code: "AAAAA-AAAAA" })), true);
  }

  console.log("\nrecovery is minted strong and spent weak");
  let recovery = [];
  {
    const minted = await rpc(strong, "generate_recovery_codes", {});
    recovery = minted.body ?? [];
    check("ten codes are issued to the session that answered the factor",
          recovery.length, 10);
    check("and they are shaped to be read aloud",
          /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(recovery[0] ?? ""), true);
    check("all ten of them different", new Set(recovery).size, 10);
    check("the count agrees",
          (await rpc(strong, "recovery_codes_left", {})).body, 10);
    check("the hashes are not readable even by their owner",
          (await api(strong, "/mfa_recovery_codes?select=code_hash")).body?.length
            ?? 0, 0);

    check("somebody else's code is refused",
          (await rpc(friend.token, "redeem_recovery_code", { code: recovery[0] }))
            .body, false);
    check("a wrong one is refused",
          (await rpc(weak, "redeem_recovery_code", { code: "AAAAA-AAAAA" })).body,
          false);

    // A second password session, parked at the code prompt somewhere else.
    // Before 20261005010000 it was promoted to the whole account the moment
    // the factor went, without anybody signing in again.
    const parked = await signInAgain(me);
    // And a third that answered the factor -- the lost phone. Its own
    // session, unlike `strong`, which shares `weak`'s.
    const phone = await answer(await signInAgain(me), factorId, secret);

    // The whole point: the person using this cannot reach aal2, because the
    // authenticator is what they lost.
    check("the real one is accepted from the weak session",
          (await rpc(weak, "redeem_recovery_code", { code: recovery[0] })).body,
          true);
    check("and takes the factor with it",
          (await as(weak, "/auth/v1/factors")).body?.totp?.length ?? 0, 0);
    check("along with the nine spare keys to a lock that is gone",
          (await rpc(weak, "recovery_codes_left", {})).body, 0);
    check("so the same code cannot be used twice",
          (await rpc(weak, "redeem_recovery_code", { code: recovery[0] })).body,
          false);

    // Recovery is what you do when the authenticator is lost -- usually with
    // the phone it was on, which is signed in. Every other session ends.
    check("the parked session is not promoted, it is ended",
          (await api(parked, `/profiles?id=eq.${me.id}&select=id`)).body?.length, 0);
    check("so is the aal2 session from before, though its token has not expired",
          (await api(phone.token, `/profiles?id=eq.${me.id}&select=id`)).body?.length, 0);
    const renewed = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: PUB, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: phone.refresh }),
    });
    check("and it cannot be renewed", renewed.status >= 400, true);
  }

  console.log("\nwith no factor enrolled, the aal1 session is the whole account");
  {
    // The other half of the rule, and the reason it is not simply "require
    // aal2": somebody who never opted in must not be locked out by a check
    // meant for somebody who did.
    check("it reads the directory again",
          (await api(weak, `/profiles?username=eq.${fname}&select=id`))
            .body?.length, 1);
    check("and its own progress",
          (await api(weak, "/pair_progress?node=eq.1&select=best_time_s"))
            .body?.[0]?.best_time_s, 44);
    check("and cannot mint codes for a factor that no longer exists",
          refused(await rpc(weak, "generate_recovery_codes", {})), true);
  }

  console.log("\nand guessing is not a strategy");
  {
    // Fifty bits is why this table needs no attempt counter. The counter is
    // there anyway, because an endpoint that answers as fast as it is asked is
    // worth slowing down whatever the arithmetic says.
    // A fresh account, because both of the others have already spent attempts
    // above -- a successful redemption clears the record, but the wrong guesses
    // around it are still on it, and a throttle test that starts from an
    // unknown count is a test of nothing.
    const guesser = await makeUser("guesser");
    const tried = [];
    for (let i = 0; i < 6; i++) {
      const r = await rpc(guesser.token, "redeem_recovery_code",
                          { code: `ZZZZ${i}-ZZZZZ` });
      tried.push(r.status >= 400 ? "refused" : r.body);
    }
    check("five wrong answers are answered, the sixth is not",
          tried, [false, false, false, false, false, "refused"]);
  }
} finally {
  for (const u of users) {
    await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  }
  console.log(`\ncleaned up ${users.length} test users and ${codes.length} codes`);
}

console.log("\n" + (failures === 0 ? "MFA PASSED" : `MFA FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
