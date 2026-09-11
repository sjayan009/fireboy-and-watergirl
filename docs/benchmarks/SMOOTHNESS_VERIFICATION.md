# Gameplay smoothness verification — 11 September 2026

**Verified improvement in all three valid before/after comparisons; consistent 60 FPS is not established.** This is a new measurement session, including an actual level on the live deployment. It does not replace or silently rewrite the earlier audit.

## Repeated comparison

Same Intel(R) Core(TM) Ultra 9 185H, Windows 10.0.26200, Chromium 151.0.7922.34 headless, Node v22.17.1. Three 20-second runs per version, sequential order baseline/current, current/baseline, baseline/current. None of these browser benchmarks ran concurrently with another agent-started browser benchmark or test. Existing desktop applications were left running. Machine conditions varied substantially; these are observations, not a controlled hardware certification.

Both versions use identical local assets, canvas instrumentation and tracing. A position-feedback controller dispatches real DOM arrow-key events every approximately 120 ms to keep Fireboy near his starting ledge. It reads position and never teleports the character or writes physics state. All six accepted runs retained a live level with zero missing art and zero page exceptions.

The table is the **median of three per-run statistics**, not percentiles pooled across frames. CPU is Chromium main-task duration/wall time; heap is JavaScript heap, not total process/GPU memory. Input latency is a DOM-event-to-render-response proxy, not physical input-to-photon.

| Metric | Original | Current |
| --- | ---: | ---: |
| Frame interval p50 (ms) | 100.00 | 16.70 |
| Frame interval p95 (ms) | 100.10 | 16.80 |
| Frame interval p99 (ms) | 116.80 | 33.40 |
| Render time p50 (ms) | 31.50 | 6.60 |
| Render time p95 (ms) | 35.50 | 9.60 |
| Render time p99 (ms) | 39.70 | 10.60 |
| Distinct canvas command updates/sec | 10.50 | 57.82 |
| Distinct controlled-character positions/sec | 4.78 | 41.09 |
| Input event to render p50 (ms) | 97.20 | 30.90 |
| Input event to render p95 (ms) | 197.00 | 51.30 |
| Input event to render p99 (ms) | 263.30 | 58.30 |
| Main-task CPU fraction (%) | 98.99 | 94.13 |
| JS heap used (MB) | 8.94 | 8.74 |
| DrawImage calls p95 | 434.00 | 65.00 |
| Scene visits p95 | 454.00 | 85.00 |
| Tasks longer than 50 ms | 209.00 | 2.00 |
| Longest task (ms) | 359.00 | 233.00 |
| GC collector time (ms) | 39.95 | 21.81 |
| Cold scene preparation (ms) | 1738.90 | 886.90 |

## Every accepted run

| Run | Frame p95 / p99 (ms) | Render p95 (ms) | Distinct character positions/sec | Input-to-render p95 (ms) |
| --- | ---: | ---: | ---: | ---: |
| Original 1 | 250.10 / 300.00 | 89.10 | 5.06 | 250.50 |
| Current 1 | 33.40 / 33.40 | 13.30 | 35.42 | 58.80 |
| Original 2 | 100.10 / 116.70 | 35.30 | 4.77 | 193.70 |
| Current 2 | 16.80 / 33.40 | 9.60 | 41.59 | 51.30 |
| Original 3 | 100.10 / 116.80 | 35.50 | 4.78 | 197.00 |
| Current 3 | 16.80 / 33.30 | 9.50 | 41.09 | 49.70 |

Character-position counts observe actual canvas transforms at character drawing, rather than counting rAF callbacks. Whole-canvas counts hash drawing commands, not GPU pixels. Canvas interception/tracing itself adds overhead. The current version still has dropped display frames and startup stalls. Its CPU fraction remains high under this instrumentation.

Two preliminary 30-second comparisons used the older time-parity steering. One original-engine run ended the level: very slow callbacks skipped direction phases and allowed movement into a hazard. All preliminary runs are excluded from the aggregate, including the successful ones. Their raw `verify-before/after-1/2.json` records remain available. The corrected controller is optional (`FBWG_BENCH_STEERING=position`); default timed steering retains reproducibility of the original audit.

## Live deployed level

