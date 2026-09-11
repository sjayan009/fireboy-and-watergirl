/**
 * The 32 results, for whichever map you ask to see.
 *
 * This used to be a function on the play screen that drew whatever store the
 * game happened to be holding, which meant it showed the pair's map during a
 * match and this account's afterwards, and there was no way to ask for either
 * one on purpose. Two people who play together and also play alone had two
 * different maps and one window onto them, chosen for them by whether a friend
 * was currently online.
 *
 * So the panel takes a subject: "Just me", or any friend you have. That picker
 * is also the whole answer to "am I playing locally or online" -- the app never
 * asks, because it already knows, and the LABEL says which. Showing the local
 * map the panel is called "Progress (Local)"; showing a shared one it is called
 * "Progress". Since the picker starts on whoever you are playing with, that
 * reads correctly without anybody choosing a mode.
 *
 * Reading is read-only. `pairProgress.adopt` swaps the store the running engine
 * writes through, and looking at a friend's map must never do that -- see
 * `readPairProgress`, which runs the same query with no side effect.
 */
import { el, clear, note } from "./dom.js";
import { auth } from "../auth.js";
import type { FriendState } from "../lobby.js";
import type { PairProgress } from "../pairsave.js";
import { readPairProgress } from "../pairsave.js";
import type { ProgressArrays } from "../outbox.js";

/** The 32 levels, as the map numbers them. */
const MODES: [string, string, number][] = [
  ["adventure", "Adventure", 17],
  ["puzzle", "Puzzle", 9],
  ["speed", "Speed", 6],
];

/**
 * What the game's own `stats` mean, in the order `CreateMainMenu` draws them.
 *
 * -1 is a node you have not reached, 0 is one you have reached and not
 * finished, and 1 to 3 are the grades `Recuent` awards against `TimeTable`.
 */
const GRADES: Record<number, string> = { 3: "A", 2: "B", 1: "C", 0: "—" };

/** Shown on the tab and the drawer heading, so the mode needs no sentence. */
export const LOCAL_LABEL = "Progress (Local)";
export const SHARED_LABEL = "Progress";

export interface ProgressSources {
  /** The store the game is writing through, and what it knows about saving. */
  progress: PairProgress;
  /** Who the friends are, refreshed whenever the lobby changes. */
  friends: () => FriendState[];
  /** The partner of the match in progress, if there is one. */
  partner: () => FriendState | null;
  /** `game.Translation`, absent until the game has finished preparing. */
  table: () => string[] | undefined;
  /** Told when the subject changes, so the tab and heading can follow it. */
  onLabel: (label: string) => void;
}

export class ProgressPanel {
  private who = el("select", { class: "pick", "aria-label": "Whose progress" });
  private body = el("div", { class: "progress-results", "aria-live": "polite" });
  private generation = 0;
  private gone = false;
  private opened = false;
  /** Which subject the picker is on: "" for this account's own map. */
  private subject = "";
  /** Set once the picker has been pointed at a partner, so it stops moving. */
  private chosen = false;

  constructor(host: HTMLElement, private readonly sources: ProgressSources) {
    host.classList.add("progress-panel");
    host.append(
      el("div", { class: "progress-filters" }, el("label", {}, "Whose", this.who)),
      this.body);
    this.fill();
    this.who.addEventListener("change", () => {
      this.subject = this.who.value;
      // A deliberate choice outranks the match. Somebody who asked for their own
      // map mid-game did not ask to be put back on the pair's when the next
      // level starts.
      this.chosen = true;
      this.announce();
      void this.refresh();
    });
    this.announce();
  }

  /**
   * The options, rebuilt from the friend list without losing the selection.
   *
   * Called whenever the lobby changes, which is often and usually changes
   * nothing -- a friend coming online rewrites the list. Replacing the options
   * under an open select would drop the user's choice, so the value is put back.
   */
  fill(): void {
    const friends = this.sources.friends().filter(f => f.status === "accepted");
    const wanted = this.subject;
    this.who.replaceChildren(
      el("option", { value: "" }, "Just me"),
      ...friends.map(f => el("option", { value: f.id }, `With ${f.username}`)));
    // A friend who has been removed takes their option with them, and the panel
    // falls back to the one subject that is always there.
    this.subject = friends.some(f => f.id === wanted) ? wanted : "";
    this.who.value = this.subject;
    this.announce();
  }

  /** Point the picker at the match, unless the reader has said otherwise. */
  follow(): void {
    if (this.chosen) return;
    const partner = this.sources.partner();
    const wanted = partner?.id ?? "";
    if (wanted === this.subject) return;
    this.subject = wanted;
    this.fill();
    if (this.opened) void this.refresh();
  }

