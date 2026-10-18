import { el, on } from "./dom.js";
import { liveEmblem } from "./logo.js";
import { keyLegend, keyRow, lightKeys, type KeyMode } from "./keys.js";
import { glowSwitch } from "./glowswitch.js";
import { PRESENTATION_CHANGED, presentationPreferences, type PresentationPreferences } from "../presentation.js";
import { auth, onAuth } from "../auth.js";

export type Panel = "friends" | "setup" | "leaderboard" | "progress" | "menu" | "manage" | "settings";
const control = (text: string, kind: string) => el("button", {
  class: `ghost tool tool-${kind}`, "aria-controls": "play-drawer", "aria-expanded": "false",
}, text);

/** Owns presentation and focus only. Panel changes never recreate GameView. */
export class PlayShell {
  readonly root = el("div", { class: "play play-shell" });
  readonly viewport = el("div", { class: "game-viewport" });
  readonly screen: HTMLElement;
  readonly saveStatus = el("button", { class: "save-status ghost", "aria-live": "polite", "aria-controls": "play-drawer", "aria-expanded": "false" }, "Saved to Cloud");
  readonly friendButton = control("Friends (0)", "friends");
  private boardButton = control("Leaderboard", "leaderboard");
  private menuButton = control("Menu", "menu");
  private full = el("button", { class: "ghost tool tool-fullscreen", "aria-pressed": "false", title: "Expand the game and its controls" }, "Fullscreen");
  private drawer = el("aside", { class: "play-drawer", id: "play-drawer", "aria-labelledby": "drawer-title" });
  private content = el("div", { class: "drawer-content" });
  private title = el("h2", { id: "drawer-title" });
  private tabs = el("nav", { class: "drawer-tabs", "aria-label": "Switch panel" });
  private notices = el("div", { class: "session-notices" });
  private toast = el("div", { class: "play-toast", role: "status" });
  private active: Panel | null = null;
  private trigger: HTMLElement | null = null;
  private observer: ResizeObserver;
  private off: (() => void)[] = [];
  private wide = matchMedia("(min-width: 1100px)");
  private panels: Record<string, HTMLElement>;
  private preference = `fbwg.panel.${auth().user?.id ?? "local"}`;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whose keys the footer shows and lights: both on one keyboard, only yours online. */
  private keyMode: KeyMode = "both";
  private legend = keyLegend();
  /**
   * The stage glow: a light at each side of the stage, ember on Fireboy's and
   * water on Watergirl's, lavender for a moment when a level is cleared. Off
   * unless turned on (see glowswitch.ts). The strips are sized from the stage
   * in `fit`, so nothing is ever drawn above or below it.
   */
  private glow = [el("div", { class: "glow-side left", "aria-hidden": "true" }, el("i", { class: "base" }), el("i", { class: "clear" })),
    el("div", { class: "glow-side right", "aria-hidden": "true" }, el("i", { class: "base" }), el("i", { class: "clear" }))];

