/**
 * The board, and which board it is.
 *
 * It used to read `verified_leaderboard`, which returns rows published by the
 * replay verifier and by nothing else. That worker has never been deployed and
 * `play_private.engine_versions` is seeded empty on purpose, so
 * `register_ranked_attempt` refuses every run and the table it reads can never
 * have a row in it. The board was not slow or stale; it was structurally
 * incapable of showing anybody their time, which is exactly how it behaved:
 * a pair would finish a level, watch Progress update, and find the board still
 * saying it was waiting for its first pair.
 *
 * So it reads `public.leaderboard` -- the same seven columns, over
 * `pair_progress`, which `sync_progress` writes the moment a level is saved.
 * These times are reported by the client. `sync_progress` bounds them to what a
 * running timer can produce and derives the label from the number rather than
 * accepting one alongside it (see `0016_progress_writes.sql`), so the remaining
 * forgery is "a plausible time you did not earn". That is the honest residue of
 * a client-authoritative design and the copy below says so rather than claiming
 * a verification that is not happening.
 *
 * When the verifier is deployed, `verified_results` comes back as a BADGE on
 * these rows -- not as the only source, which is what made the board empty.
 */
import { el, note } from "./dom.js";
import { auth } from "../auth.js";
import { supabase } from "../supabase.js";
import { leaderboardCache } from "../ranking.js";

const modes = [["adventure", "Adventure", 17], ["puzzle", "Puzzle", 9], ["speed", "Speed", 6]] as const;

/** The grades `Recuent` awards, in the colours the rest of the app gives them. */
const GRADES: Record<number, string> = { 3: "A", 2: "B", 1: "C" };

interface Row { rank: number; a_username: string; b_username: string; medal: number; best_time_str: string; is_mine: boolean }
interface Standing { node: number; rank: number; entries: number }

export class Leaderboard {
  private mode = el("select", { class: "pick", "aria-label": "Leaderboard game mode" }, ...modes.map(([value,label]) => el("option", {value},label)));
  private num = el("select", { class: "pick", "aria-label": "Leaderboard level" });
  private results = el("div", { class: "leaderboard-results", "aria-live": "polite" });
  private generation = 0;
  private gone = false;
  private opened = false;
  /**
   * Where this pair stands on every level, fetched once per partner.
   *
   * `leaderboard_standing` has been granted and indexed since `0018` and had
   * never been called from anywhere. It answers the question the board exists
   * for in the one case the board itself cannot: outside the top twenty, a
   * table of other people's names says nothing at all about you.
   */
  private standing: Map<number, Standing> | null = null;
  private standingFor = "";

  constructor(host: HTMLElement, private table: () => string[] | undefined,
              private partner: () => string | null = () => null) {
    host.classList.add("leaderboard-panel");
    /*
     * One line of chrome, not five.
     *
     * The panel is 364px tall on a 1024x600 laptop and this header used to
     * spend 124px of it -- a 43px trophy, a tagline, and a two-line
     * explanation -- with another 109px of filters under that. 233 of 364px
     * went by before the first result, so the board opened scrolled past its
     * own heading, onto the middle of a sentence about who is listed.
     *
     * The trophy now sits ON the heading line at text size, and the
     * explanation moved below the table, where it is available to somebody
     * asking "who is in this?" and not in the way of somebody asking "who is
     * fastest?". That is the order those two questions actually arrive in.
     */
    host.append(
      el("h3", { class: "board-title" },
        el("span", {class:"trophy-mark", "aria-hidden":"true", html:'<svg width="20" height="20" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><path d="M9 5h14v7a7 7 0 0 1-14 0V5Zm7 14v7m-6 2h12M9 8H4v3a6 6 0 0 0 7 6m12-9h5v3a6 6 0 0 1-7 6"/><path d="m16 8 1 2 2 .3-1.5 1.5.4 2.2-1.9-1-1.9 1 .4-2.2-1.5-1.5 2-.3 1-2Z" fill="currentColor" stroke="none"/></svg>'}),
        "Two players. One great time."),
      el("div", {class:"board-filters"}, el("label", {}, "Mode", this.mode), el("label", {}, "Level", this.num)),
      this.results,
      // Below the results, where somebody who has read the table and wants to
      // know who is in it will look -- rather than above them, where it was
      // the first thing anybody saw and the last thing they needed.
      el("p", { class: "note board-footnote" },
        "Finished levels from pairs who chose to be listed. Times come from the pair that played them."));
    this.fill(1);
    this.mode.addEventListener("change", () => { this.fill(1); void this.refresh(); });
    this.num.addEventListener("change", () => { void this.refresh(); });
  }

  /**
   * This pair's rank on every level, in one query, cached per partner.
   *
   * Deliberately best-effort and never awaited by the table: the board is
   * worth showing without it, and a pair who have never been listed get an
   * empty map rather than an error. Refetched only when the partner changes,
   * which for most of a session is never.
   */
  private async standings(): Promise<Map<number, Standing>> {
    const friend = this.partner();
    if (!friend) { this.standing = new Map(); this.standingFor = ""; return this.standing; }
    if (this.standing && this.standingFor === friend) return this.standing;
    const map = new Map<number, Standing>();
    try {
      const { data, error } = await supabase.rpc("leaderboard_standing", { their_id: friend });
      if (!error) for (const row of (data ?? []) as Standing[]) map.set(row.node, row);
    } catch { /* the table is the point; this is the sentence above it */ }
    this.standing = map; this.standingFor = friend;
    return map;
  }

