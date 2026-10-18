/**
 * Support tickets: only your own, only when fully signed in, and bounded.
 *
 *   1. a player files a ticket with attachments and reads it back;
 *   2. nobody else -- another player, a signed-out caller, an account with no
 *      username -- can read it, file one, or name its files;
 *   3. the limits hold: 10 MB a ticket, three a day, no direct writes;
 *   4. moving the stage stamps the dates, and deleting keeps the ticket.
 */
import { env, open } from "./connect.mjs";
import { sweepStaleTestUsers } from "./sweep.mjs";

const e = env();
const API = e.SUPABASE_URL, PUB = e.SUPABASE_PUBLISHABLE_KEY, S = e.SUPABASE_SECRET_KEY;
const h = { apikey: S, Authorization: `Bearer ${S}`, "content-type": "application/json" };
const stamp = Date.now();
await sweepStaleTestUsers("supporttest", "support_");
let failures = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` + (ok ? "" : ` (expected ${JSON.stringify(want)})`));
};
const made = [];

async function makePlayer(tag, named = true) {
  const email = `support_${tag}_${stamp}@example.com`, password = `Support_${stamp}_${tag}!A`;
  const u = await (await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST", headers: h, body: JSON.stringify({ email, password, email_confirm: true }),
  })).json();
  made.push(u.id);
  // The secret key, because Supabase lets it past Turnstile and a test cannot solve one.
  const t = await (await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: S, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })).json();
  if (named) {
    await fetch(`${API}/rest/v1/rpc/claim_username`, {
      method: "POST", headers: { apikey: PUB, Authorization: `Bearer ${t.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ new_username: `sup${tag}${stamp % 100000}` }),
    });
  }
  return { id: u.id, token: t.access_token };
}

const as = (who) => ({ apikey: PUB, ...(who ? { Authorization: `Bearer ${who.token}` } : {}) });
const rpc = (who, fn, args) => fetch(`${API}/rest/v1/rpc/${fn}`, {
  method: "POST", headers: { ...as(who), "content-type": "application/json" }, body: JSON.stringify(args),
});
const upload = (who, path, bytes) => fetch(`${API}/storage/v1/object/support-attachments/${path}`, {
  method: "POST", headers: { ...as(who), "content-type": "application/octet-stream" }, body: new Uint8Array(bytes),
});
const MB = 1024 * 1024;

const a = await makePlayer("a");
const b = await makePlayer("b");
const nameless = await makePlayer("n", false);