  /** A match ending releases the picker, so the next one can move it again. */
  released(): void {
    this.chosen = false;
    this.follow();
  }

  private announce(): void {
    this.sources.onLabel(this.subject ? SHARED_LABEL : LOCAL_LABEL);
  }

  open(): void {
    this.opened = true;
    this.follow();
    void this.refresh();
  }

  /**
   * Whether the subject is the map the engine is currently writing through.
   *
   * Only then do the save indicator's troubles belong in this panel: a pending
   * result or a full quota says nothing about a friend's map being read out of
   * the database.
   */
  private live(): boolean {
    const partner = this.sources.partner();
    return this.subject ? this.sources.progress.shared && partner?.id === this.subject : !this.sources.progress.shared;
  }

  async refresh(): Promise<void> {
    if (!this.opened || this.gone) return;
    const generation = ++this.generation;
    const subject = this.subject;
    const table = this.sources.table();
    if (!table) { this.body.replaceChildren(note("Preparing the level list…")); return; }

    let data: ProgressArrays;
    if (this.live()) {
      // The store the game is writing through is fresher than anything the
      // server could answer with, including the level that finished a second ago.
      data = this.sources.progress.store.data as ProgressArrays;
    } else if (!subject) {
      data = this.sources.progress.own;
    } else {
      this.body.replaceChildren(note("Loading your shared progress…"));
      try {
        data = await readPairProgress(auth().user!.id, subject);
      } catch (error) {
        if (this.gone || generation !== this.generation) return;
        this.body.replaceChildren(el("div", { class: "error" },
          note(`That progress could not load: ${(error as Error).message}`),
          el("button", { class: "ghost", onclick: () => { void this.refresh(); } }, "Retry")));
        return;
      }
      if (this.gone || generation !== this.generation) return;
    }
    this.draw(data, table, subject);
  }

  private draw(data: ProgressArrays, table: string[], subject: string): void {
    clear(this.body);
    this.body.append(el("h2", {}, "Best Times"));

    const rows: HTMLElement[] = [];
    let done = 0;
    for (let i = 0; i < 32; i++) {
      const medal = data.stats?.[i] ?? -1;
      if (medal < 0) continue;                       // never reached
      const [type, num] = String(table[i] ?? "").split("_");
      const label = MODES[Number(type) - 1]?.[1] ?? "?";
      const time = data.timesString?.[i] || "";
      if (medal > 0) done++;
      rows.push(el("div", { class: "row" },
        el("span", { class: "name" }, `${label} ${num}`),
        el("span", { class: "dim" }, time || "not finished"),
        // The grade carries a colour of its own. All four used to be the same
        // orange, so the column that exists to say HOW WELL a level went said
        // only that it had been played.
        el("span", { class: `grade g${medal}` }, GRADES[medal] ?? "—")));
    }

    // Whose progress this is, which stopped being "this browser's" when solo
    // results moved into `solo_progress` and got an account on them. The old
    // wording outlived the change by a release and told people their own
    // account's medals belonged to the machine they happened to be sitting at
    // -- which had been true, and was the bug that moved them.
    const friend = this.sources.friends().find(f => f.id === subject);
    this.body.append(el("p", { class: "note" },
      `${done} of 32 finished` +
      (subject ? `, together with ${friend?.username ?? "your friend"}` : ", on your account")));

    if (!rows.length) {
      this.body.append(note(subject
        ? "You have not finished a level together yet."
        : "Nothing recorded yet."));
    }

    // A save that is not being saved used to look exactly like one that was.
    // `localStorage.setItem` throws on a full quota and in some private modes,
    // and both the solo store and the pair store swallowed it -- so somebody
    // could finish half the map in a private window and lose all of it without
    // a single word on screen.
    //
    // Only for the map the engine is actually writing through. A friend's map
    // read out of the database has no save of ours in flight to report on.
    if (this.live()) {
      const progress = this.sources.progress;
      const trouble = progress.shared ? progress.lastError : progress.storageError;
      if (trouble) {
        this.body.append(el("p", { class: "error", role: "alert" },
          progress.shared
            ? `The last result could not be saved: ${trouble}. It will be sent ` +
              "again when the connection comes back."
            : `This browser is not storing progress: ${trouble}. A private ` +
              "window or a full quota will do that."));
      } else if (progress.waiting > 0) {
        this.body.append(el("p", { class: "note" },
          `${progress.waiting} result${progress.waiting === 1 ? "" : "s"} still ` +
          "waiting to be sent. They will go when the connection allows."));
      }
    }
    this.body.append(...rows);
  }

  destroy(): void { this.gone = true; this.generation++; }
}
