import { supabase } from "./supabase.js";
export interface SharingState { topic: string; shared: boolean; mine: boolean; theirs: boolean }
/** Server consent is authoritative; pair messages merely prompt a fresh read. */
export class MatchSharing {
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private state: SharingState | null = null;
  constructor(private match: string, private friend: string, private changed: (state: SharingState | null) => void) { void this.set(false); }
  get consent(): boolean { return this.state?.mine ?? false; }
  async set(on: boolean): Promise<void> {
    const generation = ++this.generation;
    if (!on) { this.state = null; this.changed(null); }
    const { data,error } = await supabase.rpc("match_consent", { p_match: this.match, their_id: this.friend, p_on: on });
    if (this.closed || generation !== this.generation) return;
    this.state = error ? null : data?.[0] ?? null;
    this.changed(this.state); this.schedule();
  }
  async refresh(): Promise<void> {
    if (this.closed || document.hidden) return;
    const generation = this.generation;
    const { data,error } = await supabase.rpc("match_watch_state", { p_match: this.match });
    if (this.closed || generation !== this.generation) return;
    const next: SharingState | null = error ? null : data?.[0] ?? null;
    if (JSON.stringify(next) !== JSON.stringify(this.state)) { this.state = next; this.changed(next); }
    this.schedule();
  }
  private schedule(): void {
    if (!this.closed && this.timer === null) this.timer = setTimeout(() => { this.timer = null; void this.refresh(); },5000);
  }
  close(): void {
    this.closed = true; this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    void supabase.rpc("match_consent", { p_match: this.match, their_id: this.friend, p_on: false }).then(() => {});
  }
}
