import { createCiHandler, GITHUB_ISSUER, type Jwk } from "./handler.ts";

/**
 * GitHub's signing keys, cached for ten minutes per warm isolate. The handler
 * asks again with `refresh` once when a token names a key it has not seen.
 */
let cached: { at: number; keys: Jwk[] } | null = null;
async function keys(refresh: boolean): Promise<Jwk[]> {
  if (!refresh && cached && Date.now() - cached.at < 10 * 60_000) return cached.keys;
  const res = await fetch(`${GITHUB_ISSUER}/.well-known/jwks`, {
    redirect: "error", signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const body = await res.json() as { keys?: Jwk[] };
  cached = { at: Date.now(), keys: Array.isArray(body.keys) ? body.keys : [] };
  return cached.keys;
}

Deno.serve(createCiHandler({ env: (name) => Deno.env.get(name), keys }));
