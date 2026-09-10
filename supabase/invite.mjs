/**
 * Invite people, by address or by code.
 *
 *   npm run invite -- --email you@example.com   mail them an invitation
 *   npm run invite                    one code, one use
 *   npm run invite -- --uses 5        one code, five uses
 *   npm run invite -- --days 7        expires in a week
 *   npm run invite -- --note "jayan"  a reminder of who it was for
 *   npm run invite -- --list          codes, and invitations not yet taken up
 *
 * ## Two ways in, and the address is the better one
 *
 * A code is a string that has to reach somebody by some other channel and then
 * be typed correctly, which is fine once and tiresome after that. `--email`
 * hands the whole errand to Supabase: it creates the account, marks it
 * `invited_at`, and mails a link. Whoever follows it lands on the username
 * screen with no code to enter, because `claim_username` reads that column and
 * takes an invitation as the answer -- see `20260909020000_email_invites.sql`.
 *
 * Codes remain for the case an address cannot serve: pasting one into a chat,
 * or letting several people in off the same string.
 *
 * ## Why this is a script and not a screen
 *
 * `invite_codes` has no row level security policies at all -- deliberately, so
 * a signed-in user can neither enumerate codes nor reset their use counts --
 * and inviting by address needs the admin API, which needs the secret key. The
 * deployment is static and has nowhere to keep one, the same reason `delete_me`
 * is a database function rather than an admin call. So this script, run by
 * somebody who already has the credentials, is the only door.
 */
import { randomBytes } from "node:crypto";
import { env, open } from "./connect.mjs";

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

/**
 * Mail somebody an invitation.
 *
 * Supabase does all of it: creates the account, sets `invited_at`, sends the
 * mail. There is nothing to write here and nothing to hand over afterwards.
 *
 * The one thing that has to be right is in the dashboard rather than in this
 * file. The **Invite** email template must link to
 * `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=invite`, NOT to
 * `{{ .ConfirmationURL }}`. The recipient's browser did not start this flow, so
 * it holds no PKCE verifier and cannot exchange the `?code=` that
 * `ConfirmationURL` produces -- the link would arrive, be clicked, and do
 * nothing at all. `redeemTokenHash` in `app/src/auth.ts` handles the other
 * shape, and has since before invitations existed.
 */
async function inviteByEmail(address) {
  const e = env();
  const r = await fetch(`${e.SUPABASE_URL}/auth/v1/invite`, {
    method: "POST",
    headers: {
      apikey: e.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${e.SUPABASE_SECRET_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: address }),
  });
  const body = await r.json();
  if (!r.ok) {
    // The common one is "email address already registered". That is worth
    // saying plainly, because the answer is different: they already have an
    // account, so they want a sign-in link from #/link, not an invitation.
    console.error(`\n  could not invite ${address}: ${body.msg ?? body.message ?? r.status}`);
    if (String(body.msg ?? body.message ?? "").includes("already")) {
      console.error("  they already have an account -- send them to #/link " +
                    "for a fresh sign-in link instead.");
    }
    process.exitCode = 1;
    return;
  }
  console.log(`\n  invited ${address}`);
  console.log("  they get an email with a link; no code to type.");
}

if (has("email")) {
  const address = flag("email", null);
  if (!address) {
    console.error("  --email needs an address");
    process.exitCode = 1;
  } else {
    await inviteByEmail(address);
  }
  process.exit(process.exitCode ?? 0);
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

    // Invitations that were sent and never taken up. An invited account exists
    // from the moment the mail goes out, so "invited but no profile" is exactly
    // the set of people who have not finished -- the ones worth chasing, or
    // pointing at #/link when the link has gone stale.
    const pending = await client.query(`
      select u.email, u.invited_at
        from auth.users u
        left join public.profiles p on p.id = u.id
       where u.invited_at is not null and p.id is null
       order by u.invited_at desc limit 50`);
    if (pending.rows.length > 0) {
      console.log("\ninvitations not taken up yet:");
      for (const u of pending.rows) {
        const days = Math.floor((Date.now() - new Date(u.invited_at)) / 86400e3);
        console.log(`  ${u.email}  ${days === 0 ? "today" : days + "d ago"}`);
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
