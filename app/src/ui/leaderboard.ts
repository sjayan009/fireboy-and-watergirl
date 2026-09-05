import { el, note } from "./dom.js";
import { auth } from "../auth.js";
import { supabase } from "../supabase.js";
import { leaderboardCache } from "../ranking.js";

const modes = [["adventure", "Adventure", 17], ["puzzle", "Puzzle", 9], ["speed", "Speed", 6]] as const;
export class Leaderboard {
  private mode = el("select", { class: "pick", "aria-label": "Leaderboard game mode" }, ...modes.map(([value,label]) => el("option", {value},label)));
  private num = el("select", { class: "pick", "aria-label": "Leaderboard level" });
  private results = el("div", { class: "leaderboard-results", "aria-live": "polite" });
  private generation = 0;
  private gone = false;
  private opened = false;

  constructor(host: HTMLElement, private table: () => string[] | undefined) {
    host.classList.add("leaderboard-panel");
    host.append(el("div", { class:"board-intro" }, el("span", {class:"trophy-mark", "aria-hidden":"true", html:'<svg width="36" height="36" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" xmlns="http://www.w3.org/2000/svg"><path d="M9 5h14v7a7 7 0 0 1-14 0V5Zm7 14v7m-6 2h12M9 8H4v3a6 6 0 0 0 7 6m12-9h5v3a6 6 0 0 1-7 6"/><path d="m16 8 1 2 2 .3-1.5 1.5.4 2.2-1.9-1-1.9 1 .4-2.2-1.5-1.5 2-.3 1-2Z" fill="currentColor" stroke="none"/></svg>'}),
      el("h3", {}, "Two players. One great time.")),
      note("Verified finishes from pairs who chose to be listed."),
      el("div", {class:"board-filters"}, el("label", {}, "Mode", this.mode), el("label", {}, "Level", this.num)), this.results);
    this.fill(1);
    this.mode.addEventListener("change", () => { this.fill(1); void this.refresh(); });
    this.num.addEventListener("change", () => { void this.refresh(); });
  }
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
      const {data,error} = cached && Date.now()-cached.at < 15000 ? {data:cached.data,error:null} : await supabase.rpc("verified_leaderboard", {p_node:node});
      if (this.gone || generation !== this.generation) return;
      if (error) throw new Error(error.message);
      leaderboardCache.set(key,{at:Date.now(),data});
      const rows = (data ?? []) as {rank:number; a_username:string; b_username:string; best_time_str:string; is_mine:boolean}[];
      if (!rows.length) { this.results.replaceChildren(el("div", {class:"board-empty"}, el("h3", {}, "This level is waiting for its first pair."), note("Finish it together to set a verified time. Your earlier personal results remain in Progress."))); return; }
      this.results.replaceChildren(el("table", {class:"leaderboard-table"},
        el("caption", {class:"sr-only"}, `${this.mode.value} level ${this.num.value} verified leaderboard`),
        el("thead", {}, el("tr", {}, el("th", {scope:"col"},"Rank"), el("th", {scope:"col"},"Pair"), el("th", {scope:"col"},"Time"))),
        el("tbody", {}, ...rows.map(row => el("tr", {class:row.is_mine ? "mine" : ""},
          el("td", {class:"rank"},String(row.rank)),
          el("td", {}, el("strong", {}, row.a_username), el("span", {class:"pair-and"}," & "), el("strong", {}, row.b_username), row.is_mine ? el("span", {class:"your-pair"},"Your pair") : null),
          el("td", {class:"time"},row.best_time_str))))));
    } catch (error) {
      if (this.gone || generation !== this.generation) return;
      this.results.replaceChildren(el("div", {class:"error"},note(`Results could not load: ${(error as Error).message}`), el("button", {class:"ghost",onclick:()=>{ void this.refresh(); }},"Retry")));
    }
  }
  destroy(): void { this.gone = true; this.generation++; }
}
