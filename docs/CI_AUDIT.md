# CI and release-readiness audit — 24 September 2026

> Since 5 October 2026 every workflow that holds a credential runs from `main` only, so the manual branch dispatch described below no longer reaches the database. See the note at the top of `.github/workflows/full.yml`.

This audit used the 29 available `full` runs from 31 August through 23 September 2026, including the most recent 23 scheduled runs, their job/step metadata and representative failed logs. Historical run IDs below are stable GitHub evidence. Scheduled and manual workflows both execute from `main`.

## Why `full` stayed red

| Period | Evidence | Cause and coverage |
| --- | --- | --- |
| 31 August | [run 33384673899](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/33384673899) | Golden-render test reached an `ENOENT` writing `snaps/rendersignatures.json`. This was a missing output directory, not a simulation difference. |
| 1 September | [scheduled run 33492390943](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/33492390943) | Last successful scheduled `full` before the failures. The old single `everything` job completed in about 18.5 minutes. |
| 2–4 September | [run 33610863641](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/33610863641), [run 33855669900](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/33855669900) | 31 of 32 golden renders differed by up to five units per cell after rendering changes. The single `test:all` chain stopped there, hiding later tests. The goldens were repaired, and the suite was split into independent jobs on 4 September. Golden coverage remains in `engine/test/goldenrender.mjs`. |
| 5 September | [run 33955173574](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/33955173574) | Accounts browser test timed out clicking an obsolete UI target. |
| 6–9 September | [run 34022633465](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/34022633465), [run 34332304818](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/34332304818) | Interface test expected the old 390-pixel PLAY pointer target; a subsequent text locator timed out. These were stale UI assumptions, not missing browser installations. |
| 10–11 September | [run 34581769609](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/34581769609), [run 34646022757](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/34646022757) | Two-person relay and spectator timing assertions failed during the UI/network fixes. [run 34647190484](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/34647190484) is the last successful `full` of any trigger, manually dispatched on 11 September at `3b3044a`. |
| 12–23 September | [first failure 34683903439](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/34683903439), [latest 35842516642](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/35842516642) | All twelve scheduled runs failed the same three `twopeople.mjs` assertions. Commit `6a07818` added an offline presence gate test while Bob's signed-in browser was already occupying the PairChannel. The test premise was false (`bob is already on the channel`), so its next two reads were `undefined`. This branch navigates Bob away, waits for the departure edge, checks the gate, then returns him in the same browser context. A full-suite run also caught a pending presence timer left after departure; PairChannel now cancels that send. The valuable presence assertion stays. |
| 16 September | [run 35078925874](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/35078925874) | The database job also had one `fetch failed` / `ECONNRESET` during a provider request. The other inspected recent database jobs passed. This isolated network failure is kept visible; no blanket retry was added. |

The 23 September run's `schema`, `database` and `engine` jobs passed; `application` failed in `twopeople.mjs`. Recent logs show installed Chromium, Firefox and WebKit, a successful build, and the same application assertion. There is no evidence that absent secrets, browser packages, schema drift, or database state caused the recurring red result. From 1–23 September the daily cron produced a run every day; starts were delayed, but none of these dates is missing. [GitHub documents](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) that schedule events use the default branch and can be delayed or dropped under load. The new cron remains away from minute zero.

A local full-suite run also reached the invitation-decline check before Bob's banner finished disappearing. The assertion now waits up to five seconds for the actual hidden state; it still fails if the banner persists.

## Workflow inventory and decisions

All workflows use standard `ubuntu-latest`. Private-repository jobs require `FBWG_ZERO_DOLLAR_ACTIONS=1`; `keepalive` uses `permissions: {}`, and the other workflows use `contents: read` unless a stated read permission is needed. Repository secrets are never passed to pull requests from forks or Dependabot. The fast build deliberately uses placeholders in those cases.

