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
import { card, el, field, form, inputOf, note } from "../ui/dom.js";

export function friendsScreen(host: HTMLElement): void {
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

  async function draw(): Promise<void> {
    let all: Friend[];
    try {
      all = await listFriends();
    } catch (e) {
      current.replaceChildren(note((e as Error).message));
      return;
    }

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
}
