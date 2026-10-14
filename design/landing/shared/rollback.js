/*
 * Rollback, drawn frame by frame from a deterministic script.
 *
 * This is the one place on the landing page where motion IS the information:
 * the point is how a prediction turns into a correction over time, which a
 * still frame cannot show. The report's warning applies with full force --
 * animations fail when information "disappears or changes too quickly" -- so:
 *   - it runs at quarter speed by default, with 1/6x and 1x available
 *   - it can be paused, stepped a frame at a time, and scrubbed
 *   - every state is a pure function of the frame number, so a paused frame
 *     is a complete picture, and the log keeps what already happened on screen
 *
 * The numbers are the build's own (docs/DEEP_DIVE/NETCODE.md): 26 fps, a single
 * snapshot refreshed once the settled frontier is 8 frames past it, ~0.04 ms
 * to re-simulate a frame, and the peer's input predicted by repeating its last
 * confirmed bits. The 4-frame packet delay is illustrative.
 *
 * At the end, the play button becomes Restart (see syncButton).
 */
const FIRST = 96, LAST = 124, DELAY = 4, SNAP_EVERY = 8, RESIM_MS = 0.04;

/*
 * What each player actually pressed, as the engine's own input bits
 * (net/hash.ts applyInput): Fireboy 1 left, 2 right, 4 up; Watergirl 8, 16, 32.
 *
 * Tuned against the real level-1 physics with LevelHost, the production
 * stepper (tools/tune.mjs), so the story is true in the engine and not just in
 * the diagram: Fireboy clears the water pool with his jump at f104, Watergirl
 * clears the lava with hers at f108, and both land and live. The timing is
 * tight on purpose. Without the jump she would fall into the lava at f112,
 * which is exactly the frame her real input reaches you: the prediction runs
 * her to the very edge, and the correction lands in time.
 */
export const you = (f) => (f >= 60 && f < 122 ? 2 : 0) | (f === 104 ? 4 : 0);
export const friend = (f) => (f >= 80 && f < 132 ? 16 : 0) | (f === 108 || f === 109 ? 32 : 0);
const RUN = 2 | 16, JUMP = 4 | 32;
const glyph = (b) => (b & JUMP && b & RUN ? "↗" : b & JUMP ? "↑" : b & RUN ? "→" : "·");
const word = (b) => (b & JUMP ? "jump" : b & RUN ? "run" : "stop");

/** sam_k's input for frame f as your machine knows it at `now`: real up to the
 *  frontier, then "whatever sam_k was last doing". */
export function knownFriend(now) {
  const frontier = now - DELAY;
  const last = friend(frontier);
  return (f) => (f <= frontier ? friend(f) : last);
}

/** Watergirl's position under a given input function: 1 px/frame running, a 7-frame hop. */
const HOP = [0, 3, 5, 6, 5, 3, 0];
function trajectory(input, upTo) {
  let x = 0, hopAt = -99;
  const out = {};
  for (let f = FIRST; f <= upTo; f++) {
    const k = input(f);
    if (k & JUMP && f - hopAt >= HOP.length) hopAt = f;
    if (k & RUN) x += 1;
    const h = f - hopAt < HOP.length ? HOP[f - hopAt] : 0;
    out[f] = { x, y: h };
  }
  return out;
}

/** Everything the diagram shows at `now`, derived, never accumulated. */
export function stateAt(now) {
  const frontier = now - DELAY;            // last frame of sam_k's input we have
  const predictedAt = knownFriend(now);
  // The one snapshot: moved forward once the settled frontier is SNAP_EVERY past it.
  const snapAt = (fr) => { let v = FIRST; for (let f = FIRST; f <= fr; f++) if (f - v >= SNAP_EVERY) v = f; return v; };
  // A rollback happens when a newly received frame differs from the guess made
  // for it one frame earlier, which was "repeat the previous frame's input".
  const rollbacks = [];
  for (let n = FIRST + DELAY + 1; n <= now; n++) {
    const fr = n - DELAY;
    if (friend(fr) !== friend(fr - 1)) {
      const from = snapAt(fr - 1);
      rollbacks.push({ at: n, frame: fr, got: friend(fr), guessed: friend(fr - 1), snap: from, frames: n - from });
    }
  }
  const snapNow = snapAt(frontier);
  return {
    now, frontier, snap: snapNow, rollbacks, predictedAt,
    cells: Array.from({ length: LAST - FIRST + 1 }, (_, i) => {
      const f = FIRST + i;
      return {
        f,
        you: f <= now ? glyph(you(f)) : null,
        friend: f > now ? null : f <= frontier ? { k: glyph(friend(f)), sure: true } : { k: glyph(predictedAt(f)), sure: false },
      };
    }),
    shown: trajectory(predictedAt, now)[now],
    truth: trajectory(friend, now)[now],
  };
}

