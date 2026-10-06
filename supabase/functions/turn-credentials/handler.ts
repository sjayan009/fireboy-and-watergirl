/** Server-only TURN broker. No upstream body or credential is ever logged. */
export const TURN_TTL_SECONDS = 4 * 60 * 60;
const WINDOW_MS = 10 * 60_000;
const MAX_CALLS = 8;
const MAX_USERS = 4096;

interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

interface BrokerDependencies {
  env(name: string): string | undefined;
  verifyUser(token: string): Promise<{ id: string; is_anonymous?: boolean } | null>;
  /**
   * Charge one credential to the caller, as the caller, in the database:
   * `spend_turn_credential()`, which needs a profile and keeps a budget that
   * survives isolates. "limited" is over budget; "refused" is not a player.
   */
  charge(token: string): Promise<"ok" | "limited" | "refused">;
  fetch: typeof fetch;
  now?: () => number;
}

/** Copy an allowlist of Cloudflare response fields; never forward arbitrary JSON. */
function cloudflareServers(value: unknown): IceServer[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 8) return null;
  const out: IceServer[] = [];
  let hasTurn = false;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const urls = typeof row.urls === "string" ? [row.urls] : row.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 8 ||
        urls.some((url) => typeof url !== "string" ||
          !/^(?:stun:stun|turns?:turn)\.cloudflare\.com:\d{1,5}(?:\?transport=(?:udp|tcp))?$/.test(url))) return null;
    const relay = urls.some((url: string) => /^turns?:/.test(url));
    if (relay && (typeof row.username !== "string" || !row.username.length ||
        row.username.length > 1024 || typeof row.credential !== "string" ||
        !row.credential.length || row.credential.length > 1024)) return null;
    hasTurn ||= relay;
    out.push({ urls: [...urls], ...(relay ? {
      username: row.username as string, credential: row.credential as string,
    } : {}) });
  }
  return hasTurn ? out : null;
}

export function createTurnHandler(deps: BrokerDependencies): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  // A first, cheap gate per warm isolate. The real cap is `charge`, which
  // holds across isolates; this one only spares the database a flood.
  const budgets = new Map<string, { start: number; calls: number }>();
  const allowed = (deps.env("TURN_ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return async (req) => {
    const origin = req.headers.get("origin");
    // An unset allowlist used to mean every origin. It now means none: a
    // missing secret should stop the broker, not open it.
    const originAllowed = !origin || allowed.includes(origin);
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "Vary": "Origin",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (originAllowed && origin) headers["Access-Control-Allow-Origin"] = origin;
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
    if (!originAllowed) return reply(403, { error: "Origin not allowed" });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
    const authorization = req.headers.get("authorization") ?? "";
    const bearer = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!bearer || bearer[1].length > 8192) return reply(401, { error: "Authentication required" });
    let user: Awaited<ReturnType<BrokerDependencies["verifyUser"]>>;
    try { user = await deps.verifyUser(bearer[1]); }
    catch { return reply(401, { error: "Authentication required" }); }
    if (!user?.id || user.is_anonymous) return reply(401, { error: "Authentication required" });

    const issuedAt = now();
    for (const [id, budget] of budgets) {
      if (issuedAt - budget.start >= WINDOW_MS) budgets.delete(id);
    }
    let budget = budgets.get(user.id);
    if (!budget) {
      if (budgets.size >= MAX_USERS) return reply(503, { error: "TURN temporarily unavailable" });
      budget = { start: issuedAt, calls: 0 };
      budgets.set(user.id, budget);
    }
    if (++budget.calls > MAX_CALLS) {
      headers["Retry-After"] = String(Math.max(1, Math.ceil((budget.start + WINDOW_MS - issuedAt) / 1000)));
      return reply(429, { error: "Try again later" });
    }

    let charged: Awaited<ReturnType<BrokerDependencies["charge"]>>;
    try { charged = await deps.charge(bearer[1]); }
    catch { return reply(503, { error: "TURN temporarily unavailable" }); }
    if (charged === "refused") return reply(403, { error: "Claim a username first" });
    if (charged === "limited") return reply(429, { error: "Try again later" });

    const keyId = deps.env("CLOUDFLARE_TURN_KEY_ID");
    const apiToken = deps.env("CLOUDFLARE_TURN_API_TOKEN");
    if (!keyId || !apiToken) return reply(503, { error: "TURN temporarily unavailable" });
    try {
      const upstream = await deps.fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
      if (!upstream.ok) return reply(502, { error: "TURN temporarily unavailable" });
      const data: unknown = await upstream.json();
      const iceServers = data && typeof data === "object"
        ? cloudflareServers((data as Record<string, unknown>).iceServers) : null;
      if (!iceServers) return reply(502, { error: "TURN temporarily unavailable" });
      // Cloudflare does not return TTL. Start before the upstream call so this
      // expiry is conservative even when generating credentials takes time.
      return reply(200, { iceServers, expiresAt: issuedAt + TURN_TTL_SECONDS * 1000 });
    } catch { return reply(502, { error: "TURN temporarily unavailable" }); }
  };
}
