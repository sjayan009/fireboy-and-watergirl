/**
 * CI credential broker: the database password and the secret key, for
 * workflows on `main` and nothing else.
 *
 * ## Why this exists
 *
 * Those two credentials used to be repository secrets. Any workflow run in the
 * repository can read a repository secret, and the only thing that kept a
 * branch away from them was an `if: github.ref == 'refs/heads/main'` in the
 * workflow file -- the branch's OWN copy of the workflow file, which whoever
 * pushes the branch can edit. GitHub's real answer, environment secrets behind
 * a deployment-branch rule, is not available to a private repository on the
 * free plan (only public repositories, or Pro and above).
 *
 * GitHub Actions OIDC is available everywhere. Every job can ask GitHub for a
 * short-lived token that GitHub signs, and the claims that matter here --
 * which repository, which ref, which workflow file at which ref -- are written
 * by GitHub from the run itself. A branch that deletes its `if:` still gets a
 * token that says `refs/heads/that-branch`. So the check moves out of the
 * file the attacker controls and into this function, and the credentials move
 * out of GitHub into this function's secrets.
 *
 * ## What it does not change
 *
 * Code that runs in an allowed job on `main` -- a workflow step, a dependency
 * `npm ci` installs -- can still ask for what that job is allowed. `main` was
 * always the trust boundary; this makes it the only one.
 */

/** Who signs the tokens, and who they must be addressed to. */
export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const AUDIENCE = "fbwg-ci-credentials";

/**
 * This repository, by the numeric ids GitHub never reuses as well as by name:
 * a deleted and recreated repository of the same name, or a fork, has
 * different ids.
 */
export const REPOSITORY = "sjayan009/fireboy-and-watergirl";
export const REPOSITORY_ID = "1351822594";
export const OWNER_ID = "70182014";

export type Scope = "db" | "api" | "browserbase";

/**
 * What each workflow FILE may have, keyed by the file whose job is running
 * (`job_workflow_ref`), so a reusable workflow is judged as itself rather than
 * as whatever called it.
 */
export const SCOPES: Record<string, Scope[]> = {
  "deployed.yml": ["db", "api"],
  "full.yml": ["db", "api"],
  "network-hosted.yml": ["api"],
  "network-remote.yml": ["api", "browserbase"],
};

/** Each scope's variable in the job, and the function secret it comes from. */
const SECRETS: Record<Scope, [variable: string, secret: string][]> = {
  db: [["SUPABASE_DB_PASSWORD", "FBWG_CI_DB_PASSWORD"]],
  api: [["SUPABASE_SECRET_KEY", "FBWG_CI_SECRET_KEY"]],
  browserbase: [["BROWSERBASE_API_KEY", "FBWG_CI_BROWSERBASE_API_KEY"]],
};

/** The events a run on `main` legitimately starts from. */
const EVENTS = new Set(["push", "schedule", "workflow_dispatch"]);

/** A token this old has been sitting somewhere; a job asks the moment it starts. */
const MAX_AGE_SECONDS = 10 * 60;
const SKEW_SECONDS = 60;

export interface Jwk {
  kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string;
}

export type Claims = Record<string, unknown>;

function base64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function json(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64url(part)));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Verify a GitHub Actions OIDC token: RS256 from a published key, addressed
 * to us, from GitHub, and current. Answers the claims, or null for anything
 * that is not all of those -- including `alg: none` and an unknown key.
 */
export async function verifyGithubToken(
  token: string,
  keys: (refresh: boolean) => Promise<Jwk[]>,
  nowSeconds: number,
): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 8192) return null;
  const header = json(parts[0]);
  const claims = json(parts[1]);
  if (!header || !claims) return null;
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  let jwk = (await keys(false)).find((k) => k.kid === header.kid);
  // GitHub rotates its keys; one fresh look before giving up on an unknown kid.
  if (!jwk) jwk = (await keys(true)).find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) return null;

  let ok: boolean;
  try {
    const key = await crypto.subtle.importKey(
      "jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, base64url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null;
  }
  if (!ok) return null;

  if (claims.iss !== GITHUB_ISSUER) return null;
  const aud = claims.aud;
  if (!(aud === AUDIENCE || (Array.isArray(aud) && aud.includes(AUDIENCE)))) return null;
  const { exp, iat, nbf } = claims;
  if (typeof exp !== "number" || exp <= nowSeconds) return null;
  if (typeof iat !== "number" || iat > nowSeconds + SKEW_SECONDS) return null;
  if (nowSeconds - iat > MAX_AGE_SECONDS) return null;
  if (nbf !== undefined && (typeof nbf !== "number" || nbf > nowSeconds + SKEW_SECONDS)) return null;
  return claims;
}

