/**
 * Does solo progress now belong to the account?
 *
 * Three questions, in the order they matter:
 *   1. does the merge keep the best of both, and refuse nonsense;
 *   2. can one account read another's;
 *   3. does deleting the account take it.
 */
import { env } from "./connect.mjs";

const e = env();
const API = e.SUPABASE_URL, PUB = e.SUPABASE_PUBLISHABLE_KEY, S = e.SUPABASE_SECRET_KEY;
const h = { apikey: S, Authorization: `Bearer ${S}`, "content-type": "application/json" };
const stamp = Date.now();
let failures = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` + (ok ? "" : ` (expected ${JSON.stringify(want)})`));
};

async function makePlayer(tag) {
  const email = `solo_${tag}_${stamp}@example.com`, password = `Solo_${stamp}_${tag}!A`;
  const u = await (await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST", headers: h,
    body: JSON.stringify({ email, password, email_confirm: true }),
  })).json();
  const t = await (await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: PUB, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })).json();
  // A profile, because `assert_allowed` wants one.
  await fetch(`${API}/rest/v1/rpc/claim_username`, {
    method: "POST",
    headers: { apikey: PUB, Authorization: `Bearer ${t.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ new_username: `solo${tag}${stamp % 100000}` }),
  });
  return { id: u.id, email, token: t.access_token };
}

const rpc = (who, fn, args) => fetch(`${API}/rest/v1/rpc/${fn}`, {
  method: "POST",
  headers: { apikey: PUB, Authorization: `Bearer ${who.token}`, "content-type": "application/json" },
  body: JSON.stringify(args),
});

const arr = (pairs) => {
  const stats = new Array(32).fill(-1), times = new Array(32).fill(0);
  for (const [n, medal, secs] of pairs) { stats[n - 1] = medal; times[n - 1] = secs ?? 0; }
  return { p_stats: stats, p_times: times };
};

const a = await makePlayer("a");
const b = await makePlayer("b");

console.log("the merge keeps the best of both");
{
  // Node 2: silver in 90s. Node 3: reached, not finished.
  let r = await rpc(a, "sync_solo_progress", arr([[2, 2, 90], [3, 0, 0]]));
  let rows = await r.json();
  check("first sync returns what was stored", rows.length, 2);
  check("a finished node keeps its time",
        rows.find((x) => x.node === 2).best_time_s, 90);
  check("an unfinished node carries none",
        rows.find((x) => x.node === 3).best_time_s, null);

  // A worse medal and a slower time must not win.
  rows = await (await rpc(a, "sync_solo_progress", arr([[2, 1, 200]]))).json();
  const n2 = rows.find((x) => x.node === 2);
  check("a worse medal does not overwrite", n2.medal, 2);
  check("nor a slower time", n2.best_time_s, 90);

  // A better one does.
  rows = await (await rpc(a, "sync_solo_progress", arr([[2, 3, 45]]))).json();
  const better = rows.find((x) => x.node === 2);
  check("a better medal wins", better.medal, 3);
  check("and a faster time wins", better.best_time_s, 45);

  // -1 is the absence of progress, not progress.
  rows = await (await rpc(a, "sync_solo_progress", arr([[2, -1, 0]]))).json();
  check("a locked node cannot close an open one",
        rows.find((x) => x.node === 2).medal, 3);

  const bad = await rpc(a, "sync_solo_progress", arr([[4, 9, 10]]));
  check("an impossible medal is refused", bad.status >= 400, true);
  const silly = await rpc(a, "sync_solo_progress", arr([[4, 3, 1]]));
  check("and a time no timer produces", silly.status >= 400, true);
}

console.log("\nand it is nobody else's business");
{
  const mine = await (await fetch(`${API}/rest/v1/solo_progress?select=node,medal`, {
    headers: { apikey: PUB, Authorization: `Bearer ${a.token}` },
  })).json();
  check("the owner reads their own rows", mine.length > 0, true);

  const theirs = await (await fetch(`${API}/rest/v1/solo_progress?select=node,medal`, {
    headers: { apikey: PUB, Authorization: `Bearer ${b.token}` },
  })).json();
  check("another account sees none of it", theirs.length, 0);

  const write = await fetch(`${API}/rest/v1/solo_progress`, {
    method: "POST",
    headers: { apikey: PUB, Authorization: `Bearer ${b.token}`, "content-type": "application/json" },
    body: JSON.stringify({ user_id: a.id, node: 9, medal: 3 }),
  });
  check("and cannot write a row into it", write.ok, false);

  const anon = await fetch(`${API}/rest/v1/solo_progress?select=node`, { headers: { apikey: PUB } });
  const anonRows = await anon.json();
  check("signed out, nothing at all",
        Array.isArray(anonRows) ? anonRows.length : anon.status, 0);
}

console.log("\nand deleting the account takes it");
{
  await fetch(`${API}/auth/v1/admin/users/${a.id}`, { method: "DELETE", headers: h });
  const left = await (await fetch(
    `${API}/rest/v1/solo_progress?user_id=eq.${a.id}&select=node`, { headers: h })).json();
  check("no rows survive the account", left.length, 0);
}

await fetch(`${API}/auth/v1/admin/users/${b.id}`, { method: "DELETE", headers: h });
console.log("\n" + (failures === 0 ? "SOLO PROGRESS PASSED" : `SOLO PROGRESS FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
