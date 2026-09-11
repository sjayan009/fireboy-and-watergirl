# Workers deployment status — 11 September 2026

Destination: <https://fireboy-and-watergirl.sjayan009.workers.dev>.

**Publication approved; deployment verification in progress.** The user explicitly
approved publication and the Supabase URL corrections. The browser folder picker
does not select directory contents, so publication uses the existing authenticated
Git connection and Cloudflare Workers Free build integration.

## Verified account and existing deployment

- Cloudflare Workers dashboard: **Free — $0 — Current plan**.
- Existing service: static assets only; no runtime variables, Logpush, Tail
  Workers or triggers. No custom domain; preview URLs disabled.
- Git-linked to `sjayan009/fireboy-and-watergirl`, production branch `main`.
  Build command `npm run build`; deployment uses `wrangler deploy --assets=./dist`.
- Public Supabase URL/key configured for the build. No backend credential is
  needed by this static host.
- Live root responds 200, missing paths 404, hash routes 200, robots disallows
  indexing. `version.txt` currently says `local`, which is not proof of a match
  to this working tree.
- Read-only deployed checks fail nine assertions: CSP/frame-ancestors, CSP
  Supabase allowance, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
  X-Robots-Tag, Permissions-Policy, immutable art caching and immutable bundle
  caching. The built `_headers` supplies these policies; verify the uploader
  applies them after publication. Missing CSP does not itself block Supabase.
- Supabase's Site URL now points to the Workers HTTPS origin. The redirect
  allow-list now contains `https://fireboy-and-watergirl.sjayan009.workers.dev/**`.
  The previous malformed entry without a scheme was removed.
- GitHub authentication is available. Remote `main` matched the audited baseline
  `7c399f8603918997197785957bcb05b86c72b89f`. No repository Actions variables
  are set, so the new private-repository CI gates skip hosted jobs.

## Prepared artifact and checks

`dist/`: **2,496 files, 27,839,015 bytes**, largest **1,356,970 bytes**.
Content fingerprint: `1df931ed0a8addd50a2435d70428976c805a86efc09e1c8023fa61566ed849b4`.
This SHA-256 concatenates files in sorted relative-path order as
`UTF8(path + NUL + byteLength + NUL)` followed by file bytes. It identifies the
current uncommitted static artifact; a later build must be fingerprinted again.

Passed: production build, secret/manifest/size checks, zero-cost configuration
tests, documentation checks, lint of the hosting changes, `git diff --check`,
and Wrangler **4.131.1** dry-run with no bindings. The browser/game performance
and determinism results are in [BENCHMARKS.md](../BENCHMARKS.md).

`wrangler.json` provides the existing account/service, static `dist/` and real
404 routing. The packaging guard rejects runtime code, resource bindings,
alternate environments and build hooks. Workers build versions now use
`WORKERS_CI_COMMIT_SHA`; local builds remain labelled `local`.

## Release verification

Upload only `dist/` through the existing static-file uploader, or authenticate
Wrangler and deploy using the reviewed configuration. Do not create temporary
accounts, upgrade the plan, or add a Worker script. Confirm successful deployment
in the dashboard, compare live bundle bytes with the local artifact, and run:

```sh
node app/test/deployed.mjs https://fireboy-and-watergirl.sjayan009.workers.dev --static-only
node app/test/deployed.mjs https://fireboy-and-watergirl.sjayan009.workers.dev
```

The second command exercises live sign-in/playback with a disposable test
account. Check OAuth separately after the redirect correction. A manual upload
does not push source changes; the next Git build still uses remote `main`.
Account-wide GitHub spending and the SMTP contract remain unverified, as
recorded in [FREE_TIER_BUDGET.md](../FREE_TIER_BUDGET.md).