export const RANGE = { FIRST, LAST, DELAY, RESIM_MS };

const PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5-7-4.5Z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5h2v9H5zM9 3.5h2v9H9z" fill="currentColor"/></svg>';
const BACK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3.5 5.5 8l5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const RESTART = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FWD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 3.5 5 4.5-5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/*
 * `instrument`: the compact form used under the live engine view. The current
 * frame is a pill in the frame-number row (not a tag hanging below the grid),
 * the snapshot's diamond starts the brace and the brace's label sits on its
 * line, and the log is one line: the latest thing that happened. Together that
 * removes three rows of vertical space that separated the timeline from the
 * picture it describes.
 */
export function createRollback(host, { autoplay = true, speed = 0.25, compact = false, world = true, instrument = false, onDraw } = {}) {
  host.classList.add("rb");
  if (instrument) host.classList.add("rb-inst");
  if (compact) host.classList.add("rb-compact");
  const cols = LAST - FIRST + 1;
  host.innerHTML = `
    <div class="rb-world" aria-hidden="true"${world ? "" : " hidden"}>
      <div class="rb-floor"></div>
      <div class="rb-ghost" title="Where sam_k really is"></div>
      <div class="rb-dot"></div>
      <div class="rb-legend"><span><i class="k-dot"></i>Watergirl on your screen</span><span><i class="k-ghost"></i>where sam_k actually is</span></div>
    </div>
    <div class="rb-scroll"><div class="rb-grid" style="--cols:${cols}" role="img" aria-label="Frame-by-frame input timeline for both players">
      <div class="rb-lab">Frame</div>${Array.from({ length: cols }, (_, i) => `<div class="rb-fn">${(FIRST + i) % 4 === 0 ? FIRST + i : ""}</div>`).join("")}
      <div class="rb-lab"><b class="fire">You</b><small>Fireboy</small></div>${Array.from({ length: cols }, () => '<div class="rb-c rb-you"></div>').join("")}
      <div class="rb-lab"><b class="water">sam_k</b><small>Watergirl</small></div>${Array.from({ length: cols }, () => '<div class="rb-c rb-fr"></div>').join("")}
      <div class="rb-overlay"><div class="rb-bracket"><span></span></div><div class="rb-snap"><span>snapshot</span></div><div class="rb-front"></div><div class="rb-now"></div></div>
    </div></div>
    <div class="rb-keys" aria-hidden="true"><span><i class="k-sure"></i>Received</span><span><i class="k-guess"></i>Predicted</span><span><i class="k-fix"></i>Corrected by rollback</span><span class="rb-shortcuts"><kbd>Space</kbd> play · <kbd>←</kbd><kbd>→</kbd> step · <kbd>Home</kbd> restart</span></div>
    <div class="rb-bar">
      <div class="rb-btns">
        <button type="button" class="icon-btn rb-back" aria-label="Previous frame">${BACK}</button>
        <button type="button" class="icon-btn rb-play" aria-label="Pause">${PAUSE}</button>
        <button type="button" class="icon-btn rb-fwd" aria-label="Next frame">${FWD}</button>
      </div>
      <input class="rb-range" type="range" min="${FIRST}" max="${LAST}" step="1" aria-label="Frame">
      <div class="seg rb-speed" role="radiogroup" aria-label="Speed">
        <button type="button" role="radio" data-s="0.1666667" aria-label="One sixth speed">⅙×</button><button type="button" role="radio" data-s="0.25" aria-label="Quarter speed">¼×</button><button type="button" role="radio" data-s="1" aria-label="Full speed">1×</button>
      </div>
    </div>
    <ol class="rb-log" aria-label="What has happened so far"></ol>`;

  const $ = (s) => host.querySelector(s);
  const you$ = [...host.querySelectorAll(".rb-you")], fr$ = [...host.querySelectorAll(".rb-fr")];
  const range = $(".rb-range"), play = $(".rb-play"), log = $(".rb-log");
  let now = FIRST, playing = false, last = 0, acc = 0, rate = speed;
  const pos = (f) => `calc(var(--lab) + (100% - var(--lab)) * ${(f - FIRST) / cols})`;
  const width = (n) => `calc((100% - var(--lab)) * ${n / cols})`;

  function draw() {
    const s = stateAt(now);
    const lr = s.rollbacks.at(-1);
    const fresh = lr && now - lr.at < 6 ? lr : null;
    s.cells.forEach((c, i) => {
      you$[i].textContent = c.you ?? "";
      you$[i].className = "rb-c rb-you" + (c.you ? " on" : "");
      const fr = c.friend;
      fr$[i].textContent = fr ? fr.k : "";
      fr$[i].className = "rb-c rb-fr" + (fr ? (fr.sure ? " sure" : " guess") : "") + (fr && fresh && c.f >= fresh.frame && c.f <= fresh.at ? " fix" : "");
    });
    if (instrument) {
      host.querySelectorAll(".rb-fn").forEach((el, i) => {
        const f = FIRST + i, isNow = f === now;
        // The current frame is a pill that may overhang its narrow column.
        if (isNow) el.innerHTML = `<b>${f}</b>`;
        else el.textContent = f % 4 === 0 && Math.abs(f - now) > 2 ? String(f) : "";
        el.classList.toggle("now", isNow);
      });
    }
    $(".rb-now").style.left = pos(now);
    $(".rb-now").style.width = width(1);
    $(".rb-front").style.left = pos(s.frontier + 1);
    $(".rb-front").style.opacity = s.frontier >= FIRST ? 1 : 0;
    $(".rb-snap").style.left = pos(s.snap);
    $(".rb-snap").style.width = width(1);
    const r = s.rollbacks.at(-1);
    const live = r && now - r.at < 6;
    const br = $(".rb-bracket");
    br.style.opacity = live ? 1 : 0;
    if (r) {
      br.style.left = pos(r.snap);
      br.style.width = width(r.at - r.snap + 1);
      br.firstElementChild.textContent = instrument
        ? `rewound to f${r.snap} · re-simulated ${r.frames} frames · ${(r.frames * RESIM_MS).toFixed(2)} ms`
        : `re-simulated ${r.frames} frames · ${(r.frames * RESIM_MS).toFixed(2)} ms`;
    }
    $(".rb-snap").classList.toggle("quiet", !!(instrument && live));
    const k = compact ? 2.2 : 3;
    $(".rb-dot").style.transform = `translate(calc(${s.shown.x * k}cqw), ${-s.shown.y * 7}px)`;
    $(".rb-ghost").style.transform = `translate(calc(${s.truth.x * k}cqw), ${-s.truth.y * 7}px)`;
    $(".rb-ghost").style.opacity = s.shown.x === s.truth.x && s.shown.y === s.truth.y ? 0 : 1;
    range.value = String(now);
    // On a narrow screen the grid scrolls; keep "now" in view.
    const sc = $(".rb-scroll");
    if (sc.scrollWidth > sc.clientWidth) {
      const nowEl = $(".rb-now"), x = nowEl.offsetLeft;
      if (x < sc.scrollLeft + 80 || x > sc.scrollLeft + sc.clientWidth - 80) sc.scrollLeft = x - sc.clientWidth / 2;
    }
    onDraw?.(s);
    if (instrument) {
      const x = s.rollbacks.at(-1);
      log.innerHTML = x && now - x.at < 8
        ? `<li class="ev"><span class="t-data">f${x.at}</span> sam_k's input for f${x.frame} arrived: <b>${word(x.got)}</b>, not <b>${word(x.guessed)}</b>. Rewound and re-simulated ${x.frames} frames in ${(x.frames * RESIM_MS).toFixed(2)} ms.</li>`
        : `<li><span class="t-data">f${now}</span> Your input is on screen this frame. sam_k's is known up to f${Math.max(FIRST, s.frontier)}.</li>`;
      return;
    }
    log.innerHTML = [
      `<li><span class="t-data">f${now}</span> Your input is on screen this frame. sam_k's is known up to f${Math.max(FIRST, s.frontier)}.</li>`,
      ...s.rollbacks.slice().reverse().map((x) => `<li class="ev"><span class="t-data">f${x.at}</span> Input for f${x.frame} arrived: <b>${word(x.got)}</b>, predicted <b>${word(x.guessed)}</b>. Rewound to f${x.snap} and re-simulated ${x.frames} frames in ${(x.frames * RESIM_MS).toFixed(2)} ms.</li>`),
    ].join("");
  }

  /*
   * At the last frame the play button becomes Restart. Restart goes back to the
   * start and waits: it does not play by itself, because the person who pressed
   * it may want to step through, and the next press of the same button is Play.
   */
  const syncButton = () => {
    const atEnd = now >= LAST && !playing;
    play.innerHTML = playing ? PAUSE : atEnd ? RESTART : PLAY;
    play.setAttribute("aria-label", playing ? "Pause" : atEnd ? "Restart from the beginning" : "Play");
    play.classList.toggle("rb-restart", atEnd);
  };
  const setPlaying = (p) => {
    playing = p;
    syncButton();
    if (p) { last = performance.now(); acc = 0; requestAnimationFrame(tick); }
  };
  function tick(t) {
    if (!playing) return;
    acc += (t - last) * rate; last = t;
    const step = 1000 / 26;
    while (acc >= step) { acc -= step; if (now < LAST) now++; }
    draw();
    if (now >= LAST) { setPlaying(false); return; }
    requestAnimationFrame(tick);
  }
  const syncSpeed = () => { for (const b of host.querySelectorAll(".rb-speed button")) b.setAttribute("aria-checked", String(Math.abs(Number(b.dataset.s) - rate) < 1e-3)); };

  play.addEventListener("click", () => {
    if (!playing && now >= LAST) { now = FIRST; draw(); syncButton(); return; }
    setPlaying(!playing);
  });
  $(".rb-back").addEventListener("click", () => { setPlaying(false); now = Math.max(FIRST, now - 1); draw(); syncButton(); });
  $(".rb-fwd").addEventListener("click", () => { setPlaying(false); now = Math.min(LAST, now + 1); draw(); syncButton(); });
  range.addEventListener("input", () => { setPlaying(false); now = Number(range.value); draw(); syncButton(); });
  host.querySelector(".rb-speed").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; rate = Number(b.dataset.s); syncSpeed(); });
  /*
   * Keyboard, like a video player, while focus is anywhere inside it (click
   * the picture, or Tab in): Space plays and pauses (and restarts at the end,
   * as the button does), arrows step one frame, Home and End jump. Scoped to
   * focus so it never takes Space or the arrows away from page scrolling.
   * Native keys win where they already mean something: Space on a button
   * presses that button, arrows on the slider move the slider.
   */
  const scope = host.closest(".net-instrument") ?? host;
  if (!scope.hasAttribute("tabindex")) scope.tabIndex = 0;
  scope.setAttribute("aria-keyshortcuts", "Space ArrowLeft ArrowRight Home End");
  scope.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const onButton = e.target instanceof HTMLElement && e.target.closest("button");
    const onSlider = e.target === range;
    const go = (f) => { e.preventDefault(); setPlaying(false); now = f; draw(); syncButton(); };
    if (e.key === " " || e.key === "k") { if (onButton && e.key === " ") return; e.preventDefault(); play.click(); }
    else if (e.key === "ArrowLeft" && !onSlider) go(Math.max(FIRST, now - 1));
    else if (e.key === "ArrowRight" && !onSlider) go(Math.min(LAST, now + 1));
    else if (e.key === "Home") go(FIRST);
    else if (e.key === "End") go(LAST);
  });
  syncSpeed();
  draw();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (autoplay && !reduce) {
    // Start when it is actually on screen, so nobody arrives at the end of it.
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); setPlaying(true); } }, { threshold: 0.5 });
    io.observe(host);
  } else setPlaying(false);
  return { seek(f) { setPlaying(false); now = f; draw(); syncButton(); }, play: () => setPlaying(true), pause: () => setPlaying(false), redraw: draw, range: RANGE };
}
