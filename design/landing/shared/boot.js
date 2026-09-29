/*
 * "Starting engine": a progress ring for the engine-backed panels.
 *
 * The ring fills clockwise from the top: the first half in ember, the second in
 * water, so at 100% it is the two players' colours, one each. The number is
 * real. The caller reports progress from actual work (renderer loaded, art
 * downloaded, snapshots simulated), never from a timer.
 *
 * Report: a noticeable wait should "explain that work is ongoing"; a long one
 * should "show honest progress". It is also a progressbar to assistive tech,
 * and it never moves backwards.
 */
const R = 52, C = 2 * Math.PI * R;

export function createBoot(host, label = "Starting engine") {
  const el = document.createElement("div");
  el.className = "boot";
  el.setAttribute("role", "progressbar");
  el.setAttribute("aria-label", label);
  el.setAttribute("aria-valuemin", "0");
  el.setAttribute("aria-valuemax", "100");
  el.innerHTML = `
    <p class="boot-label">${label}</p>
    <div class="boot-ring">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle class="boot-track" cx="60" cy="60" r="${R}"/>
        <circle class="boot-fire" cx="60" cy="60" r="${R}" stroke-dasharray="0 ${C}" style="visibility:hidden"/>
        <circle class="boot-water" cx="60" cy="60" r="${R}" stroke-dasharray="0 ${C}" stroke-dashoffset="${-C / 2}" style="visibility:hidden"/>
      </svg>
      <span class="boot-n t-data">0%</span>
    </div>`;
  host.appendChild(el);
  const fire = el.querySelector(".boot-fire"), water = el.querySelector(".boot-water"), n = el.querySelector(".boot-n");
  let shown = 0;
  return {
    set(p) {
      p = Math.max(shown, Math.min(1, p));
      shown = p;
      fire.setAttribute("stroke-dasharray", `${Math.min(p, 0.5) * C} ${C}`);
      water.setAttribute("stroke-dasharray", `${Math.max(0, p - 0.5) * C} ${C}`);
      // A zero-length dash with a round cap still paints a dot; hide empty arcs.
      fire.style.visibility = p > 0 ? "visible" : "hidden";
      water.style.visibility = p > 0.5 ? "visible" : "hidden";
      const pct = Math.round(p * 100);
      n.textContent = `${pct}%`;
      el.setAttribute("aria-valuenow", String(pct));
    },
    done() {
      this.set(1);
      el.classList.add("boot-out");
      setTimeout(() => el.remove(), 260);
    },
    fail(msg) {
      el.querySelector(".boot-label").textContent = msg;
      el.classList.add("boot-failed");
    },
  };
}

/** Track a SpriteRenderer's downloads while `promise` runs: 0..1 of what it asked for. */
export function trackArt(sprites, promise, onProgress) {
  let most = 0, raf = 0;
  const tick = () => {
    const pending = sprites.loading;
    most = Math.max(most, pending);
    onProgress(most ? 1 - pending / most : 0);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return promise.finally(() => { cancelAnimationFrame(raf); onProgress(1); });
}
