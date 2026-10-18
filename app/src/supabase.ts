/**
 * The one Supabase client.
 *
 * Only the PUBLISHABLE key is ever here. It is meant to be public: it carries
 * no authority of its own, and every row it can reach is decided by row level
 * security against the signed-in user's JWT -- which is why proving those
 * policies first, against the real API, was the right order to build this in.
 *
 * The secret key bypasses RLS entirely and lives only in the gitignored
 * `.env.local`, where the migration and test scripts read it. It must never
 * appear in anything the browser downloads.
 */
import { createClient } from "@supabase/supabase-js";
import { SESSION_KEY } from "./auth.js";

if (!__SUPABASE_URL__ || !__SUPABASE_KEY__) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are missing. Put them in " +
    ".env.local at the repo root, or set them in the deploy environment.");
}

/**
 * A client that remembers nothing, for proving a password without becoming
 * the session that proved it.
 *
 * Signing in on `supabase` itself would REPLACE the session in this tab -- and
 * for an account with a second factor, replace an `aal2` session with an
 * `aal1` one, dropping the person back to the code prompt halfway through a
 * settings change. This one keeps its session in memory, never refreshes it,
 * and is thrown away by whoever asked for it.
 */
export function scratchClient() {
  return createClient(__SUPABASE_URL__, __SUPABASE_KEY__, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "fbwg-proof",
    },
  });
}

export const supabase = createClient(__SUPABASE_URL__, __SUPABASE_KEY__, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // The name supabase-js would choose anyway, said out loud: auth.ts looks
    // for a session under it before deciding to download this module at all.
    storageKey: SESSION_KEY,
    // The email link comes back to the page, and the session it carries is in
    // the URL fragment.
    detectSessionInUrl: true,
    flowType: "pkce",
    // Passkeys are a beta in supabase-js and refuse to run without this.
    // The version is pinned in package.json for the same reason: the beta's
    // API "may change without notice".
    experimental: { passkey: true },
  },
});