  /** Forget the cached standing, after a result that could have moved it. */
  invalidate(): void { this.standing = null; this.standingFor = ""; }
  private fill(selected: number): void {
    const count = modes.find(([mode]) => mode === this.mode.value)?.[2] ?? 17;
    this.num.replaceChildren(...Array.from({length:count},(_,i) => el("option", {value:String(i+1)},`Level ${i+1}`)));
    this.num.value = String(Math.min(Math.max(selected,1),count));
  }
  open(selection?: {mode:string; num:number}, changed = true): void {
    if (changed && selection) { this.mode.value = selection.mode; this.fill(selection.num); }
    this.opened = true;
    void this.refresh();
  }
  async refresh(): Promise<void> {
    if (!this.opened || this.gone) return;
    const generation = ++this.generation;
    const type = modes.findIndex(([mode]) => mode === this.mode.value)+1;
    const node = (this.table()?.indexOf(`${type}_${this.num.value}`) ?? -1)+1;
    this.results.replaceChildren(note(node ? "Loading results…" : "Preparing the level list…"));
    if (!node) return;
    const key = `${auth().user?.id}:${node}`;
    const cached = leaderboardCache.get(key);
    try {
      const {data,error} = cached && Date.now()-cached.at < 15000 ? {data:cached.data,error:null} : await supabase.rpc("leaderboard", {p_node:node});
      if (this.gone || generation !== this.generation) return;
      if (error) throw new Error(error.message);
      leaderboardCache.set(key,{at:Date.now(),data});
      const rows = (data ?? []) as Row[];
      if (!rows.length) { this.results.replaceChildren(el("div", {class:"board-empty"}, el("h3", {}, "This level is waiting for its first pair."), note("Finish it together and your names go here. What you have played on your own stays in Progress."))); return; }
      this.results.replaceChildren(el("table", {class:"leaderboard-table"},
        el("caption", {class:"sr-only"}, `${this.mode.value} level ${this.num.value} leaderboard`),
        /*
         * Widths live here and not on the cells.
         *
         * `table-layout:fixed` takes its columns from the first ROW, and the
         * first row is now a screen-reader-only header that is
         * `position:absolute` and one pixel wide -- so every width it could
         * have read is meaningless, and the columns collapsed into two-line
         * rows. A colgroup is the one place a fixed layout will take widths
         * from that does not depend on a row being visible.
         */
        el("colgroup", {},
          el("col", {class:"col-rank"}), el("col", {class:"col-pair"}),
          el("col", {class:"col-grade"}), el("col", {class:"col-time"})),
        /*
         * The header row is read out and not drawn.
         *
         * "Rank / Pair / Time" cost 34px of a 364px panel to label three
         * columns the content states by itself: a small number hard left, two
         * names, a tabular time hard right. A screen reader has no such luxury
         * -- it meets the cells one at a time -- so the labels stay in the
         * markup with `sr-only` and stop taking the room.
         */
        el("thead", {class:"sr-only"}, el("tr", {},
          el("th", {scope:"col"},"Rank"), el("th", {scope:"col"},"Pair"),
          el("th", {scope:"col"},"Grade"), el("th", {scope:"col"},"Time"))),
        el("tbody", {}, ...rows.map(row => el("tr", {class:`${row.is_mine ? "mine" : ""}${row.rank <= 3 ? ` podium p${row.rank}` : ""}`},
          el("td", {class:"rank"},String(row.rank)),
          // "Your pair" is an attribute of the row, so it reads as one: inline
          // after the names rather than on a line of its own, which made this
          // row 88.8px against everybody else's 47.1px and broke the rhythm of
          // the only column a reader scans vertically.
          el("td", {class:"pair"}, el("strong", {}, row.a_username), el("span", {class:"pair-and"}," & "), el("strong", {}, row.b_username), row.is_mine ? el("span", {class:"your-pair"},"You") : null),
          // The grade the run earned, which the query has always returned and
          // this table has always thrown away. A board that ranks how FAST and
          // says nothing about how WELL is half the result; `Recuent` awards
          // these against `TimeTable` and Progress has been colouring them all
          // along, in these same three tokens.
          el("td", {class:`grade g${row.medal}`, title:`Grade ${GRADES[row.medal] ?? "—"}`}, GRADES[row.medal] ?? "—"),
          el("td", {class:"time"},row.best_time_str))))));
      void this.showStanding(node, rows, generation);
    } catch (error) {
      if (this.gone || generation !== this.generation) return;
      this.results.replaceChildren(el("div", {class:"error"},note(`Results could not load: ${(error as Error).message}`), el("button", {class:"ghost",onclick:()=>{ void this.refresh(); }},"Retry")));
    }
  }
  /**
   * Where this pair stands, written above the table once it is known.
   *
   * After the table and never before it: the standing is a second query, the
   * board is worth reading without it, and nothing here may delay the answer
   * somebody opened the panel for. It is also skipped entirely when the pair is
   * already listed -- their own row is highlighted three lines below, and
   * saying "you are 2nd of 31" over the top of it is telling somebody something
   * they can see.
   */
  private async showStanding(node: number, rows: Row[], generation: number): Promise<void> {
    if (rows.some(r => r.is_mine)) return;
    const standing = (await this.standings()).get(node);
    if (this.gone || generation !== this.generation || !standing) return;
    this.results.prepend(el("p", { class: "board-standing" },
      `You are ${ordinal(standing.rank)} of ${standing.entries} pair${standing.entries === 1 ? "" : "s"} here.`));
  }

  destroy(): void { this.gone = true; this.generation++; }
}

/** 1st, 2nd, 3rd, 4th -- including the teens, which are all "th". */
function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${["th","st","nd","rd"][n % 10] ?? "th"}`;
}
