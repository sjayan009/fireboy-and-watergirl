/**
 * Take two-factor off an account whose owner has lost their authenticator.
 *
 *   npm run unenrol -- --list                who has a second factor at all
 *   npm run unenrol -- --user someone        remove theirs, by username
 *
 * This is the recovery story, and it is a deliberate choice not to have the
 * other one. The standard answer is a set of single-use recovery codes, which
 * means a second credential store to mint, hash, show once, and redeem -- a new
 * security-sensitive surface in an app whose entire auth story is otherwise
 * "Supabase does it". For an invite-only game played by a handful of people who
 * can reach the person holding the secret key, a script is the smaller risk.
 *
 * Runs against the database directly, like `invite.mjs`, because `auth.mfa_*`
 * is not reachable through any policy a signed-in user has -- which is the
 * point of it.
 */
import { open } from "./connect.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes("--" + name);

const client = await open();
try {
  if (has("list")) {
    const r = await client.query(`
      select p.username, u.email, f.friendly_name, f.status, f.created_at
        from auth.mfa_factors f
        join auth.users u on u.id = f.user_id
        left join public.profiles p on p.id = f.user_id
       order by f.created_at desc`);
    if (r.rows.length === 0) {
      console.log("nobody has a second factor enrolled");
    }
    for (const row of r.rows) {
      console.log(`${(row.username ?? "(no profile)").padEnd(20)} ` +
                  `${String(row.email).padEnd(32)} ${row.status}`);
    }
    process.exit(0);
  }

  const who = flag("user");
  if (!who) {
    console.error("usage: npm run unenrol -- --user <username>   (or --list)");
    process.exit(2);
  }

  // By username rather than by email, because the username is what they are
  // called in the game and the email is the thing you would have to go looking
  // up. Both are unique.
  const found = await client.query(
    `select id, username from public.profiles where lower(username) = lower($1)`,
    [who]);
  if (found.rows.length === 0) {
    console.error(`no user called ${who}`);
    process.exit(1);
  }
  const { id, username } = found.rows[0];

  // Deleting the factor is the whole of it: `auth.ts` decides the `locked`
  // stage from whether a verified factor exists, so an account with none goes
  // straight through to signed in. The challenges cascade with the factor.
  const gone = await client.query(
    `delete from auth.mfa_factors where user_id = $1 returning id`, [id]);
  if (gone.rowCount === 0) {
    console.log(`${username} has no second factor enrolled`);
  } else {
    console.log(`removed ${gone.rowCount} factor(s) from ${username}`);
    console.log("they can sign in with their password alone now, and should " +
                "turn it on again from Settings.");
  }
} finally {
  await client.end();
}
