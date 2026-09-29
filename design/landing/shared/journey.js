/*
 * "From sign-in to level one", acted out.
 *
 * One state machine, two drivers. A demo cursor plays the flow once when the
 * section is on screen: it types an email, switches characters, sends the
 * invite, and sam_k accepts. Every control is also real. The moment a person
 * touches anything, the demo stops and they carry on from wherever it was.
 *
 * Grounded in the report:
 *   - "A technically clickable element that does not look operable creates
 *     discovery cost ... a decorative card that looks clickable but is not
 *     creates false affordance." So nothing here looks pressable unless it is.
 *   - Acknowledgement is not completion. "Invite sent. Waiting for sam_k" is a
 *     state of its own; "accepted" appears only after it.
 *   - Object permanence. Switching characters moves the ember and the water
 *     fills across to their new owners instead of repainting two labels, so
 *     the eye can see that the roles traded places.
 *   - Anything that moves by itself for more than five seconds can be paused
 *     (WCAG 2.2.2): Pause demo stops it where it is, Resume carries on, and
 *     Replay starts it over. It starts only when it is on screen.
 *   - Reduced motion: no cursor travel. The cards open on the finished flow.
 */
import { spring } from "./spring.js";

const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SPIN = '<span class="spin" aria-hidden="true"></span>';
const EMAIL = "you@example.com";
const NAME = { fire: "Fireboy", water: "Watergirl" };

