import { accept, block, remove, request, unblock } from "../friends.js";
import { getLobby, type Lobby, type FriendState } from "../lobby.js";
import { auth } from "../auth.js";
import { card, el, field, form, inputOf, note, on } from "../ui/dom.js";

type FriendRow = {
  root: HTMLElement; name: HTMLElement; status: HTMLElement; avatar: HTMLElement;
  actions: HTMLElement; setup: HTMLElement; error: HTMLElement; signature: string;
  friend: FriendState; invite?: HTMLButtonElement;
};

/** Keyed rows keep open disclosures, in-flight setup and keyboard focus intact. */
export class FriendsPanel {
  private lobby: Lobby | undefined;
  private off: (() => void) | undefined;
  private gone = false;
  private rows = new Map<string, FriendRow>();
  private friends: FriendState[] = [];
  private filter = field("Find a friend", { type: "search", placeholder: "Filter your friends", autocomplete: "off" });
  private trouble = el("div", { class: "error", role: "alert", hidden: true });
  private current = el("div", { class: "friend-list" });
  private incoming = el("div", { class: "friend-list" });
  private outgoing = el("div", { class: "friend-list" });
  private blocked = el("div", { class: "friend-list" });
  private incomingSection = el("section", { hidden: true }, el("h3", {}, "Waiting for You"), this.incoming);
  private outgoingSection = el("section", { hidden: true }, el("h3", {}, "Requests Sent"), this.outgoing);
  private blockedSection = el("details", { class: "blocked-friends", hidden: true }, el("summary", {}, "Blocked Friends"), this.blocked);
  private empty = note("Add a friend below to play together. You can also play on one keyboard.");
  private count = el("span", { class: "friend-count" }, "0");
  private online = el("span", { class: "online" });
  private toggle = el("button", { type: "button", class: "friends-toggle", "aria-expanded": "true", "aria-controls": "your-friends" },
    el("span", { class: "chev", "aria-hidden": "true" }), "Your Friends", this.count, this.online);
  private fold = el("div", { class: "friends-fold", id: "your-friends" });
  private foldKey = `fbwg.friendsOpen.${auth().user?.id ?? "local"}`;
  readonly root = el("div", { class: "friends-hub" });

  constructor(host: HTMLElement, private options: {
    onInvite?: (friend: FriendState, slot: HTMLElement) => void;
    busy?: () => boolean;
    onChange?: (friends: FriendState[]) => void;
    /** Shown between your friends and adding one: the Quick Match card. */
    quickMatch?: HTMLElement;
  } = {}) {
    const name = field("Their username", { required: true, minlength: 3, maxlength: 20, autocomplete: "off", placeholder: "Exact username", spellcheck: "false" });
    const sent = el("p", { class: "note", role: "status", hidden: true });
    const add = form({ submit: "Send a request", children: [name, sent], onSubmit: async () => {
      const username = inputOf(name).value.trim();
      await request(username);
      if (this.gone) return;
      inputOf(name).value = "";
      sent.textContent = `Request sent to ${username}.`; sent.hidden = false;
      await this.lobby?.refreshAfterChange();
      // Crossed requests are accepted by the existing API in the same operation.
      if (this.lobby?.list.some(f => f.username.toLowerCase() === username.toLowerCase() && f.status === "accepted")) sent.textContent = `You and ${username} are now friends.`;
    }});
    add.classList.add("add-friend");
    /*
     * The people you already have come first, and the way to add somebody
     * follows them.
     *
     * The form was at the top, which put a text field asking for a username
     * nobody has typed yet above the list of the friends you play with every
     * time. Opening this panel is nearly always "invite one of these", and
     * that answer now begins at the top of the panel; adding a friend is the
     * occasional errand, and it is one scroll away rather than in the way.
     *
     * The list folds, so with it closed everything else -- Quick Match and
     * adding a friend -- is in sight without scrolling. The heading keeps the
     * count and whether anybody is online, so folding it hides nothing you
     * would open it to learn.
     */
    this.fold.append(el("div", {}, this.filter, this.current, this.empty));
    let open = true;
    try { open = localStorage.getItem(this.foldKey) !== "closed"; } catch { /* optional preference */ }
    this.setOpen(open);
    this.toggle.addEventListener("click", () => {
      const next = this.toggle.getAttribute("aria-expanded") !== "true";
      this.setOpen(next);
      try { localStorage.setItem(this.foldKey, next ? "open" : "closed"); } catch { /* optional */ }
    });
    this.root.append(this.trouble, this.incomingSection,
      el("section", {}, this.toggle, this.fold),
      ...(options.quickMatch ? [options.quickMatch] : []),
      el("section", {}, el("h3", {}, "Add a Friend"), add),
      this.outgoingSection, this.blockedSection);
    host.append(this.root);
    inputOf(this.filter).addEventListener("input", () => this.applyFilter());
    getLobby().then(lobby => {
      if (this.gone) return;
      this.lobby = lobby;
      this.off = lobby.onChange(friends => this.update(friends));
      void lobby.refresh();
    }).catch(e => this.showError((e as Error).message));
  }

