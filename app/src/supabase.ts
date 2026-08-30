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

if (!__SUPABASE_URL__ || !__SUPABASE_KEY__) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are missing. Put them in " +
    ".env.local at the repo root, or set them in the deploy environment.");
}

export const supabase = createClient(__SUPABASE_URL__, __SUPABASE_KEY__, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // The email link comes back to the page, and the session it carries is in
    // the URL fragment.
    detectSessionInUrl: true,
    flowType: "pkce",
  },
});