| Workflow | Trigger and useful work | Credentials, browser, mutation and dependencies | Decision |
| --- | --- | --- | --- |
| `fast.yml` | Every push, PR, manual dispatch. Engine/unit/network-unit, replay verifier, free/server/docs, build/check/lint. One `test` job, 20-minute cap, no concurrency group. | Public Supabase URL and publishable key for configured builds; untrusted PRs build placeholders. No browser install or database mutation. | Keep as the cheap required PR check. Push plus PR on the same branch can create duplicate runs, included in budget below. |
| `full.yml` | Tuesday and Friday 04:23 UTC, plus manual dispatch. Independent `schema`, `engine`, `database`, `application` jobs. | `schema` uses DB password/ref and migrates under the `fbwg-database` concurrency group. `database` needs `schema`, uses DB/Auth credentials and mutates disposable test data. `application` needs `schema`, uses Auth credentials and disposable accounts. `engine` is credential-free. Engine and application need Chromium, Firefox and WebKit. Job caps 10/60/20/40 minutes. | Keep separation and all goldens, soak, browser engines, DB matrix and two-account flows. Reduce frequency from daily to twice weekly. Manual runs are restricted to `main`. |
| `network-hosted.yml` | Manual or reusable, `main` only. Live TURN issuance plus eight local two-context hosted migration games. One 30-minute job, no schedule. | Supabase Auth admin/public credentials, one Chromium install, two disposable accounts, no schema migration. Own concurrency group. | Keep as an independent release gate; the distributed test does not replace the forced-TURN and local hosted coverage. Dispatch it from `main`, directly or through `play-release.yml` with `gate=hosted`. |
| `network-remote.yml` | Manual or reusable, `main` only, bounded 1–2 games. Verifies a successful GitHub Preview deployment for the checkout SHA and `/version.txt` before account creation. Accepts only the exact deployment URL. One 20-minute job; `deployments: read` is the only extra GitHub permission. | Supabase admin/public credentials, Browserbase API/project secrets and a temporary Vercel share URL saved as `FBWG_VERCEL_SHARE_URL`. Local Chromium plus one Browserbase Chromium; no DB migration. Own concurrency group. | Release gate only. Vercel Authentication remains enabled; refresh the 23-hour share URL secret before a manual run. No recurring Browserbase use before measured runtime and quota. Sanitized JSON summary retained three days; remote session recording/logging disabled. Dispatch from `main`, directly or through `play-release.yml` with `gate=remote`. |
| `deployed.yml` | Main push or manual dispatch. Builds/checks the checkout, migrates, waits for exact `/version.txt`, then checks the live Cloudflare Workers static-assets origin. One 25-minute job, shared `fbwg-database` concurrency group. | Supabase DB/Auth credentials and Chromium. Schema migration and one disposable smoke-test account. | Keep. Comments now name Workers; Vercel remains a separate Preview provider. No provider change. |
| `keepalive.yml` | Daily 06:40 UTC or manual. One anonymous `profiles` read with an RLS empty-result assertion; 2-minute cap. | Publishable key only, no checkout, browser or mutation. | Keep. [Current Supabase documentation](https://supabase.com/docs/guides/platform/free-project-pausing) still says Free projects may pause after seven days of low activity; a few queries daily can prevent it. The RLS check has independent value. |
| `play-release.yml` | Manual release-gate dispatcher. `gate=worker-image` builds the verifier container with a 20-minute cap; `gate=hosted` and `gate=remote` call the two focused workflows from the selected commit. | Worker-image uses Docker only; hosted gets only Supabase secrets, remote also gets Browserbase and temporary Preview access. No deployment. | Keep the unique container validation and provide one branch-safe entrypoint for the two new workflows. Removed duplicate `test:play` and `test:verifier` execution because `full` and `fast` already run them. |

`full` deliberately retains separate `npm ci` and browser installation in two jobs to preserve independent results. Across the latest twelve runs, installing all three Playwright browsers took median 0.87 minutes in `engine` and 0.95 in `application` (p95 1.30 and 1.18). The engine's test step itself took median 30.2 minutes. Browser cache storage and restore overhead would target less than two minutes while retaining multiple large browser revisions, so no Playwright cache was added. The npm cache already exists through `setup-node`.

## Measured runner use and $0 policy

The latest twelve split-job `full` runs had these actual job times (minutes). The total is the sum of job durations, which is what private-repository runner billing uses, rather than the parallel wall time.

| Job | Median | p95 |
| --- | ---: | ---: |
| schema | 0.28 | 0.87 |
| engine | 31.20 | 32.35 |
| database | 1.17 | 1.60 |
| application | 7.82 | 8.35 |
| **aggregate** | **40.10** | **41.98** |

The 100 most recent `fast` runs (4–23 September) were 67 pushes, 32 PRs and one manual dispatch, with median wall time 2.6 and p95 3.6 minutes. Recent `deployed` runs had median wall time 1.4, p95 2.3 minutes. `keepalive` median/p95 was 0.2 minutes. These are wall-time approximations for single-job workflows; exact billed minutes round by GitHub's accounting rules.

| Workload model | Old daily full | New twice-weekly full |
| --- | ---: | ---: |
| `full` at 40.1 min/run | ~1,203 min/30 days | ~348 min/30 days (8.7 runs) |
| `fast` at 150 runs × 2.6 min | ~390 | ~390 |
| `deployed` at 45 main pushes × 1.4 min | ~63 | ~63 |
| `keepalive` at 30 × 0.2 min | ~6 | ~6 |
| One manual hosted run, remote run and worker build (reserved) | ~50 | ~50 |
| **modeled total** | **~1,712** | **~857** |

Using the observed p95 values and the same workload counts, the new model is approximately 1,065 minutes. Push rate and provider waits can vary; the schedule leaves about 935 of the [2,000 included GitHub Free private-repository minutes](https://docs.github.com/en/billing/concepts/product-billing/github-actions) available under this observed-workload model. The 11 September account snapshot documented in `DEPLOYMENT_STATUS.md` had 573/2,000 minutes used and a stop-spend $0 budget. The billing API is unavailable to the current GitHub token (`user` scope required), so current account-wide usage and the present stop-spend setting must be rechecked in GitHub Billing before frequent manual runs. `FBWG_ZERO_DOLLAR_ACTIONS` is a job gate; it does not itself cap spending.

[Browserbase Free currently advertises one browser hour per month and a 15-minute session maximum](https://www.browserbase.com/pricing). `network-remote` has no schedule, caps a session at 14 minutes and offers at most two games per dispatch. The operating policy is at most two manual remote runs per month before checking Browserbase usage, reserving at most 28 of 60 included minutes. The run creates no Browserbase proxies and requests no paid features. The JSON artifact is a few kilobytes at three-day retention; failure-only retention prevents long-term accumulation. No browser binary cache was added; the existing npm cache snapshot was about 86 MB, far below GitHub's separate 10 GB cache allowance. The artifact and cache figures are estimates until a remote run provides measured sizes.

## Exact release path and safety

1. On the intended commit, obtain a successful Vercel Preview deployment with Preview-only `FBWG_PATH_MANAGER=1` and `FBWG_NETWORK_TEST_HOOKS=1`. Keep production flags at zero. Refresh the temporary Vercel share URL in the GitHub secret and confirm the protected Preview `/version.txt` equals the full SHA.
2. Run `fast` on the PR, then, after merge, dispatch `full` on `main`. All four `full` jobs must pass.
3. Dispatch `play-release.yml` with `gate=hosted` for live TURN and local hosted migrations. It may also be dispatched directly from `main`.
4. Dispatch `play-release.yml` with `gate=remote`, the exact successful Preview URL and full SHA. Require different public egress IPs, natural RTC, relay gameplay progress, close/silent/repeated recovery, zero desyncs, continuity and a matching confirmed digest. Require account/profile cleanup. The focused workflow may also be dispatched directly from `main`.
5. Run `play-release.yml` with `gate=worker-image` and inspect the production static build/check result. Human review of the evidence precedes any merge or production flag change. `deployed` then checks the actual Workers production origin after a main push; it never deploys itself.

The proposed future `main` branch rule is: require a pull request, require the `fast / test` status, block force pushes and deletion, and require no other person's approval. This is a proposal only; no branch protection was applied. The project is **not production-ready** until the manual `full`, hosted and distributed runs on this SHA all pass and the final production gate is reviewed.
