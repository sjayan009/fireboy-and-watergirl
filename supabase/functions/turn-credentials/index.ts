import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import { createTurnHandler } from "./handler.ts";

const env = (name: string) => Deno.env.get(name);
Deno.serve(createTurnHandler({
  env,
  fetch,
  async verifyUser(token) {
    // getUser contacts Supabase Auth and validates this exact bearer token.
    // Neither a decoded JWT nor arbitrary Authorization text proves identity.
    const client = createClient(env("SUPABASE_URL") ?? "", env("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(3000) }) },
    });
    const { data, error } = await client.auth.getUser(token);
    return error ? null : data.user;
  },
}));
