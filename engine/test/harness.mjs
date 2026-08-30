/**
 * Shared plumbing for the browser-driven tests: serve the build, and launch a
 * browser, without either test having to care how.
 *
 * Both callers skip cleanly when Playwright or its browsers are not installed,
 * so a fresh checkout can still run `npm test` without a 500 MB download.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Import Playwright, or null if it is not installed. */
export async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    console.log("playwright not installed -- skipping");
    console.log("  install with: npm i -D playwright && npx playwright install");
    return null;
  }
}

/**
 * Run serve.mjs on `port`. serve.mjs hardcodes its own default, so the port is
 * passed through the environment rather than by duplicating the server here.
 */
export async function startServer(port) {
  const server = spawn(process.execPath, ["serve.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });

  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error("server did not start")), 10000);
    server.stdout.on("data", (d) => {
      if (String(d).includes("serving on")) { clearTimeout(t); ok(); }
    });
    server.on("exit", (c) => {
      clearTimeout(t);
      fail(new Error("server exited with " + c));
    });
  });

  return server;
}
