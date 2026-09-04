/**
 * The three servers that map a URL onto a file, and the one rule they share.
 *
 * An audit found the same hole in all of them: `serve.mjs`, the Vite plugin
 * that serves `extracted/` in development, and the little CDN stand-in in
 * `app/test/production.mjs`. Each filtered `..` out of a `/`-separated path and
 * then handed the result to `path.join`, which on Windows treats `\` as a
 * separator too. `GET /..%5C.env.local` returned HTTP 200 and the exact byte
 * count of a file holding the Supabase secret key and the database password.
 *
 * Two things about that are worth writing a test for rather than a fix.
 *
 * The first is that it is a WINDOWS bug in a project that is developed on
 * Windows and tested on Linux. `path.join("web", "..\\.env.local")` is
 * `web/..\.env.local` on Linux -- one harmless filename with a backslash in it
 * -- and `.env.local` on Windows. A test that only ever runs in CI would have
 * passed every night. So these assertions are written against the CONTAINMENT
 * decision rather than against the platform: `safepath.mjs` refuses a backslash
 * outright, which is a rule that means the same thing everywhere and can
 * therefore be proved everywhere.
 *
 * The second is that the request has to reach the server unmangled. `fetch`
 * builds a WHATWG URL, and a WHATWG URL turns `\` into `/` before anything is
 * sent -- so a test written with `fetch` proves that `fetch` normalises, not
 * that the server is safe. Every request below is written onto a socket by
 * hand, exactly as a hostile client would write it.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { requestPath, resolveUnder } from "../safepath.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5197;

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

/**
 * Send a request line verbatim and read the reply.
 *
 * No URL parsing anywhere on this side, which is the point: the bytes that
 * reach the server are the bytes written here.
 */
function raw(target, { method = "GET", body = null, headers = "" } = {}) {
  return new Promise((done) => {
    const socket = connect(PORT, "127.0.0.1", () => {
      socket.write(
        `${method} ${target} HTTP/1.1\r\nHost: localhost:${PORT}\r\n` +
        `Connection: close\r\n${headers}` +
        (body === null ? "" : `Content-Length: ${Buffer.byteLength(body)}\r\n`) +
        "\r\n" + (body ?? ""));
    });
    const chunks = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", () => done({ status: 0, body: "" }));
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      const status = Number(text.split(" ")[1] ?? 0);
      const at = text.indexOf("\r\n\r\n");
      done({ status, body: at === -1 ? "" : text.slice(at + 4) });
    });
  });
}

// ---- the rule itself, with no server around it -----------------------------

console.log("what safepath will and will not map");
{
  const traversals = [
    "/../package.json",
    "/..%2Fpackage.json",
    "/..%5C.env.local",
    "/..\\.env.local",
    "/extracted/..\\.env.local",
    "/a/../../.env.local",
    "/%2e%2e/.env.local",
    "/%252e%252e/.env.local",     // double encoded: decodes to "%2e%2e", a name
    "/C:/Windows/win.ini",
    "//server/share/file",
    "/./secret",
    "/%00",
    "/%",                         // the malformed escape that used to throw
    "/foo%zz",
  ];
  const mapped = traversals.filter((t) => resolveUnder(ROOT, t) !== null)
    .filter((t) => {
      // `%252e%252e` decodes once to the literal name "%2e%2e", which is a
      // perfectly ordinary path segment and correctly maps to a file that does
      // not exist. Everything else in the list must be refused outright.
      const parts = requestPath(t);
      return !(parts && parts.every((s) => s !== ".." && s !== "."));
    });
  check("none of them resolve to a path", mapped, []);
  check("and a real asset still does",
        resolveUnder(ROOT, "/extracted/assets/sprites.json") !== null, true);
  check("a root request is the root itself",
        resolveUnder(ROOT, "/") === ROOT, true);
  // The prefix-confusion case a `startsWith` check gets wrong.
  check("a sibling directory with the same prefix is outside",
        resolveUnder(resolve(ROOT, "web"), "/../web-secrets/x"), null);
}

// ---- and the same rule, over a real socket ---------------------------------

console.log("\nserve.mjs, over HTTP, with the bytes written by hand");
const server = spawn(process.execPath, ["serve.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let listening = "";
server.stdout.on("data", (d) => { listening += String(d); });

await new Promise((ok, fail) => {
  const t = setTimeout(() => fail(new Error("server did not start")), 10000);
  server.stdout.on("data", (d) => {
    if (String(d).includes("serving on")) { clearTimeout(t); ok(); }
  });
  server.on("exit", (c) => { clearTimeout(t); fail(new Error("exited " + c)); });
});

try {
  check("it says where it is listening, and it is loopback",
        /http:\/\/127\.0\.0\.1:/.test(listening), true);

  // The reproduction, exactly as the audit ran it.
  const secretSize = existsSync(resolve(ROOT, ".env.local"))
    ? readFileSync(resolve(ROOT, ".env.local")).length : null;
  const escaped = await raw("/..%5C.env.local");
  check("the encoded backslash is refused", escaped.status, 400);
  if (secretSize !== null) {
    check("and certainly did not return the environment file",
          escaped.body.length === secretSize, false);
  }

  const rawSlash = await raw("/..\\.env.local");
  check("so is a literal one", rawSlash.status, 400);
  check("and one inside a legitimate prefix",
        (await raw("/extracted/..\\.env.local")).status, 400);
  check("and an ordinary parent segment",
        (await raw("/../package.json")).status, 400);
  check("and an encoded one",
        (await raw("/%2e%2e/package.json")).status, 400);
  check("and an absolute drive path",
        (await raw("/C:/Windows/win.ini")).status, 400);
  check("and a UNC path", (await raw("//localhost/c$/x")).status, 400);

  // The crash. `decodeURIComponent` used to run outside the try around the file
  // read, so one malformed escape threw a URIError out of the request handler
  // and Node exited 1 -- from any client, with no authentication, once.
  check("a malformed escape is a 400", (await raw("/%")).status, 400);
  check("and the server is still there afterwards",
        (await raw("/index.html")).status, 200);

  // The unauthenticated write. It buffered an entire request body in memory,
  // of any size, and wrote it to disk.
  check("the snapshot sink is off unless it is asked for",
        (await raw("/snap/x.png", { method: "POST", body: "not a png" })).status,
        404);

  // And it still serves the things it exists to serve.
  const page = await raw("/");
  check("the harness page loads", page.status, 200);
  check("with the game in it", /<canvas/i.test(page.body), true);
  // With its query, which is how the netplay tests name a room. Deciding the
  // index substitution on the raw request line rather than on the PATH sent
  // `/?room=direct` looking for a file called `?room=direct`, and every
  // browser-driven netcode test timed out waiting for a page that had 404ed.
  const withQuery = await raw("/?room=direct");
  check("and so does the same page with a query on it", withQuery.status, 200);
  check("engine code is served under /dist",
        (await raw("/dist/embed.js")).status, 200);
  check("and the extracted assets are readable",
        (await raw("/extracted/assets/sprites.json")).status, 200);
} finally {
  server.kill();
}

console.log("\n" + (failures === 0 ? "SERVERS PASSED"
                                   : `SERVERS FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
