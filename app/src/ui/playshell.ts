import { el, on } from "./dom.js";
import { friendsScreen } from "../screens/friends.js";
import { settingsScreen } from "../screens/settings.js";

type Panel = "friends" | "setup" | "progress" | "menu" | "manage" | "settings";

/** Presentation owns panels; opening one never navigates or destroys the game. */
export class PlayShell {
  readonly root = el("div", { class: "play play-shell" });
  readonly viewport = el("div", { class: "game-viewport" });
  readonly screen: HTMLElement;
  readonly saveStatus = el("button", { class: "save-status ghost", "aria-live": "polite" }, "Saved");
  readonly friendButton = el("button", { class: "ghost", "aria-controls": "play-drawer", "aria-expanded": "false" }, "Friends (0)");
  // Labelled BY its heading rather than with a fixed string. The panel changes
  // -- "Play together", "Match setup", "Your progress", "Game menu" -- and a
  // region that always announces itself as "Game panels" tells somebody who
  // has just opened it the one thing they already knew. The tab strip below
  // had the same name, so there were also two landmarks called the same thing.
  private drawer = el("aside", { class: "play-drawer", id: "play-drawer", "aria-labelledby": "drawer-title" });
  private content = el("div", { class: "drawer-content" });
  private title = el("h2", { id: "drawer-title" });
  private active: Panel | null = null;
  private offPanel: (() => void) | undefined;
  private observer: ResizeObserver;
  private off: (() => void)[] = [];
  private trigger: HTMLElement | null = null;
  private panels: Record<"friends" | "setup" | "progress" | "menu", HTMLElement>;
  private incoming = false;
  private online = 0;
  private full = el("button", { class: "ghost", "aria-pressed": "false" }, "Fullscreen");
  private toast = el("div", { class: "play-toast", role: "status", "aria-live": "polite" });
  private tabs!: HTMLElement;
  // A field rather than a local, because `aria-expanded` has to be kept in step
  // with what the drawer is actually showing -- see `syncExpanded`.
  private menuButton = el("button", { class: "ghost", "aria-controls": "play-drawer", "aria-expanded": "false" }, "Menu");

  constructor(host: HTMLElement, private options: {
    canvas: HTMLCanvasElement; name: string; status: HTMLElement; mute: HTMLElement;
    banner: HTMLElement; friends: HTMLElement; times: HTMLElement; board: HTMLElement;
    actions: HTMLElement[]; input: (enabled: boolean) => void;
  }) {
    this.screen = el("div", { class: "screen" }, options.canvas);
    const close = el("button", { class: "ghost", "aria-label": "Close panel" }, "Close");
    const tabs = el("nav", { class: "drawer-tabs", "aria-label": "Switch panel" });
    for (const [key, label] of [["friends", "Friends"], ["setup", "Match setup"], ["progress", "Progress"]] as const) {
      // `data-panel` is what `open` marks the current one with. Nothing said
      // which panel you were looking at -- not a class, not an attribute -- so
      // the three tabs were identical whether you had just opened Progress or
      // never touched them.
      tabs.append(el("button", { class: "ghost", "data-panel": key, onclick: () => this.open(key) }, label));
    }
    this.tabs = tabs;
    this.panels = {
      friends: el("div", {}, options.friends,
        el("button", { class: "ghost", onclick: () => this.open("manage") }, "Manage friends")),
      setup: el("div", {}, options.banner),
      progress: el("div", {}, options.times, options.board),
      menu: el("div", { class: "menu-actions" }, ...options.actions,
        el("button", { class: "ghost", onclick: () => this.open("settings") }, "Settings"),
        el("button", { class: "ghost", onclick: () => this.open("manage") }, "Manage friends"),
        el("h3", {}, "Controls"),
        el("p", { class: "note" }, "Fireboy: arrow keys. Watergirl: W, A, D. P pauses, R retries. Escape closes a panel.")),
    };
    this.drawer.append(el("header", { class: "drawer-heading" }, this.title, close), tabs, this.content);
    this.drawer.hidden = true;
    this.viewport.append(this.screen, this.toast);
    this.root.append(
      el("header", { class: "play-toolbar" },
        el("div", { class: "play-identity" }, el("strong", {}, options.name), options.status),
        this.friendButton, this.full, options.mute, this.menuButton),
      el("div", { class: "play-workspace" }, this.viewport, this.drawer),
      el("footer", { class: "play-footer" }, this.saveStatus,
        el("span", { class: "focus-hint", id: "play-keys" }, "Click the game to play · Arrows / W A D · P pauses")));
    host.append(this.root);
    this.off.push(on(this.friendButton, "click", () => this.toggle(this.friendPanel())));
    this.off.push(on(this.menuButton, "click", () => this.toggle("menu")));
    this.off.push(on(close, "click", () => this.close()));
    this.off.push(on(this.full, "click", async () => {
      try {
        if (document.fullscreenElement === this.root) await document.exitFullscreen();
        else await this.root.requestFullscreen();
      } catch { this.notify("Fullscreen is unavailable. The game still fits this window."); }
    }));
    this.off.push(on(document, "fullscreenchange", () => {
      const active = document.fullscreenElement === this.root;
      this.full.textContent = active ? "Exit fullscreen" : "Fullscreen";
      this.full.setAttribute("aria-pressed", String(active));
    }));
    this.off.push(on(this.root, "click", (e) => {
      const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='#/']");
      const destination = link?.getAttribute("href");
      if (destination === "#/friends" || destination === "#/settings" || destination === "#/play") {
        e.preventDefault();
        if (destination === "#/play") this.close();
        else this.open(destination === "#/friends" ? "manage" : "settings");
      }
    }));
    this.off.push(on(this.root, "keydown", (event) => {
      const e = event as KeyboardEvent;
      if (!this.active) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(); }
      if (e.key !== "Tab") return;
      const nodes = [...this.drawer.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex='0']")].filter(n => n.getClientRects().length);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }));
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.viewport);
    this.fit();
  }