  constructor(host: HTMLElement, private options: {
    canvas: HTMLCanvasElement; name: string; status: HTMLElement; mute: HTMLElement;
    banner: HTMLElement; friends: HTMLElement; times: HTMLElement; board: HTMLElement;
    actions: HTMLElement[]; input: (enabled: boolean) => void;
    onPanel?: (panel: Panel, changed: boolean) => void; watching?: boolean;
    onObstructed?: (obstructed: boolean) => void;
    primaryAction?: HTMLElement;
    /** The pair's link state, shown beside the sound and fullscreen controls. */
    connection?: HTMLElement;
    /**
     * No account. Friends and Leaderboard stay, locked, and open the panels the
     * caller filled with what an account adds; the username, the session line,
     * the session and account menu groups are left out, and "Sign in" stands
     * where the username was.
     */
    guest?: boolean;
    /**
     * Draws the Settings panel, handed in rather than imported: Settings is
     * account-only, and importing it here put it and the Supabase client in
     * every guest's download. A guest has no way to open the panel.
     */
    settings?: (host: HTMLElement) => void;
  }) {
    this.screen = el("div", { class: "screen" }, options.canvas);
    const close = el("button", { class: "ghost close-panel", "aria-label": "Close panel", title: "Close panel (Escape)" }, "×");
    for (const [key, label] of [["friends", "Friends"], ["leaderboard", "Leaderboard"], ["progress", "Progress"]] as const) {
      this.tabs.append(el("button", { class: "ghost", "data-panel": key, onclick: () => this.open(key) }, label));
    }
    const sessionActions = el("section", { class: "menu-group" }, el("h3", {}, "This Session"));
    const glowControl = glowSwitch();
    this.off.push(() => glowControl.destroy());
    const accountActions = el("section", { class: "menu-group" }, el("h3", {}, "Your Account"),
      el("button", { class: "ghost", onclick: () => this.open("settings") }, "Settings"));
    for (const action of options.actions) (action.textContent === "Sign out" ? accountActions : sessionActions).append(action);
    this.panels = {
      friends: options.friends, leaderboard: options.board, progress: options.times,
      menu: el("div", { class: "menu-actions" },
        // First in the Menu and in the water blue, so somebody stuck finds it
        // without reading the rest. A tab of its own keeps the game here.
        el("section", { class: "menu-group menu-support" },
          el("a", { class: "secondary", href: "/support-ticket", target: "_blank", rel: "noopener" },
            "Contact Support"),
          el("p", { class: "note" }, "Opens in a new tab. Screenshots welcome.")),
        sessionActions,
        el("section", { class: "menu-group" }, el("h3", {}, "Game Display"), glowControl.root),
        el("section", { class: "menu-group" }, el("h3", {}, "At Your Fingertips"),
          options.watching ? el("p", { class: "note" }, "The two players have the controls. Watching does not change your own progress.") :
            el("div", { class: "control-keys" }, keyRow("fire"), keyRow("water"),
              el("p", { class: "note" }, "P pauses · R retries · Escape closes a panel"))), accountActions,
        // The game's own credits screen has 22px to spare and gets one line.
        // This is where the whole attribution fits without fighting for room.
        el("section", { class: "menu-group" }, el("h3", {}, "About"),
          el("p", { class: "note" }, "Fireboy & Watergirl: The Forest Temple, 2009. " +
            "Concept, graphics and programming by Oslo Albet; level design with " +
            "Jan Villanueva; physics by Erin Catto's Box2D."),
          el("p", { class: "note" }, "Online Multiplayer by Jayan Sirikonda."))),
    };
    const copy = el("button", { class: "copy-name", title: "Copy my username", "aria-label": "Copy my username" }, options.name);
    this.off.push(onAuth(state => { copy.textContent = state.profile?.username ?? options.name; }));
    this.off.push(on(copy, "click", async () => {
      try { await navigator.clipboard.writeText(auth().profile?.username ?? options.name); this.notify("Username copied. Send it to your friend."); }
      catch { this.notify("Could not copy. Select your username to copy it manually."); }
    }));
    options.mute.classList.add("tool", "tool-mute");
    options.mute.title = "Turn game audio on or off";
    options.mute.setAttribute("aria-pressed", String(options.mute.textContent === "Unmute"));
    this.drawer.append(el("header", { class: "drawer-heading" }, this.title, close), this.tabs, this.content);
    this.drawer.hidden = true;
    this.notices.append(options.banner);
    this.viewport.append(...this.glow, this.screen);
    const identity = el("div", { class: "play-identity" });
    const logo = liveEmblem(identity);
    this.off.push(() => logo.destroy());
    identity.append(logo.root,
      el("div", { class: "identity-copy" }, el("strong", { class: "game-title" },
          el("span", { class: "fb" }, "Fireboy"), " & ", el("span", { class: "wg" }, "Watergirl")),
            el("div", { class: "identity-detail" }, ...options.guest
              ? [el("span", { class: "guest-chip" }, "Playing as a guest"), el("a", { class: "signin-link", href: "#/login" }, "Sign in")]
              : [copy, options.status])));
    this.root.append(
      el("header", { class: "play-toolbar" },
        identity, this.friendButton, this.boardButton, this.menuButton, options.primaryAction),
      el("div", { class: "play-workspace" }, this.viewport, this.drawer, this.notices),
      // Sound and fullscreen change the screen, not the session, so they sit
      // under the screen they change, opposite "Saved": the footer is the
      // game's own status bar, the toolbar is for the social panels.
      el("footer", { class: "play-footer" }, this.saveStatus,
        options.watching ? el("span", { class: "focus-hint", id: "play-keys" }, "Watching together · The players have the controls") : this.legend.root,
        el("div", { class: "footer-controls" }, ...(options.connection ? [options.connection] : []), options.mute, this.full)), this.toast);
    host.append(this.root);
    this.off.push(on(this.friendButton, "click", () => this.toggle("friends")),
      on(this.boardButton, "click", () => this.toggle("leaderboard")),
      on(this.menuButton, "click", () => this.toggle("menu")), on(close, "click", () => this.close()));
    this.off.push(on(this.full, "click", async () => {
      try {
        if (document.fullscreenElement === this.root) await document.exitFullscreen();
        else await this.root.requestFullscreen();
      } catch { this.notify("Fullscreen is unavailable. The game still fits this window."); }
    }), on(document, "fullscreenchange", () => {
      const active = document.fullscreenElement === this.root;
      this.full.textContent = active ? "Exit fullscreen" : "Fullscreen";
      this.full.setAttribute("aria-pressed", String(active));
    }));
    this.off.push(on(this.root, "click", (e) => {
      const destination = (e.target as HTMLElement).closest("a[href^='#/']")?.getAttribute("href");
      if (destination === "#/friends" || destination === "#/settings" || (destination === "#/play" && !options.watching)) {
        e.preventDefault();
        if (destination === "#/play") this.close();
        else this.open(destination === "#/friends" ? "friends" : "settings");
      }
    }));
    this.off.push(on(this.root, "focusin", () => this.syncInput()),
      on(this.root, "focusout", () => queueMicrotask(() => this.syncInput())),
      on(this.wide, "change", () => { this.syncModal(); this.fit(); }));
    this.off.push(on(this.root, "keydown", (event) => {
      const e = event as KeyboardEvent;
      if (!this.active) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(); return; }
      if (e.key !== "Tab" || this.wide.matches) return;
      const nodes = [...this.drawer.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href], [tabindex='0']")].filter(n => n.getClientRects().length);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }));
    if (!options.watching) this.off.push(lightKeys(this.root, () => this.keyMode));
    const glowing = (p: PresentationPreferences) => this.viewport.classList.toggle("glow", p.glow && !options.watching);
    glowing(presentationPreferences());
    this.off.push(on(window, PRESENTATION_CHANGED, e => glowing((e as CustomEvent<PresentationPreferences>).detail)));
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.viewport);
    let collapsed = false;
    try { collapsed = localStorage.getItem(this.preference) === "closed"; } catch { /* optional preference */ }
    if (options.guest) {
      sessionActions.hidden = accountActions.hidden = true;
      this.friendButton.textContent = "Friends";
      for (const button of [this.friendButton, this.boardButton]) {
        button.dataset.locked = "";
        button.append(el("span", { class: "sr-only" }, ", needs an account"));
      }
    }
    // A guest too: on a wide screen the Friends panel is the pitch for an
    // account, and it sits beside the game rather than over it.
    if (this.wide.matches && !collapsed && !options.watching) this.open("friends", false);
    this.fit();
  }

  /**
   * The largest 4:3 stage the viewport will hold, inside the frame's inlay.
   *
   * The inset rings are 6px deep, so the stage keeps 6px clear on every side.
   * It used to keep 4px, which put the stage over 2px of the ring on whichever
   * axis was tight -- the edge read as the game spilling over its frame, and the
   * corner, rounded less than the ring's inner curve, poked out past it. The
   * corner radius in styles.css is concentric with the ring for the same reason.
   * The stage's size is also handed to the glow strips, so they match it.
   */
  private fit(): void {
    const inlay = 12;
    // The exact box, not clientWidth/Height: those round to whole pixels, and
    // a frame 694.75px tall read as 695 put the stage 0.25px into the ring.
    const box = this.viewport.getBoundingClientRect(), style = getComputedStyle(this.viewport);
    const inner = (size: number, a: string, b: string) => size - parseFloat(a) - parseFloat(b);
    const w = inner(box.width, style.borderLeftWidth, style.borderRightWidth);
    const h = inner(box.height, style.borderTopWidth, style.borderBottomWidth);
    const width = Math.max(0, Math.min(w - inlay, (h - inlay) * 4 / 3));
    this.screen.style.width = `${width}px`;
    this.screen.style.height = `${width * 3 / 4}px`;
    this.viewport.style.setProperty("--stage-w", `${width}px`);
    this.viewport.style.setProperty("--stage-h", `${width * 3 / 4}px`);
  }
  /** Online, only your character's keys; on one keyboard, both. */
  setKeyMode(mode: KeyMode): void { this.keyMode = mode; this.legend.setMode(mode); }
  /** A level's results board is up: the glow turns lavender until the next level. */
  setCleared(cleared: boolean): void { this.viewport.classList.toggle("cleared", cleared); }
  private syncInput(): void {
    const focused = document.activeElement;
    this.options.input(!(this.active && !this.wide.matches) &&
      !(focused instanceof HTMLElement && (this.drawer.contains(focused) ||
        (this.root.contains(focused) && focused.matches("input, select, textarea, [contenteditable='true']")))));
  }
  private syncModal(): void {
    const modal = !!this.active && !this.wide.matches;
    this.options.onObstructed?.(modal);
    this.drawer.setAttribute("role", modal ? "dialog" : "complementary");
    if (modal) this.drawer.setAttribute("aria-modal", "true"); else this.drawer.removeAttribute("aria-modal");
    this.viewport.inert = modal;
    this.root.querySelector<HTMLElement>(".play-toolbar")!.inert = modal;
    this.root.querySelector<HTMLElement>(".play-footer")!.inert = modal;
    // Invitations remain inside the modal's accessibility and keyboard boundary.
    if (modal) this.drawer.insertBefore(this.notices, this.content);
    else this.root.querySelector(".play-workspace")!.append(this.notices);
    this.syncInput();
    if (modal && !this.drawer.contains(document.activeElement)) this.drawer.querySelector<HTMLElement>("button")?.focus();
  }
  private syncExpanded(): void {
    for (const [button, panel] of [[this.friendButton,"friends"], [this.boardButton,"leaderboard"], [this.menuButton,"menu"], [this.saveStatus,"progress"]] as const) {
      button.setAttribute("aria-expanded", String(this.active === panel));
    }
  }
  toggle(panel: Panel): void { if (this.active === panel) this.close(); else this.open(panel); }
  open(panel: Panel, focus = true): void {
    if (panel === "setup") { this.showNotice(); return; }
    if (panel === "manage") panel = "friends";
    const changed = this.active !== panel;
    if (!this.active || !this.drawer.contains(document.activeElement)) this.trigger = document.activeElement as HTMLElement;
    this.active = panel;
    this.root.classList.add("drawer-open"); this.drawer.hidden = false;
    this.title.textContent = { friends:"Play Together", leaderboard:"The Fastest Pairs", progress:"Progress", menu:"Game Menu", settings:"Settings" }[panel];
    for (const tab of this.tabs.querySelectorAll<HTMLElement>("button")) {
      const current = tab.dataset.panel === panel;
      tab.classList.toggle("current", current);
      if (current) tab.setAttribute("aria-current", "true"); else tab.removeAttribute("aria-current");
    }
    if (panel === "settings" && !this.panels.settings) {
      this.panels.settings = el("div"); this.options.settings?.(this.panels.settings);
    }
    if (changed) this.content.replaceChildren(this.panels[panel]);
    this.syncExpanded(); this.syncModal();
    if (focus) this.drawer.querySelector<HTMLElement>("button")?.focus();
    try { localStorage.setItem(this.preference, "open"); } catch { /* optional */ }
    this.options.onPanel?.(panel, changed);
  }
  close(focusGame = false): void {
    this.active = null; this.drawer.hidden = true; this.root.classList.remove("drawer-open");
    this.syncExpanded(); this.syncModal();
    if (!focusGame) { try { localStorage.setItem(this.preference, "closed"); } catch { /* optional */ } }
    const back = this.trigger;
    const restorable = back?.isConnected && !this.drawer.contains(back) &&
      back.matches("button, a[href], input, select, textarea, summary, [tabindex]") && back.getClientRects().length > 0;
    const target = !focusGame && restorable ? back : this.options.canvas;
    target.focus({ preventScroll: true }); this.syncInput();
  }
  /** Move the invitation node without replacing its cancellation handlers. */
  placeSetup(host: HTMLElement): void { host.append(this.options.banner); }
  showNotice(): void { this.notices.append(this.options.banner); }
  friends(online: number): void { this.friendButton.textContent = `Friends (${online})`; }
  invite(incoming: boolean): void {
    this.friendButton.classList.toggle("has-invite", incoming);
    if (incoming) this.showNotice();
  }
  notify(text: string): void {
    clearTimeout(this.toastTimer); this.toast.textContent = text; this.toast.hidden = !text;
    if (text && !text.startsWith("Preparing")) this.toastTimer = setTimeout(() => { this.toast.hidden = true; }, 5000);
  }
  destroy(): void { clearTimeout(this.toastTimer); this.observer.disconnect(); for (const off of this.off) off(); }
}