At https://fireboy-and-watergirl.sjayan009.workers.dev, version 60ce7769b91690da50250eecbcdb0a28cfce2839, a disposable confirmed account signed in. Actual canvas controls opened Play, then Adventure 1. The app-created GameView was observed through test-only instrumentation; no replacement engine or altered production asset was served. Its downloaded engine SHA-256 is 53f9a8b306ad68c97ba28502f96e9ca5c16effc3971c1a6b75c71c2591bfe1c1, identical to the audited deployed engine.

During 20 seconds of actual level movement: frame p50/p95/p99 **33.30/33.40/50.00 ms**; render p95/p99 **15.20/17.30 ms**; **32.22 distinct character positions/sec**; input-to-render p95 **60.10 ms**; main-task CPU **96.33%**; JS heap **12.24 MB**. The level stayed active, art was complete and no page exceptions occurred. The disposable account was deleted.

This live run includes the application shell and production assets; it is not a matched original/current hosted comparison. Headless performance does not establish physical monitor smoothness. No other player, remote NAT, WAN gameplay path or photon sensor was involved.

The original canvas label reading `26.0 fps` counts Flash `ENTER_FRAME` simulation events. It is not the display-render rate; the renderer measurements above observe drawing independently of that label.

## Simulation, input and rollback checks

```text
60 Hz: distinct local samples 6 -> 12; input 50.00ms at same sim frame 7; 500/1500ms throttle bounded
120 Hz: distinct local samples 6 -> 27; input 33.33ms at same sim frame 7; 500/1500ms throttle bounded
144 Hz: distinct local samples 6 -> 33; input 27.78ms at same sim frame 7; 500/1500ms throttle bounded
240 Hz: distinct local samples 7 -> 56; input 25.00ms at same sim frame 7; 500/1500ms throttle bounded
same-frame late-input rollback presented exactly once with zero accumulator
[{"level":1,"equal":true,"objects":26194,"slots":109392,"missing":0},{"level":8,"equal":true,"objects":26724,"slots":111279,"missing":0}]
chromium : aba863c1 over 600 frames ok
  firefox  : aba863c1 over 600 frames ok
  webkit   : aba863c1 over 600 frames ok

CROSS-ENGINE PASSED
```

The refresh-rate tests exercise real GameView scheduling with virtual timestamps. Smoothing and unsmoothed modes have identical state hashes and first-input-response simulation frame/display callback. The late-input test performs a real rollback with zero elapsed display time and verifies immediate corrected presentation. Snapshot guards compare all fields and forbid even transient transform/filter/mask writes on two levels. Chromium, Firefox and WebKit each executed the same 600-frame replay with hash `aba863c1`.

## Provenance and reproduction

The preserved original engine was rebuilt independently from Git revision 7c399f8603918997197785957bcb05b86c72b89f. All 49 JavaScript outputs matched the benchmark baseline byte-for-byte. [Baseline identity](../../benchmarks/verify-baseline-identity.json) records its combined hash. Raw per-run commit fields identify the harness checkout; the baseline engine source revision is the one verified here.

```powershell
$env:FBWG_BENCH_SECONDS='20'
$env:FBWG_BENCH_STEERING='position'
$env:FBWG_BENCH_ENGINE='.cache/performance/baseline-engine'
node engine/test/performance.mjs repeat-before
$env:FBWG_BENCH_ENGINE='engine/dist'
node engine/test/performance.mjs repeat-after
node engine/test/render-schedule.mjs
node engine/test/render-readonly.mjs
node engine/test/crossengine.mjs
```

The baseline folder is a local compiled artifact, not a production dependency. For another checkout, extract the recorded baseline Git revision and build its engine before setting `FBWG_BENCH_ENGINE`. Repeated runs should alternate order and run alone.

[Machine-readable summary](../../benchmarks/smoothness-verification.json) links all six accepted raw runs and the [live record](../../benchmarks/verify-live.json). The current session changes the benchmark controller and adds evidence only; deployed gameplay code is unchanged.

Remaining field acceptance: physical display refresh/presentation, physical input-to-photon, low-end/mobile GPU behavior and two-player WAN/NAT/relay conditions. The evidence supports a rendering improvement; it does not certify universally stutter-free gameplay.
