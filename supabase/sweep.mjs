/**
 * Delete test accounts that an earlier run did not.
 *
 * Every suite cleans up in a `finally`, and a `finally` does not run when the
 * process is killed. That is not hypothetical here: a wedged headless browser
 * left one suite pinning a core for over an hour, and killing it stranded the
 * accounts it had made. Seventeen were found sitting in the project weeks
 * later, the oldest nine and a half days old.
 *
 * So cleanup happens at the START of a run as well as the end. The end is
 * better -- it removes what this run made, immediately -- but only the start is
 * reachable after a kill, and a run that begins by tidying is a run that cannot
 * accumulate.
 *
 * ## What it will and will not delete
 *
 * Only `@example.com`, and only rows older than an hour.
 *
 * The domain is reserved by RFC 2606 precisely so it can never be anybody's
 * real address, and every suite here builds its addresses from it. The hour is
 * what makes this safe to call while another suite is running: two of them in
 * parallel, or a developer running one locally while CI runs another, must not
 * delete each other's accounts out from under a live assertion.
 */
import { env } from "./connect.mjs";

const HOUR = 60 * 60 * 1000;

/**
 * @param {string} label  which suite is asking, for the one line it prints
 * @param {string} [emailPrefix]  optional exact test-account prefix for a scoped sweep
 * @returns {Promise<number>} how many it removed
 */
export async function sweepStaleTestUsers(label = "", emailPrefix = "") {
  const e = env();
  const API = e.SUPABASE_URL;
  const SECRET = e.SUPABASE_SECRET_KEY;
  if (!API || !SECRET) return 0;

  const headers = {
    apikey: SECRET, Authorization: `Bearer ${SECRET}`,
    "content-type": "application/json",
  };

  let users;
  try {
    const r = await fetch(`${API}/auth/v1/admin/users?page=1&per_page=1000`,
                          { headers });
    if (!r.ok) return 0;
    users = (await r.json()).users ?? [];
  } catch {
    // A sweep that cannot reach the server is not a reason to fail a run that
    // has not started yet. The suite itself will say so a moment later.
    return 0;
  }

  const cutoff = Date.now() - HOUR;
  const stale = users.filter((u) =>
    (u.email ?? "").endsWith("@example.com") &&
    (!emailPrefix || (u.email ?? "").startsWith(emailPrefix)) &&
    new Date(u.created_at).getTime() < cutoff);

  for (const u of stale) {
    await fetch(`${API}/auth/v1/admin/users/${u.id}`,
                { method: "DELETE", headers }).catch(() => {});
  }
  if (stale.length) {
    console.log(`${label ? label + ": " : ""}swept ${stale.length} test ` +
                `account${stale.length === 1 ? "" : "s"} a killed run left behind`);
  }
  return stale.length;
}
