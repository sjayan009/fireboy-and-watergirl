/**
 * Private Realtime channels, proved by trying to get into one.
 *
 * Row level security over `realtime.messages` is what makes a channel private,
 * and it is easy to believe you have it when you do not: the failure mode is a
 * channel that anybody who guesses its name can join and sit in, watching two
 * people's presence and invitations go past. Reading the policy will not tell
 * you whether that is true. Joining will.
 *
 * So this signs three real users in, makes two of them friends, and has all
 * three attempt the pair's topic over a real websocket.
 */
import { createClient } from "@supabase/supabase-js";
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

const stamp = Date.now();
const users = [];
const codes = [];

const admin = (path, init = {}) => fetch(`${URL_}${path}`, {
  ...init,
  headers: {
    apikey: SECRET, Authorization: `Bearer ${SECRET}`,
    "content-type": "application/json", ...(init.headers ?? {}),
  },
});

const rpc = (user, fn, args) => fetch(`${URL_}/rest/v1/rpc/${fn}`, {
  method: "POST",
  headers: {
    apikey: PUB, Authorization: `Bearer ${user.token}`,
    "content-type": "application/json", Prefer: "return=representation",
  },
  body: JSON.stringify(args),
}).then(async (r) => ({ status: r.status, body: await r.text() }));

async function makeUser(tag) {
  const email = `fbwg_rt_${tag}_${stamp}@example.com`;
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

async function makeCode() {
  const code = `RTTEST-${stamp}-${codes.length}`;
  await admin("/rest/v1/invite_codes", {
    method: "POST",
    body: JSON.stringify({ code, max_uses: 1, note: "realtimetest" }),
  });
  codes.push(code);
  return code;
}

/** The pair topic for two ids, in the order `friendships` stores them. */
const topicFor = (a, b) =>
  `pair:${a < b ? a : b}:${a < b ? b : a}`;

/**
 * Try to join a topic, and say what happened.
 *
 * A refusal arrives as CHANNEL_ERROR carrying "You do not have permissions to
 * read from this Channel topic", not as a thrown error, and a channel nobody is
 * allowed into can also simply never come up -- so the timeout is a real
 * outcome and is reported as one rather than hanging.
 */
async function join(user, topic, timeoutMs = 10000) {
  const client = createClient(URL_, PUB);
  // Awaited, and that matters: `setAuth` is asynchronous, and subscribing
  // before it has settled joins the socket with the anon key instead of the
  // user's token. The channel is then refused for the right reason at the wrong
  // moment, which reads exactly like a policy that does not work.
  await client.realtime.setAuth(user.token);
  return new Promise((resolve) => {
    const channel = client.channel(topic, { config: { private: true } });
    // The latch is load-bearing. Tearing the client down fires CLOSED
    // synchronously, which re-enters this callback -- so an unguarded version
    // that cleaned up before resolving would settle on the CLOSED that its own
    // success caused, and report every successful join as a refusal.
    let settled = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(verdict);
      try { client.removeAllChannels(); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => finish("timed out"), timeoutMs);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") finish("in");
      else if (status === "CHANNEL_ERROR" || status === "CLOSED") finish("refused");
    });
  });
}