try {
  console.log("a player files a ticket and reads it back");
  const shot = `${a.id}/t1/1-shot.png`;
  check("an upload into your own folder is taken", (await upload(a, shot, 2048)).ok, true);
  const filed = await rpc(a, "submit_ticket", { message: "The fire door on level 12 stays shut.", paths: [shot] });
  const id = await filed.json();
  check("the ticket is filed", filed.ok && Number.isInteger(id), true);
  const mine = await (await fetch(`${API}/rest/v1/support_tickets?select=id,stage,attachments`, { headers: as(a) })).json();
  check("and read back, with its attachment by name and real size",
        [mine.length, mine[0]?.stage, mine[0]?.attachments?.[0]?.name, mine[0]?.attachments?.[0]?.bytes], [1, "sent", "shot.png", 2048]);

  console.log("\nnobody else can reach it");
  const theirs = await (await fetch(`${API}/rest/v1/support_tickets?select=id`, { headers: as(b) })).json();
  check("another player sees none of it", theirs.length, 0);
  const anon = await (await fetch(`${API}/rest/v1/support_tickets?select=id`, { headers: as(null) })).json();
  check("a signed-out caller sees none of it", Array.isArray(anon) ? anon.length : "refused", Array.isArray(anon) ? 0 : "refused");
  check("a signed-out caller cannot file one", (await rpc(null, "submit_ticket", { message: "hello from nowhere", paths: [] })).ok, false);
  check("nor an account with no username", (await rpc(nameless, "submit_ticket", { message: "I have no name yet", paths: [] })).ok, false);
  check("another player cannot upload into this folder", (await upload(b, `${a.id}/t9/x.png`, 10)).ok, false);
  check("nor read this player's file", (await fetch(`${API}/storage/v1/object/support-attachments/${shot}`, { headers: as(b) })).ok, false);
  check("nor attach it to a ticket of their own",
        (await rpc(b, "submit_ticket", { message: "stealing a screenshot", paths: [shot] })).ok, false);
  check("nor delete this ticket", (await rpc(b, "delete_ticket", { ticket: id })).ok, false);
  const direct = await fetch(`${API}/rest/v1/support_tickets?id=eq.${id}`, {
    method: "PATCH", headers: { ...as(a), "content-type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ stage: "fixed" }) });
  const changed = direct.ok ? (await direct.json()).length : 0;
  check("and its owner cannot mark it fixed themselves", changed, 0);

  console.log("\nthe limits hold");
  check("one file over 10 MB is refused by the bucket", (await upload(b, `${b.id}/big/1-big.bin`, 10 * MB + 1)).ok, false);
  await upload(b, `${b.id}/two/1-a.bin`, 6 * MB);
  await upload(b, `${b.id}/two/2-b.bin`, 6 * MB);
  check("files adding up past 10 MB are refused at filing",
        (await rpc(b, "submit_ticket", { message: "twelve megabytes of logs", paths: [`${b.id}/two/1-a.bin`, `${b.id}/two/2-b.bin`] })).ok, false);
  check("a message under ten characters is refused", (await rpc(b, "submit_ticket", { message: "help", paths: [] })).ok, false);
  for (let i = 0; i < 3; i++) await rpc(b, "submit_ticket", { message: `ticket number ${i} of the day`, paths: [] });
  const fourth = await rpc(b, "submit_ticket", { message: "a fourth ticket today", paths: [] });
  check("a fourth ticket in a day is refused", [fourth.ok, (await fourth.json()).code], [false, "53400"]);
  await upload(b, `${b.id}/more/1-c.bin`, 9 * MB);
  await upload(b, `${b.id}/more/2-d.bin`, 9 * MB);
  check("uploads stop at 30 MB a day even with no ticket", (await upload(b, `${b.id}/more/3-e.bin`, 1 * MB)).ok, false);

  console.log("\nthe support admin, and nobody else");
  const boss = await makePlayer("admin");
  check("a player is not an admin", await (await rpc(a, "is_support_admin", {})).json(), false);
  check("and cannot list every ticket", (await rpc(a, "admin_tickets", {})).ok, false);
  check("nor move one", (await rpc(b, "admin_set_ticket_stage", { ticket: id, new_stage: "fixed" })).ok, false);
  // Made an admin the only way there is: a row, by hand, in play_private.
  const db = await open({ quiet: true });
  try {
    await db.query("insert into play_private.support_admins (user_id) values ($1) on conflict do nothing", [boss.id]);
  } finally {
    await db.end();
  }
  check("a listed account is an admin", await (await rpc(boss, "is_support_admin", {})).json(), true);
  const all = await (await rpc(boss, "admin_tickets", {})).json();
  const seen = Array.isArray(all) ? all.find((t) => t.id === id) : null;
  check("and sees another player's ticket, with who sent it",
        [!!seen, seen?.email?.startsWith("support_a_"), typeof seen?.username], [true, true, "string"]);
  check("and can open its attachment",
        (await fetch(`${API}/storage/v1/object/support-attachments/${shot}`, { headers: as(boss) })).ok, true);
  check("and move it in one call", (await rpc(boss, "admin_set_ticket_stage", { ticket: id, new_stage: "in_progress" })).ok, true);
  check("but only to a real stage", (await rpc(boss, "admin_set_ticket_stage", { ticket: id, new_stage: "teleported" })).ok, false);
  await rpc(boss, "admin_set_ticket_stage", { ticket: id, new_stage: "reviewed" });
  const back = (await (await fetch(`${API}/rest/v1/support_tickets?id=eq.${id}&select=stage,reviewed_at,in_progress_at`, { headers: as(a) })).json())[0];
  check("moving back clears the later step", [back.stage, !!back.reviewed_at, back.in_progress_at], ["reviewed", true, null]);

  console.log("\nthe stage, and deleting");
  await fetch(`${API}/rest/v1/support_tickets?id=eq.${id}`, {
    method: "PATCH", headers: { ...h, Prefer: "return=minimal" }, body: JSON.stringify({ stage: "fixed" }) });
  const moved = (await (await fetch(`${API}/rest/v1/support_tickets?id=eq.${id}&select=reviewed_at,in_progress_at,fixed_at`, { headers: as(a) })).json())[0];
  check("jumping to fixed stamps every step on the way", [!!moved.reviewed_at, !!moved.in_progress_at, !!moved.fixed_at], [true, true, true]);
  check("its owner can delete it", (await rpc(a, "delete_ticket", { ticket: id })).ok, true);
  const kept = (await (await fetch(`${API}/rest/v1/support_tickets?id=eq.${id}&select=deleted_at`, { headers: as(a) })).json())[0];
  check("and it is kept, as deleted", !!kept?.deleted_at, true);
} catch (err) {
  failures++;
  console.log("  FAIL " + err.message);
} finally {
  for (const id of made) {
    const files = await (await fetch(`${API}/storage/v1/object/list/support-attachments`, {
      method: "POST", headers: h, body: JSON.stringify({ prefix: id, limit: 100 }) })).json().catch(() => []);
    for (const folder of Array.isArray(files) ? files : []) {
      const inner = await (await fetch(`${API}/storage/v1/object/list/support-attachments`, {
        method: "POST", headers: h, body: JSON.stringify({ prefix: `${id}/${folder.name}`, limit: 100 }) })).json().catch(() => []);
      const prefixes = (Array.isArray(inner) ? inner : []).map((f) => `${id}/${folder.name}/${f.name}`);
      if (prefixes.length) await fetch(`${API}/storage/v1/object/support-attachments`, {
        method: "DELETE", headers: h, body: JSON.stringify({ prefixes }) });
    }
    await fetch(`${API}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: h });
  }
}
console.log("\n" + (failures === 0 ? "SUPPORT PASSED" : `SUPPORT FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
