/** One active match per account and browser profile, enforced by Web Locks. */
export class MatchLease {
  private channel: BroadcastChannel;
  private releaseLock: (() => void) | null = null;
  private closed = false;
  private acquiring = false;
  private generation = 0;
  private name: string;
  constructor(owner: string, private changed: (busy: boolean) => void, private takenOver: () => void) {
    this.name = "fbwg.match." + owner;
    this.channel = new BroadcastChannel(this.name);
    this.channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (data === "takeover" && this.releaseLock) { this.takenOver(); this.release(); }
      void this.inspect();
    };
    void this.inspect();
  }
  private async inspect(): Promise<void> {
    if (this.closed) return;
    if (!navigator.locks) { this.changed(true); return; }
    try {
      const snapshot = await navigator.locks.query();
      if (!this.closed) this.changed(!this.releaseLock && (snapshot.held ?? []).some(lock => lock.name === this.name));
    } catch { if (!this.closed) this.changed(true); }
  }
  async acquire(): Promise<boolean> {
    if (this.closed || !navigator.locks) return false;
    if (this.releaseLock) return true;
    if (this.acquiring) return false;
    this.acquiring = true;
    const generation = this.generation;
    return new Promise(resolve => {
      void navigator.locks.request(this.name, { ifAvailable: true }, async lock => {
        this.acquiring = false;
        if (!lock || this.closed || generation !== this.generation) { if (!this.closed) void this.inspect(); resolve(false); return; }
        await new Promise<void>(release => {
          this.releaseLock = release; this.changed(false);
          this.channel.postMessage("claimed"); resolve(true);
        });
      }).catch(() => { this.acquiring = false; resolve(false); });
    });
  }
  async takeover(): Promise<boolean> {
    this.channel.postMessage("takeover");
    const deadline = Date.now() + 5000;
    do {
      if (await this.acquire()) return true;
      await new Promise(resolve => setTimeout(resolve,100));
    } while (!this.closed && Date.now() < deadline);
    return false;
  }
  release(): void {
    this.generation++;
    this.releaseLock?.(); this.releaseLock = null;
    if (!this.closed) this.channel.postMessage("released");
  }
  close(): void { this.release(); this.closed = true; this.channel.close(); }
}
