/**
 * The support email function: who can make it send, and how often.
 *
 * Loaded the way test/turn-credentials.mjs loads its handler -- transpiled
 * from the Edge Function's own source, with every outside call stood in for.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../supabase/functions/support-ticket/handler.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { createSupportHandler, ticketMail, KEEP_DAYS } =
  await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

const env = { BREVO_API_KEY: "fake-test-only-key", SUPPORT_EMAIL_TO: "dev@example.com",
  SUPPORT_EMAIL_FROM: "support@example.com", TURN_ALLOWED_ORIGINS: "https://game.example" };
const tickets = new Map([
  [1, { id: 1, user_id: "user-a", message: "Door <script>alert(1)</script> stuck", created_at: "2026-10-18T00:00:00Z",
        emailed_at: null, username: "fireboy_a", attachments: [{ path: "user-a/x/1-shot.png", name: "shot.png", bytes: 2048 }] }],
  [2, { id: 2, user_id: "user-b", message: "Somebody else's", created_at: "2026-10-18T00:00:00Z",
        emailed_at: null, username: "watergirl_b", attachments: [] }],
]);
const sent = [];
let purged = 0;
const handler = createSupportHandler({
  env: (k) => env[k],
  verifyUser: async (token) => token === "token-a" ? { id: "user-a", email: "a@example.com" } : null,
  ticket: async (id) => tickets.get(id) ?? null,
  links: async (paths) => paths.map((p) => `https://signed.example/${p}`),
  send: async (mail, key) => { assert.equal(key, "fake-test-only-key"); sent.push(mail); return true; },
  markEmailed: async (id) => { tickets.get(id).emailed_at = "now"; },
  purgeOlderThan: async (days) => { assert.equal(days, 90); purged++; },
});
const call = (body, token = "token-a", origin = "https://game.example") => handler(new Request("https://p.supabase.co/functions/v1/support-ticket", {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
}));

assert.equal((await call({ ticket: 1 }, null)).status, 401, "no token, no mail");
assert.equal((await call({ ticket: 1 }, "forged")).status, 401, "a token Supabase does not vouch for, no mail");
assert.equal((await call({ ticket: 1 }, "token-a", "https://evil.example")).status, 403, "another site cannot call it");
assert.equal((await call({ ticket: 2 })).status, 404, "somebody else's ticket reads as no ticket");
assert.equal((await call({ ticket: "1; drop" })).status, 400, "a ticket number is a number");
assert.equal(sent.length, 0);

const first = await call({ ticket: 1 });
assert.equal(first.status, 200);
assert.equal(sent.length, 1, "the owner's ticket is mailed");
assert.equal(sent[0].to, "dev@example.com");
assert.equal(sent[0].replyTo, "a@example.com", "a reply goes to the player");
assert.equal(sent[0].subject, "Support #1 from fireboy_a");
assert.ok(!sent[0].html.includes("<script>"), "the message is escaped");
assert.ok(sent[0].html.includes("https://signed.example/user-a/x/1-shot.png"), "attachments go as signed links");
assert.equal(purged, 1, "old attachments are cleared on the way");

assert.equal((await call({ ticket: 1 })).status, 200);
assert.equal(sent.length, 1, "a ticket is mailed once, however often it is asked");

delete env.BREVO_API_KEY;
tickets.get(1).emailed_at = null;
assert.equal((await call({ ticket: 1 })).status, 503, "without a key it says so, and sends nothing");
assert.equal(sent.length, 1);
assert.equal(KEEP_DAYS, 90);
assert.ok(ticketMail(tickets.get(2), undefined, []).html.includes("watergirl_b"));
console.log("SUPPORT TICKET FUNCTION PASSED");