  /** Fold or unfold Your Friends; only the heading's own press is remembered. */
  setOpen(open: boolean): void {
    this.toggle.setAttribute("aria-expanded", String(open));
    if (open) delete this.fold.dataset.closed; else this.fold.dataset.closed = "";
  }

  private showError(message: string): void {
    if (this.gone) return;
    this.trouble.replaceChildren(el("span", {}, message), el("button", { class: "ghost", onclick: () => { void this.lobby?.refresh(); } }, "Retry"));
    this.trouble.hidden = false;
  }

  update(friends = this.friends): void {
    if (this.gone) return;
    // A Quick Match partner is in the lobby for the match, not a friend.
    friends = friends.filter(f => !f.stranger);
    this.friends = friends;
    this.options.onChange?.(friends);
    if (this.lobby?.lastError) this.showError("Your friends could not refresh. Please try again.");
    else this.trouble.hidden = true;
    const visible = friends.filter(f => f.status !== "blocked" || f.blockedByMe);
    const ids = new Set(visible.map(f => f.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) {
      const hadFocus = row.root.contains(document.activeElement);
      row.root.remove(); this.rows.delete(id);
      if (hadFocus) inputOf(this.filter).focus();
    }
    for (const f of [...visible].sort((a,b) => Number(!!b.activity)-Number(!!a.activity) || a.username.localeCompare(b.username))) {
      let row = this.rows.get(f.id);
      if (!row) { row = this.makeRow(f); this.rows.set(f.id,row); }
      row.friend = f;
      row.name.textContent = f.username;
      row.actions.querySelector("summary")?.setAttribute("aria-label", `Actions for ${f.username}`);
      row.avatar.textContent = f.username.slice(0,2).toUpperCase();
      const activity = f.status === "pending" ? (f.ourMove ? "Wants to be friends" : "Waiting for a reply") :
        f.status === "blocked" ? "Cannot reach you" : f.activity === "in_game" ? "In a game" :
        f.activity ? "Online" : f.connection === "connecting" ? "Connecting…" : f.connection === "unavailable" ? "Unavailable" : "Offline";
      row.status.textContent = activity;
      row.avatar.dataset.activity = f.activity ?? "offline";
      const signature = `${f.status}:${f.ourMove}:${f.theirMove}:${f.blockedByMe}`;
      if (signature !== row.signature) { row.signature = signature; this.actions(row); }
      if (row.invite) {
        const connect = !f.activity && f.connection === "unavailable";
        row.invite.textContent = connect ? "Connect" : "Invite";
        row.invite.setAttribute("aria-label", `${connect ? "Connect to" : "Invite"} ${f.username}`);
        row.invite.disabled = !!this.options.busy?.() || (!f.activity && !connect);
        row.invite.title = this.options.busy?.() ? "Finish or leave the current invitation or game first" : !f.activity ? "Your friend needs to be online" : `Play with ${f.username}`;
      }
      const parent = f.blockedByMe ? this.blocked : f.ourMove ? this.incoming : f.theirMove ? this.outgoing : this.current;
      if (row.root.parentElement !== parent) parent.append(row.root);
    }
    this.incomingSection.hidden = !this.incoming.children.length;
    this.outgoingSection.hidden = !this.outgoing.children.length;
    this.blockedSection.hidden = !this.blocked.children.length;
    this.count.textContent = String(friends.filter(f => f.status === "accepted").length);
    const here = friends.filter(f => f.status === "accepted" && f.activity !== null).length;
    this.online.textContent = here ? `${here} online` : "None online";
    this.applyFilter();
  }

  private applyFilter(): void {
    const query = inputOf(this.filter).value.trim().toLowerCase();
    let shown = 0;
    for (const row of this.rows.values()) {
      if (row.friend.status !== "accepted") continue;
      row.root.hidden = !row.friend.username.toLowerCase().includes(query);
      if (!row.root.hidden) shown++;
    }
    this.empty.hidden = shown > 0;
    this.empty.textContent = query ? "No friends match that name." : "Add a friend below to play together. You can also play on one keyboard.";
  }

  private makeRow(friend: FriendState): FriendRow {
    const name = el("strong", { class: "name" });
    const status = el("span", { class: "friend-state" });
    const avatar = el("span", { class: "friend-avatar", "aria-hidden": "true" });
    const actions = el("div", { class: "friend-actions" });
    const setup = el("div", { class: "friend-setup" });
    const error = el("p", { class: "error", role: "alert", hidden: true });
    const root = el("article", { class: "friend-row", "data-friend": friend.id },
      el("div", { class: "friend-main" }, avatar, el("div", { class: "friend-identity" }, name, status), actions), error, setup);
    return { root, name, status, avatar, actions, setup, error, friend, signature:"" };
  }

  private actions(row: FriendRow): void {
    row.root.querySelector(".remove-confirm")?.remove();
    row.actions.replaceChildren(); row.invite = undefined;
    const f = row.friend;
    const act = (label: string, fn: () => Promise<void>) => el("button", { class: "ghost small", onclick: async (event: Event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true; row.error.hidden = true;
      try { await fn(); await this.lobby?.refreshAfterChange(); }
      catch (error) { row.error.textContent = (error as Error).message; row.error.hidden = false; }
      finally { button.disabled = false; }
    } }, label);
    if (f.ourMove) row.actions.append(act("Accept", () => accept(f.id)), act("Decline", () => remove(f.id)));
    else if (f.theirMove) row.actions.append(act("Cancel", () => remove(f.id)));
    else if (f.blockedByMe) row.actions.append(act("Unblock", () => unblock(f.id)));
    else if (f.status === "accepted") {
      if (this.options.onInvite) {
        row.invite = el("button", { class: "ghost invite-friend", onclick: () => {
          if (!row.friend.activity) this.lobby?.prioritize(f.id);
          else this.options.onInvite?.(row.friend,row.setup);
        } }, "Invite");
        row.actions.append(row.invite);
      }
      const menu = el("details", { class: "friend-more" });
      const summary = el("summary", { "aria-label": `Actions for ${f.username}`, title: `Actions for ${f.username}` }, "•••");
      const confirmation = el("div", { class: "remove-confirm", hidden: true });
      const removeButton = el("button", { class: "ghost danger-text", onclick: () => {
        confirmation.hidden = false; menu.open = false;
        confirmation.querySelector<HTMLButtonElement>("button")?.focus();
      } }, "Remove friend");
      menu.append(summary, el("div", { class: "friend-popover" }, removeButton, act("Block", () => block(f.id))));
      const cancel = el("button", { class: "ghost", onclick: () => { confirmation.hidden = true; summary.focus(); } }, "Keep friend");
      confirmation.append(el("strong", {}, `Remove ${f.username}?`),
        note("Your shared progress will also be deleted. This cannot be undone."),
        el("div", { class: "confirm-actions" }, cancel, act("Remove", () => remove(f.id))));
      row.root.querySelector(".remove-confirm")?.remove();
      row.root.append(confirmation);
      row.actions.append(menu);
    }
  }

  destroy(): void { this.gone = true; this.off?.(); }
}

export function friendsScreen(host: HTMLElement): () => void {
  const body = card("Friends"); host.append(body);
  const copy = el("button", { class: "ghost copy-username" }, `Copy my username: ${auth().profile?.username ?? ""}`);
  const feedback = el("p", { class: "note", role: "status" });
  on(copy, "click", async () => {
    try { await navigator.clipboard.writeText(auth().profile?.username ?? ""); feedback.textContent = "Username copied."; }
    catch { feedback.textContent = "Could not copy. Select the username above to copy it manually."; }
  });
  body.append(copy,feedback);
  const panel = new FriendsPanel(body, { onInvite: () => { location.hash = "/play"; } });
  body.append(note(el("a", { href:"#/play" }, "Back to the game")));
  return () => panel.destroy();
}
