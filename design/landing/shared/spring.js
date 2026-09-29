/*
 * A spring for one number, in Apple's two designer-facing terms.
 *
 *   response  how quickly it gets there, in seconds (not a duration: a spring
 *             has none; the settle time falls out of the physics)
 *   damping   1 = critically damped, no overshoot. Apple's default for UI that
 *             is not thrown by a gesture, which is everything here
 *
 * Why not a CSS transition: re-targeting a transition mid-flight restarts its
 * curve from zero velocity, a visible kink when someone clicks twice quickly.
 * This keeps its current position AND velocity when the target changes, so a
 * second click bends the motion instead of breaking it (Designing Fluid
 * Interfaces, WWDC 2018: always animate from the presentation value).
 *
 * Under prefers-reduced-motion it jumps to the target: the state still
 * changes, nothing travels.
 */
const reduce = matchMedia("(prefers-reduced-motion: reduce)");

export function spring(apply, { response = 0.35, damping = 1, value = 0 } = {}) {
  const k = (2 * Math.PI / response) ** 2;          // stiffness, mass 1
  const c = 2 * damping * Math.sqrt(k);             // damping coefficient
  let x = value, v = 0, target = value, raf = 0, last = 0;
  apply(x);

  const step = (now) => {
    // Fixed sub-steps: stable at any frame rate, and after a stalled frame.
    let dt = Math.min(0.064, (now - last) / 1000);
    last = now;
    while (dt > 0) {
      const h = Math.min(dt, 1 / 240);
      v += (-k * (x - target) - c * v) * h;
      x += v * h;
      dt -= h;
    }
    if (Math.abs(x - target) < 0.0005 && Math.abs(v) < 0.005) { x = target; v = 0; apply(x); raf = 0; return; }
    apply(x);
    raf = requestAnimationFrame(step);
  };

  return {
    /** Move to `to`, carrying whatever velocity it has now. */
    to(to) {
      target = to;
      if (reduce.matches) { cancelAnimationFrame(raf); raf = 0; x = to; v = 0; apply(x); return; }
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(step); }
    },
    /** Jump without animating (first paint, resets). */
    set(to) { cancelAnimationFrame(raf); raf = 0; x = target = to; v = 0; apply(x); },
    get value() { return x; },
  };
}