try {
  console.log("three users, two of them friends");
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const mallory = await makeUser("mallory");

  const an = `rta${stamp % 100000}`;
  const bn = `rtb${stamp % 100000}`;
  const mn = `rtm${stamp % 100000}`;
  for (const [u, n] of [[alice, an], [bob, bn], [mallory, mn]]) {
    await rpc(u, "claim_username",
              { new_username: n, invite_code: await makeCode() });
  }
  console.log("\na pending request opens nothing");
  // Deliberately a DIFFERENT pair from the one tested below. Realtime caches
  // its authorization decision per topic for a while, so a peer refused while a
  // request was still pending stays refused for a bit after it is accepted --
  // and reusing one pair for both halves of this test makes a working policy
  // look broken. The same caching means REVOKING access is not instant either,
  // which is worth knowing before relying on unfriending to lock somebody out.
  await rpc(alice, "request_friend", { their_username: mn });
  check("neither side may use it",
        await join(alice, topicFor(alice.id, mallory.id)), "refused");

  console.log("\nan accepted one opens exactly one channel");
  await rpc(alice, "request_friend", { their_username: bn });
  const accepted = await rpc(bob, "accept_friend", { their_id: alice.id });
  check("bob accepts", accepted.status, 200);

  const pair = topicFor(alice.id, bob.id);
  check("alice is let in", await join(alice, pair), "in");
  check("so is bob", await join(bob, pair), "in");

  console.log("\nand a stranger who knows the name exactly is not");
  check("mallory is refused", await join(mallory, pair), "refused");

  console.log("\nand the channel actually carries a message between them");
  const listener = createClient(URL_, PUB);
  await listener.realtime.setAuth(bob.token);
  const heard = new Promise((resolve) => {
    const client = listener;
    const channel = client.channel(pair, { config: { private: true } });
    const timer = setTimeout(() => resolve(null), 10000);
    channel.on("broadcast", { event: "invite" }, ({ payload }) => {
      clearTimeout(timer);
      try { client.removeAllChannels(); } catch { /* gone */ }
      resolve(payload);
    });
    channel.subscribe(async (status) => {
      if (status !== "SUBSCRIBED") return;
      const sender = createClient(URL_, PUB);
      await sender.realtime.setAuth(alice.token);
      const out = sender.channel(pair, { config: { private: true } });
      out.subscribe(async (s) => {
        if (s !== "SUBSCRIBED") return;
        await out.send({
          type: "broadcast", event: "invite",
          payload: { mode: "adventure", num: 1, fireboy: alice.id },
        });
      });
    });
  });
  const payload = await heard;
  check("bob receives alice's invite", payload?.num, 1);
  check("carrying the role assignment", payload?.fireboy, alice.id);

  console.log("\nwatching is a second topic, with a wider door");
  {
    // The pair topic stays exactly as private as the checks above found it.
    // `watch:<lo>:<hi>` is the one a spectator uses, and it carries a copy of
    // the input the two are already exchanging -- the game, and nothing about
    // their presence, their invitations or their signalling.
    const watch = "watch:" + [alice.id, bob.id].sort().join(":");

    // Carol knows nobody. She is the case the whole policy exists for.
    const carol = await makeUser("carol");
    await rpc(carol, "claim_username",
              { new_username: "car" + stamp % 100000, invite_code: await makeCode() });
    check("somebody who knows neither player is refused",
          await join(carol, watch), "refused");

    // Mallory is friends with alice and not with bob, which is the rule:
    // friends of EITHER player may watch.
    await rpc(mallory, "accept_friend", { their_id: alice.id });
    check("a friend of one of them is let in", await join(mallory, watch), "in");
    check("and so are the two playing", await join(bob, watch), "in");

    // End to end, because a policy that admits a reader and refuses the writer
    // is a channel that carries nothing.
    const eyes = createClient(URL_, PUB);
    await eyes.realtime.setAuth(mallory.token);
    const saw = await new Promise((resolve) => {
      const channel = eyes.channel(watch, { config: { private: true } });
      const timer = setTimeout(() => resolve(null), 10000);
      channel.on("broadcast", { event: "b" }, ({ payload }) => {
        clearTimeout(timer);
        try { eyes.removeAllChannels(); } catch { /* gone */ }
        resolve(payload);
      });
      channel.subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;
        const feed = createClient(URL_, PUB);
        await feed.realtime.setAuth(alice.token);
        const out = feed.channel(watch, { config: { private: true } });
        out.subscribe(async (s) => {
          if (s !== "SUBSCRIBED") return;
          await out.send({ type: "broadcast", event: "b", payload: { p: ["AQ=="] } });
        });
      });
    });
    check("and a watcher receives what the players put on it",
          saw?.p?.[0], "AQ==");
  }
} finally {
  for (const u of users) {
    await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  }
  await admin("/rest/v1/invite_codes?note=eq.realtimetest", { method: "DELETE" });
  console.log(`\ncleaned up ${users.length} test users`);
}

console.log("\n" + (failures === 0
  ? "REALTIME PASSED"
  : `REALTIME FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