  private fit(): void {
    const width = Math.max(0, Math.min(this.viewport.clientWidth - 16, (this.viewport.clientHeight - 16) * 4 / 3));
    this.screen.style.width = `${width}px`;
    this.screen.style.height = `${width * 3 / 4}px`;
  }

  /** Which panel the Friends button stands for right now. */
  private friendPanel(): Panel { return this.incoming ? "setup" : "friends"; }

  /**
   * Open this panel, or close the drawer when it is the one already showing.
   *
   * What a toolbar button that opens a drawer should do, and what the two of
   * them did not: pressing Friends while the friends panel was open re-rendered
   * it and left it open, so the only way out was Close or Escape. The button
   * you pressed to get somewhere is the obvious button to press to get back.
   *
   * The tab strip inside the drawer deliberately does NOT do this. Those are a
   * switch between three panels, and a tab that closed the thing it is a tab of
   * would be a different control wearing the same clothes.
   */
  toggle(panel: Panel): void {
    if (this.active === panel) { this.close(); return; }
    // Already open on something else, so this click is a switch rather than an
    // opening -- and the button that switched is where focus belongs when the
    // drawer eventually closes.
    if (this.active) this.trigger = document.activeElement as HTMLElement;
    this.open(panel);
  }

  /**
   * `aria-expanded` describes the control it is on, not the drawer.
   *
   * Both buttons point at the same region, and only one of them can be the
   * reason it is open. Setting "true" on Friends whatever had opened it -- the
   * Menu button, an incoming invitation -- told a screen reader that Friends
   * was showing its panel when the panel on screen was the game menu.
   */
  private syncExpanded(): void {
    this.friendButton.setAttribute(
      "aria-expanded", String(this.active !== null && this.active === this.friendPanel()));
    this.menuButton.setAttribute("aria-expanded", String(this.active === "menu"));
  }

  open(panel: Panel): void {
    if (!this.active) this.trigger = document.activeElement as HTMLElement;
    this.offPanel?.(); this.offPanel = undefined;
    this.active = panel;
    this.root.classList.add("drawer-open");
    this.drawer.hidden = false;
    this.syncExpanded();
    this.title.textContent = ({ friends: "Play together", setup: "Match setup", progress: "Your progress", menu: "Game menu", manage: "Manage friends", settings: "Settings" })[panel];
    // `aria-current` rather than `aria-selected`: these are buttons in a nav,
    // not a WAI-ARIA tablist, and claiming to be one would promise arrow-key
    // navigation that is not implemented. Menu, Manage and Settings are opened
    // from elsewhere and correctly leave every tab unmarked.
    for (const tab of this.tabs.querySelectorAll<HTMLElement>("button")) {
      const current = tab.dataset.panel === panel;
      tab.classList.toggle("current", current);
      if (current) tab.setAttribute("aria-current", "true");
      else tab.removeAttribute("aria-current");
    }
    this.content.replaceChildren();
    if (panel === "manage") this.offPanel = friendsScreen(this.content);
    else if (panel === "settings") settingsScreen(this.content);
    else this.content.append(this.panels[panel]);
    this.options.input(false);
    this.drawer.querySelector<HTMLButtonElement>("button")?.focus();
  }

  close(focusGame = false): void {
    this.offPanel?.(); this.offPanel = undefined;
    this.active = null;
    this.drawer.hidden = true;
    this.root.classList.remove("drawer-open");
    this.syncExpanded();
    this.options.input(true);
    // Back where you came from, unless where you came from is inside the thing
    // that has just been hidden.
    //
    // `isConnected` alone does not rule that out -- a hidden subtree is still
    // in the document -- so a trigger captured while focus was in the drawer
    // sent focus to an invisible button and, in the browsers that refuse it,
    // to nothing at all. The canvas is the honest fallback: it is what the
    // drawer was covering.
    const back = this.trigger;
    const target = !focusGame && back?.isConnected && !this.drawer.contains(back)
      ? back : this.options.canvas;
    target.focus({ preventScroll: true });
  }

  friends(online: number): void { this.online = online; this.badge(); }
  invite(incoming: boolean): void { this.incoming = incoming; this.badge(); }
  private badge(): void {
    this.friendButton.textContent = this.incoming ? "Invitation (1)" : `Friends (${this.online})`;
    // An arriving invitation changes which panel this button stands for, and
    // so changes whether it is the one currently expanded.
    this.syncExpanded();
  }
  notify(text: string): void { this.toast.textContent = text; this.toast.hidden = !text; }

  destroy(): void {
    this.offPanel?.();
    this.observer.disconnect();
    for (const off of this.off) off();
  }
}