export function createJourney(root) {
  const $ = (s) => root.querySelector(s);
  const steps = [...root.querySelectorAll(".step")];
  const google = $('[data-act="google"]'), email = $('[data-act="email-input"]'), cont = $('[data-act="email"]');
  const note1 = $('[data-note="1"]'), roles = $(".roles"), swap = $('[data-act="switch"]'), send = $('[data-act="invite"]');
  const youLabel = $('[data-slot="you"]'), themLabel = $('[data-slot="them"]');
  const pending = $('[data-slot="pending"]'), saveSlot = $('[data-slot="save"]');
  const status = $("[data-status]"), pauseBtn = $("[data-pause]"), replayBtn = $("[data-replay]");
  const cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.innerHTML = '<span class="ripple"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 2.5v17.2l4.6-4.3 2.9 6.6 3.1-1.4-2.9-6.4h6.3Z" fill="#fff" stroke="#1d1a13" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  root.appendChild(cursor);

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let signedIn = false, invited = false, accepted = false, you = "fire";
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

  // ---- the state ------------------------------------------------------------
  const LABEL = { 1: "Sign In", 2: "Invite a friend, choose roles", 3: "Play, and come back together" };
  function setStage(n) {
    steps.forEach((el, i) => {
      const s = i + 1 < n ? "done" : i + 1 === n ? "active" : "upcoming";
      el.dataset.state = s;
      el.querySelector(".step-state").textContent = s === "done" ? "Done" : s === "active" ? "Now" : "Next";
    });
    status.innerHTML = n > 3 ? "<b>All three steps done.</b> You and sam_k are on level one." : `<b>Step ${n} of 3:</b> ${LABEL[n]}`;
  }
  function signIn(who) {
    if (signedIn) return;
    signedIn = true;
    google.setAttribute("aria-disabled", "true"); cont.setAttribute("aria-disabled", "true");
    email.readOnly = true;
    note1.className = "vg-note ok";
    note1.textContent = `Signed in as ${who}.`;
    setStage(2);
    syncSend();
  }
  function syncSend() {
    send.setAttribute("aria-disabled", String(!signedIn || invited));
    swap.setAttribute("aria-disabled", String(invited));
    if (!invited) pending.innerHTML = signedIn ? "Ready to send." : "Sign in first.";
  }
  // The two fills trade seats on critically damped springs: position 0 is the
  // You seat, 1 is sam_k's. A fast double-click reverses them mid-swap
  // smoothly, carrying their velocity, instead of snapping back to the start.
  const seat = (el) => (p) => { el.style.transform = `translateX(calc(${p} * (100% + .1875rem)))`; };
  const fireSeat = spring(seat(roles.querySelector(".fill-fire")), { response: 0.35, value: 0 });
  const waterSeat = spring(seat(roles.querySelector(".fill-water")), { response: 0.35, value: 1 });
  function showRoles() {
    roles.dataset.you = you;
    fireSeat.to(you === "fire" ? 0 : 1);
    waterSeat.to(you === "fire" ? 1 : 0);
    const them = you === "fire" ? "water" : "fire";
    youLabel.textContent = `You: ${NAME[you]}`;
    themLabel.textContent = `sam_k: ${NAME[them]}`;
  }
  function switchRoles() {
    if (invited) return;
    you = you === "fire" ? "water" : "fire";
    showRoles();
  }
  function invite(autoAccept = true) {
    if (!signedIn || invited) return;
    invited = true;
    syncSend();
    send.textContent = "Invite sent";
    pending.className = "pending";
    pending.innerHTML = `${SPIN}Invite sent. Waiting for sam_k to accept.`;
    if (autoAccept) later(accept, 1600);
  }
  function accept() {
    if (accepted) return;
    accepted = true;
    pending.className = "pending ok";
    pending.innerHTML = `${CHECK}sam_k accepted. You're ${NAME[you]}.`;
    saveSlot.innerHTML = `
      <div class="save">
        <div class="save-row"><b>You and sam_k</b><span class="t-data" style="color:var(--faint);font-size:.8125rem">Adventure 1 / 17</span></div>
        <div class="meter"><i></i></div>
        <div class="save-row"><span style="color:var(--dim);font-size:.875rem">Pair save created just now</span><span class="medals" aria-label="No medals yet"><span class="medal"></span><span class="medal"></span><span class="medal"></span></span></div>
      </div>`;
    requestAnimationFrame(() => requestAnimationFrame(() => { const m = saveSlot.querySelector(".meter i"); if (m) m.style.width = `${(1 / 17) * 100}%`; }));
    setStage(3);
    later(() => { if (accepted) setStage(4); }, 900);
  }
  function reset() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    signedIn = invited = accepted = false;
    you = "fire";
    showRoles();
    google.removeAttribute("aria-disabled"); cont.removeAttribute("aria-disabled");
    email.readOnly = false; email.value = ""; email.removeAttribute("aria-invalid"); email.classList.remove("is-focused");
    cont.textContent = "Continue with email";
    note1.className = "vg-note"; note1.textContent = "";
    send.textContent = "Send invite";
    pending.className = "pending";
    saveSlot.innerHTML = '<div class="save-empty">Your pair save appears here when sam_k accepts.</div>';
    syncSend();
    setStage(1);
  }

  // ---- a person driving it --------------------------------------------------
  const human = (e) => { if (e.isTrusted && !e.target.closest("[data-pause],[data-replay]")) stopDemo(); };
  root.addEventListener("pointerdown", human, true);
  root.addEventListener("keydown", human, true);
  google.addEventListener("click", () => { if (google.getAttribute("aria-disabled") !== "true") signIn("you (Google)"); });
  cont.addEventListener("click", () => {
    if (cont.getAttribute("aria-disabled") === "true") return;
    const v = email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
      email.setAttribute("aria-invalid", "true");
      note1.className = "vg-note err";
      note1.textContent = "Enter an email address, like name@example.com.";
      return;
    }
    email.removeAttribute("aria-invalid");
    signIn(v);
  });
  email.addEventListener("keydown", (e) => { if (e.key === "Enter") cont.click(); });
  swap.addEventListener("click", () => { if (swap.getAttribute("aria-disabled") !== "true") switchRoles(); });
  send.addEventListener("click", () => invite());

  // ---- the demo -------------------------------------------------------------
  let run = 0, running = false, paused = false, at = null;
  const moving = new Set();
  /** Wait `ms` of demo time: the clock stops while the demo is paused. */
  const wait = (ms, id) => new Promise((ok, no) => {
    let left = ms, last = performance.now();
    const tick = () => {
      if (id !== run) return no();
      const now = performance.now();
      if (!paused) left -= now - last;
      last = now;
      if (left <= 0) ok(); else setTimeout(tick, Math.min(40, left));
    };
    setTimeout(tick, Math.min(40, ms));
  });
  function place(el) {
    const r = el.getBoundingClientRect(), o = root.getBoundingClientRect();
    // Screen pixels per layout pixel (1 unless an ancestor is zoomed or scaled).
    const k = o.width / root.offsetWidth || 1;
    return { x: (r.left - o.left + r.width / 2) / k, y: (r.top - o.top + r.height / 2) / k };
  }
  async function moveTo(el, id) {
    const to = place(el);
    const from = at ?? { x: to.x - 60, y: to.y + 70 };
    // Longer trips take longer, within the report's panel-travel range.
    const d = Math.hypot(to.x - from.x, to.y - from.y), ms = Math.round(Math.min(720, Math.max(320, d * 0.9)));
    const a = cursor.animate([{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: `translate(${to.x}px, ${to.y}px)` }],
      { duration: ms, easing: "cubic-bezier(.77,0,.175,1)", fill: "forwards" });
    if (paused) a.pause();
    moving.add(a);
    at = to;
    try { await a.finished; } catch { /* cancelled */ } finally { moving.delete(a); }
    if (id !== run) throw 0;
  }
  async function click(el, id) {
    cursor.querySelector(".ripple").animate([{ opacity: .9, transform: "scale(.4)" }, { opacity: 0, transform: "scale(1.4)" }], { duration: 320, easing: "cubic-bezier(.23,1,.32,1)" });
    cursor.querySelector("svg").animate([{ transform: "scale(1)" }, { transform: "scale(.86)" }, { transform: "scale(1)" }], { duration: 160, easing: "ease-out" });
    el.classList.add("is-pressed");
    await wait(110, id);
    el.classList.remove("is-pressed");
  }
  function syncControls() {
    pauseBtn.setAttribute("aria-disabled", String(!running));
    pauseBtn.textContent = paused ? "Resume demo" : "Pause demo";
    pauseBtn.setAttribute("aria-pressed", String(paused));
  }
  async function demo() {
    const id = ++run;
    reset();
    running = true; paused = false; at = null;
    syncControls();
    try {
      cursor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, fill: "forwards" });
      await moveTo(email, id);
      await click(email, id);
      email.classList.add("is-focused");
      for (const ch of EMAIL) { email.value += ch; await wait(55, id); }
      await wait(220, id);
      email.classList.remove("is-focused");
      await moveTo(cont, id);
      await click(cont, id);
      cont.innerHTML = `${SPIN}Signing in`;
      await wait(650, id);
      cont.textContent = "Continue with email";
      signIn(EMAIL);
      await wait(450, id);
      await moveTo(swap, id);
      await click(swap, id);
      switchRoles();
      await wait(700, id);                    // let the swap be seen before moving on
      await moveTo(send, id);
      await click(send, id);
      invite(false);
      await wait(1500, id);
      accept();
      await wait(1100, id);
      cursor.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" });
    } catch { /* stopped or replaced */ }
    if (id === run) { running = false; paused = false; syncControls(); }
  }
  function stopDemo() {
    if (!running) return;
    run++;
    running = false; paused = false;
    for (const a of moving) a.cancel();
    cursor.getAnimations().forEach((a) => a.cancel());
    cursor.style.opacity = "0";
    if (cont.querySelector(".spin")) cont.textContent = "Continue with email";
    email.classList.remove("is-focused");
    syncControls();
  }
  pauseBtn.addEventListener("click", () => {
    if (!running) return;
    paused = !paused;
    for (const a of moving) { if (paused) a.pause(); else a.play(); }
    syncControls();
  });
  replayBtn.addEventListener("click", () => {
    stopDemo();
    replayBtn.textContent = "Replay demo";
    // On a phone, bring the cards into view before the cursor starts on them.
    if (root.getBoundingClientRect().height > innerHeight * 0.9) root.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    if (reduce) { reset(); return; }
    demo();
  });

  reset();
  syncControls();
  if (reduce) {
    // The finished flow, with nothing travelling: every state is readable.
    email.value = EMAIL; signIn(EMAIL); switchRoles(); invite(false); accept();
  } else if (root.getBoundingClientRect().height > innerHeight * 0.9) {
    // Stacked on a phone the three cards are taller than the screen, so the
    // cursor would be working on cards nobody can see. Offer it instead.
    replayBtn.textContent = "Play demo";
  } else {
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { io.disconnect(); demo(); }
    }, { threshold: 0.45 });
    io.observe(root);
  }
  return { demo, stop: stopDemo, reset };
}
