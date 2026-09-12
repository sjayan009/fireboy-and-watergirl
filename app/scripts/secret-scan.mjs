import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Returns labels only, never includes a matched secret in failure output. */
export function secretHits(body, env = {}) {
  const pick = (name) => typeof env[name] === "string" ? env[name].trim().replace(/^(['"])(.*)\1$/, "$2") : "";
  const forbidden = [
    ["the secret key", pick("SUPABASE_SECRET_KEY"), /sb_secret_[A-Za-z0-9_-]{10,}/],
    ["the database password", pick("SUPABASE_DB_PASSWORD"), null],
    ["a service-role JWT", "", /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
    ["a Cloudflare TURN master reference", "", /CLOUDFLARE_TURN_(?:KEY_ID|API_TOKEN)/i],
    ["the server-only TURN issuance endpoint", "", /rtc\.live\.cloudflare\.com\/v1\/turn\/keys|credentials\/generate-ice-servers/i],
  ];
  for (const name of Object.keys(env)) {
    if (/(?:^|_)CLOUDFLARE_TURN_(?:KEY_ID|API_TOKEN)$/.test(name)) {
      forbidden.push(["a Cloudflare TURN master value", pick(name), null]);
    }
  }
  return forbidden.filter(([, literal, shape]) =>
    (literal && literal.length > 8 && body.includes(literal)) || shape?.test(body)
  ).map(([name]) => name);
}

export function scanClientSecrets(root, dist, ...environments) {
  function walk(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = join(dir, entry.name);
      return entry.isDirectory() ? walk(file) : [file];
    });
  }
  const readable = (p) => /\.(?:[cm]?js|tsx?|css|html|map|json|txt|svg|webmanifest|pem|env)$/i.test(p);
  const output = walk(dist).filter(readable);
  const source = [...walk(resolve(root, "app/src")), ...walk(resolve(root, "app/public"))].filter(readable);
  const config = resolve(root, "app/vite.config.ts");
  if (existsSync(config)) source.push(config);
  if (!environments.length) environments.push({});
  const hits = [...output, ...source].flatMap((file) => {
    const body = readFileSync(file, "utf8");
    const labels = new Set(environments.flatMap((env) => secretHits(body, env)));
    return [...labels].map((name) => `${name} appears in ${file}`);
  });
  return { output, source, hits };
}
