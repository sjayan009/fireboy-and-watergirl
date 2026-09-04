/**
 * Managing friends: add one, answer the ones who added you, drop the rest.
 *
 * Deliberately separate from the play screen. Adding a friend is a thing you do
 * occasionally and carefully; inviting one is a thing you do every time you sit
 * down. Mixing them puts a destructive "remove" next to a "play" you press
 * constantly.
 */
import {
  accept, block, listFriends, remove, request, unblock, Friend,
} from "../friends.js";
import { peekLobby } from "../lobby.js";
import { card, el, field, form, inputOf, note } from "../ui/dom.js";

/**
 * How often the list asks again while it is on screen.
 *
 * The screen used to be a snapshot taken on entry that redrew only after the
 * local user's own actions, so a request arriving while you sat looking at the
 * page was invisible until you navigated away and back. The two-person browser
 * test encoded the workaround -- it reloads in a loop waiting for the other
 * account's request to appear -- which is the sort of thing a test does when
 * the product is wrong and nobody has said so.
 *
 * Polling rather than a Postgres-changes subscription, and that is a
 * deliberately unambitious choice: `friendships` is not in the Realtime
 * publication, adding it would put every row change on a socket, and the whole
 * question here is "has anything happened to my handful of rows". One small
 * query every twelve seconds, only while the tab is visible, answers it.
 */
const POLL_MS = 12000;

export function friendsScreen(host: HTMLElement): () => void {
  const name = field("Their username", {
    required: true, minlength: 3, maxlength: 20, autocomplete: "off",
  });
  const sent = note("Request sent.");
  sent.hidden = true;

  // Row actions are one click with no form around them, so without this a
  // failed accept looks exactly like a click that never landed.
  const trouble = el("p", { class: "error", role: "alert" });
  trouble.hidden = true;
  const act = (fn: () => Promise<void>) => async (e: Event) => {
    const button = e.currentTarget as HTMLButtonElement;
    button.disabled = true;
    trouble.hidden = true;
    try {
      await fn();
      await draw();
      // A friendship that just changed state changes which channels the lobby
      // should hold. It re-reads the list only when asked, so accepting a
      // request here used to leave the two of you unable to see each other
      // until something else -- usually opening the play screen -- refreshed
      // it.
      void peekLobby()?.then((l) => l.refresh()).catch(() => { /* it will */ });
    } catch (err) {
      trouble.textContent = (err as Error).message;
      trouble.hidden = false;
      button.disabled = false;
    }
  };

  const incoming = el("div", { class: "list" });
  const outgoing = el("div", { class: "list" });
  const current = el("div", { class: "list" });
  const blocked = el("div", { class: "list" });

  const sections = {
    incoming: el("section", {}, el("h2", {}, "Waiting for you"), incoming),
    outgoing: el("section", {}, el("h2", {}, "Asked"), outgoing),
    current: el("section", {}, el("h2", {}, "Friends"), current),
    blocked: el("section", {}, el("h2", {}, "Blocked"), blocked),
  };
  for (const s of Object.values(sections)) s.hidden = true;

  host.append(card("Friends",
    note("Add someone by the exact username they picked."),
    form({
      submit: "Send a request",
      children: [name, sent],
      onSubmit: async () => {
        await request(inputOf(name).value.trim());
        inputOf(name).value = "";
        sent.hidden = false;
        await draw();
      },
    }),
    trouble, sections.incoming, sections.outgoing, sections.current,
    sections.blocked,
    el("p", { class: "note" }, el("a", { href: "#/play" }, "Back to the game"))));

  /**
   * Whether this screen is still on show.
   *
   * `draw` is async and is now also started by a timer, so a redraw can be in
   * flight when the route changes -- and writing into a detached DOM is at best
   * wasted work and at worst a stale list appearing on the next screen.
   */
  let gone = false;
  /** So two refreshes cannot interleave and render each other's rows. */
  let drawing = 0;

  async function draw(): Promise<void> {
    const mine = ++drawing;
    let all: Friend[];
    try {
      all = await listFriends();
    } catch (e) {
      if (gone || mine !== drawing) return;
      current.replaceChildren(note((e as Error).message));
      return;
    }
    if (gone || mine !== drawing) return;

    const rows = (list: Friend[], actions: (f: Friend) => Node[]) =>
      list.map((f) => el("div", { class: "row" },
        el("span", { class: "name" }, f.username), ...actions(f)));

    const waiting = all.filter((f) => f.ourMove);
    const asked = all.filter((f) => f.theirMove);
    const friends = all.filter((f) => f.status === "accepted");
    // Only the blocks that are ours to lift. A row somebody blocked US on is
    // still a row we can read, and putting it on screen would announce a thing
    // they did not choose to tell us -- and offer a button that the database
    // will refuse anyway.
    const shut = all.filter((f) => f.blockedByMe);

    incoming.replaceChildren(...rows(waiting, (f) => [
      el("button", { class: "ghost", onclick: act(() => accept(f.id)) },
         "Accept"),
      el("button", { class: "ghost", onclick: act(() => remove(f.id)) },
         "Ignore"),
    ]));

    outgoing.replaceChildren(...rows(asked, (f) => [
      el("span", { class: "dim" }, "waiting"),
      el("button", { class: "ghost", onclick: act(() => remove(f.id)) },
         "Cancel"),
    ]));

    current.replaceChildren(...rows(friends, (f) => [
      // Blocking keeps the friendship row, and with it the levels the two of
      // you finished together; removing throws them away. Two buttons because
      // they are two different decisions, and the reversible one goes first.
      el("button", {
        class: "ghost", onclick: act(() => block(f.id)),
      }, "Block"),
      el("button", {
        class: "ghost",
        onclick: act(async () => {
          // Unfriending cascades to `pair_progress`, so it is worth saying so
          // rather than discovering it afterwards.
          if (!confirm(
            `Remove ${f.username}? The levels you finished together go too.`)) {
            return;
          }
          await remove(f.id);
        }),
      }, "Remove"),
    ]));

    blocked.replaceChildren(...rows(shut, (f) => [
      el("span", { class: "dim" }, "cannot reach you"),
      el("button", {
        class: "ghost", onclick: act(() => unblock(f.id)),
      }, "Unblock"),
    ]));

    if (friends.length === 0) {
      current.replaceChildren(note("Nobody yet. The game needs two."));
    }
    sections.incoming.hidden = waiting.length === 0;
    sections.outgoing.hidden = asked.length === 0;
    sections.current.hidden = false;
    sections.blocked.hidden = shut.length === 0;
  }

  void draw();

  // Whatever the other person did while this was open. Coalesced with the
  // ordinary redraw -- `draw` is idempotent and guards its own ordering -- and
  // paused while the tab is hidden, because a list nobody is looking at does
  // not need to be current.
  const tick = setInterval(() => {
    if (document.visibilityState === "visible") void draw();
  }, POLL_MS);
  // And at once on coming back, so returning to the tab is not a twelve-second
  // wait for news that is already a minute old.
  const onWake = () => {
    if (document.visibilityState === "visible") void draw();
  };
  document.addEventListener("visibilitychange", onWake);
  addEventListener("focus", onWake);

  return () => {
    gone = true;
    clearInterval(tick);
    document.removeEventListener("visibilitychange", onWake);
    removeEventListener("focus", onWake);
  };
}
