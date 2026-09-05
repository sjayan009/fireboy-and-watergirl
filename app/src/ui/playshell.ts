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
  private drawer = el("aside", { class: "play-drawer", id: "play-drawer", "aria-label": "Game panels" });
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

  constructor(host: HTMLElement, private options: {
    canvas: HTMLCanvasElement; name: string; status: HTMLElement; mute: HTMLElement;
    banner: HTMLElement; friends: HTMLElement; times: HTMLElement; board: HTMLElement;
    actions: HTMLElement[]; input: (enabled: boolean) => void;
  }) {
    this.screen = el("div", { class: "screen" }, options.canvas);
    const close = el("button", { class: "ghost", "aria-label": "Close panel" }, "Close");
    const menu = el("button", { class: "ghost", "aria-controls": "play-drawer" }, "Menu");
    const tabs = el("nav", { class: "drawer-tabs", "aria-label": "Game panels" });
    for (const [key, label] of [["friends", "Friends"], ["setup", "Match setup"], ["progress", "Progress"]] as const) {
      tabs.append(el("button", { class: "ghost", onclick: () => this.open(key) }, label));
    }
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
        this.friendButton, this.full, options.mute, menu),
      el("div", { class: "play-workspace" }, this.viewport, this.drawer),
      el("footer", { class: "play-footer" }, this.saveStatus,
        el("span", { class: "focus-hint", id: "play-keys" }, "Click the game to play · Arrows / W A D · P pauses")));
    host.append(this.root);
    this.off.push(on(this.friendButton, "click", () => this.open(this.incoming ? "setup" : "friends")));
    this.off.push(on(menu, "click", () => this.open("menu")));
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

  open(panel: Panel): void {
    if (!this.active) this.trigger = document.activeElement as HTMLElement;
    this.offPanel?.(); this.offPanel = undefined;
    this.active = panel;
    this.root.classList.add("drawer-open");
    this.drawer.hidden = false;
    this.friendButton.setAttribute("aria-expanded", "true");
    this.title.textContent = ({ friends: "Play together", setup: "Match setup", progress: "Your progress", menu: "Game menu", manage: "Manage friends", settings: "Settings" })[panel];
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
    this.friendButton.setAttribute("aria-expanded", "false");
    this.options.input(true);
    if (focusGame) this.options.canvas.focus({ preventScroll: true });
    else (this.trigger?.isConnected ? this.trigger : this.options.canvas).focus({ preventScroll: true });
  }

  friends(online: number): void { this.online = online; this.badge(); }
  invite(incoming: boolean): void { this.incoming = incoming; this.badge(); }
  private badge(): void { this.friendButton.textContent = this.incoming ? "Invitation (1)" : `Friends (${this.online})`; }
  notify(text: string): void { this.toast.textContent = text; this.toast.hidden = !text; }

  destroy(): void {
    this.offPanel?.();
    this.observer.disconnect();
    for (const off of this.off) off();
  }
}
