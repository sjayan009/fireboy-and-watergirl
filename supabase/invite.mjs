/**
 * Mint invite codes.
 *
 *   npm run invite                    one code, one use
 *   npm run invite -- --uses 5        one code, five uses
 *   npm run invite -- --days 7        expires in a week
 *   npm run invite -- --note "jayan"  a reminder of who it was for
 *   npm run invite -- --list          what exists and how used up it is
 *
 * Runs against the database directly, because `invite_codes` has no row level
 * security policies at all -- deliberately, so a signed-in user can neither
 * enumerate codes nor reset their use counts. That makes this script, holding
 * the secret credentials, the only way in.
 */
import { randomBytes } from "node:crypto";
import { open } from "./connect.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const has = (name) => args.includes("--" + name);

/**
 * Codes are read aloud and typed in by hand, so the alphabet leaves out the
 * characters people confuse: no O/0, no I/1/l.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function mint() {
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) {
    if (i === 4 || i === 8) out += "-";
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

const client = await open();
try {
  if (has("list")) {
    const r = await client.query(`
      select code, note, uses, max_uses, expires_at
        from public.invite_codes order by created_at desc limit 50`);
    if (r.rows.length === 0) {
      console.log("no invite codes yet");
    } else {
      for (const c of r.rows) {
        const spent = c.uses >= c.max_uses;
        const dead = c.expires_at && new Date(c.expires_at) < new Date();
        console.log(
          `  ${c.code}  ${c.uses}/${c.max_uses}` +
          `${spent ? " spent" : dead ? " expired" : ""}` +
          `${c.note ? "  " + c.note : ""}`);
      }
    }
  } else {
    const uses = Number(flag("uses", 1));
    const days = flag("days", null);
    const note = flag("note", null);
    const code = mint();
    await client.query(
      `insert into public.invite_codes (code, note, max_uses, expires_at)
       values ($1, $2, $3, $4)`,
      [code, note, uses, days ? new Date(Date.now() + Number(days) * 86400e3) : null]);
    console.log(`\n  ${code}\n`);
    console.log(`  ${uses} use${uses === 1 ? "" : "s"}` +
                `${days ? `, expires in ${days} day(s)` : ", no expiry"}` +
                `${note ? `, for ${note}` : ""}`);
  }
} finally {
  await client.end();
}