/** `owner/repo/.github/workflows/<file>@refs/heads/main` -> `<file>`, or null. */
function workflowOnMain(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const m = /^([^/]+\/[^/]+)\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)@refs\/heads\/main$/.exec(ref);
  return m && m[1] === REPOSITORY ? m[2] : null;
}

/**
 * The whole policy, as a pure function of verified claims. Every refusal says
 * which rule refused, for the log; none of them says anything about a secret.
 */
export function decide(claims: Claims): { scopes: Scope[] } | { refused: string } {
  if (claims.repository !== REPOSITORY) return { refused: "repository" };
  if (String(claims.repository_id) !== REPOSITORY_ID) return { refused: "repository_id" };
  if (String(claims.repository_owner_id) !== OWNER_ID) return { refused: "repository_owner_id" };
  if (claims.ref !== "refs/heads/main" || claims.ref_type !== "branch") return { refused: "ref" };
  if (typeof claims.event_name !== "string" || !EVENTS.has(claims.event_name)) {
    return { refused: "event_name" };
  }
  if (claims.runner_environment !== "github-hosted") return { refused: "runner_environment" };
  // The file that started the run, and the file whose job this is, must both
  // be the copies on main.
  if (!workflowOnMain(claims.workflow_ref)) return { refused: "workflow_ref" };
  const job = workflowOnMain(claims.job_workflow_ref ?? claims.workflow_ref);
  if (!job) return { refused: "job_workflow_ref" };
  const scopes = SCOPES[job];
  if (!scopes) return { refused: `no credentials for ${job}` };
  return { scopes };
}

interface Dependencies {
  env: (name: string) => string | undefined;
  keys: (refresh: boolean) => Promise<Jwk[]>;
  now?: () => number;
  log?: (line: string) => void;
}

export function createCiHandler(deps: Dependencies): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
  return async (req) => {
    if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
    const bearer = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(req.headers.get("authorization") ?? "");
    if (!bearer) return reply(401, { error: "A GitHub Actions OIDC token is required" });

    let claims: Claims | null;
    try {
      claims = await verifyGithubToken(bearer[1], deps.keys, Math.floor(now() / 1000));
    } catch {
      claims = null;
    }
    if (!claims) {
      log("ci-credentials refused: token");
      return reply(401, { error: "A GitHub Actions OIDC token is required" });
    }

    const run = `${String(claims.workflow_ref)} run ${String(claims.run_id)}/${String(claims.run_attempt)}`;
    const decision = decide(claims);
    if ("refused" in decision) {
      log(`ci-credentials refused: ${decision.refused} (${run}, ref ${String(claims.ref)})`);
      return reply(403, { error: "This run may not have CI credentials", rule: decision.refused });
    }

    let wanted: Scope[] = decision.scopes;
    try {
      const body = await req.json() as { scopes?: unknown };
      if (Array.isArray(body?.scopes)) {
        wanted = decision.scopes.filter((s) => (body.scopes as unknown[]).includes(s));
      }
    } catch { /* no body: everything this workflow may have */ }

    const credentials: Record<string, string> = {};
    for (const scope of wanted) {
      for (const [variable, secret] of SECRETS[scope]) {
        const value = deps.env(secret);
        if (!value) {
          log(`ci-credentials misconfigured: ${secret} is not set`);
          return reply(500, { error: `The broker has no ${secret}` });
        }
        credentials[variable] = value;
      }
    }
    log(`ci-credentials issued [${wanted.join(", ")}] to ${run}`);
    return reply(200, { credentials });
  };
}
