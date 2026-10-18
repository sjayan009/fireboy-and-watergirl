/**
 * The support desk from the developer's side: every player's tickets, and
 * one press to move each along.
 *
 * Open to an account listed in `play_private.support_admins`, and to nobody
 * else -- the database decides (`admin_tickets`, `admin_set_ticket_stage`),
 * so this screen showing or not is not the gate. Anybody else who finds the
 * address is told it is not for them.
 *
 * Laid out like the player's own Support board, by stage rather than by
 * open/closed: New, Reviewed, In progress, Fixed, and Deleted for tickets a
 * player took back. Each ticket opens to who sent it, a reply link, the
 * message, its attachments and four stage buttons; the player sees the
 * change the next time they open Support.
 */
import { card as plainCard, el, note } from "../ui/dom.js";
import "../ui/support.css";
import { adminTickets, attachmentLink, setTicketStage, type AdminTicket, type Stage } from "../support.js";

type Pile = Stage | "deleted";
const PILES: [Pile, string][] = [["sent", "New"], ["reviewed", "Reviewed"], ["in_progress", "In progress"], ["fixed", "Fixed"], ["deleted", "Deleted"]];
const STAGES: [Stage, string][] = [["sent", "New"], ["reviewed", "Reviewed"], ["in_progress", "In progress"], ["fixed", "Fixed"]];
const date = (iso: string) => new Date(iso).toLocaleString(undefined,
  { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const size = (b: number) => b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`;

export function supportAdminScreen(host: HTMLElement): void {
  const box = el("div", { class: "support-board" });
  const c = plainCard("Support Admin",
    note("Every player's tickets. Open one and press a stage to move it; the " +
         "player sees it the next time they open Support."), box);
  c.classList.add("support-card", "support-admin");
  host.append(c);

  let pile: Pile = "sent";
  let loaded = false;
  const load = async () => {
    if (!loaded) box.replaceChildren(note("Loading tickets…"));
    let tickets: AdminTicket[];
    try {
      tickets = await adminTickets();
    } catch (e) {
      box.replaceChildren(el("p", { class: "error", role: "alert" }, (e as Error).message));
      return;
    }
    loaded = true;
    draw(tickets);
  };

  const pileOf = (t: AdminTicket): Pile => t.deleted ? "deleted" : t.stage;
  const draw = (tickets: AdminTicket[]) => {
    const count = (p: Pile) => tickets.filter((t) => pileOf(t) === p).length;
    const list = el("div", { class: "ticket-pile", role: "tabpanel" });
    const tabs = el("div", { class: "ticket-tabs", role: "tablist" });
    const show = (p: Pile) => {
      pile = p;
      for (const b of tabs.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.pile === p));
      const shown = tickets.filter((t) => pileOf(t) === p);
      list.replaceChildren(shown.length ? el("ul", { class: "tickets" }, ...shown.map((t) => row(t, load)))
        : note(p === "sent" ? "No new tickets." : "Nothing here."));
    };
    tabs.append(...PILES.map(([p, label]) => el("button", {
      class: "ghost", role: "tab", "data-pile": p, "aria-selected": String(p === pile),
      onclick: () => show(p) }, `${label} · ${count(p)}`)));
    show(pile);
    box.replaceChildren(
      el("div", { class: "ticket-stats" },
        stat(String(count("sent")), "new", "gem-gold"),
        stat(String(count("reviewed") + count("in_progress")), "being worked on", "gem-fire"),
        stat(String(count("fixed")), "fixed", "gem-water")),
      tabs, list);
  };
  void load();
}

function stat(value: string, label: string, gem: string): HTMLElement {
  return el("div", { class: "ticket-stat" }, el("span", { class: `gem ${gem}`, "aria-hidden": "true" }),
    el("strong", {}, value), el("span", {}, label));
}

/** One ticket: who and when on the outside; everything, and the stage buttons, inside. */
function row(t: AdminTicket, reload: () => Promise<void>): HTMLElement {
  const said = el("p", { class: "note", role: "status" });
  said.hidden = true;
  const stages = el("div", { class: "stage-picker", role: "group", "aria-label": `Stage of ticket #${t.id}` },
    ...STAGES.map(([s, label]) => el("button", {
      type: "button", class: "ghost", "aria-pressed": String(t.stage === s), disabled: !!t.deleted,
      onclick: async (e: Event) => {
        if (t.stage === s) return;
        const pressed = e.currentTarget as HTMLButtonElement;
        for (const b of stages.querySelectorAll("button")) b.disabled = true;
        pressed.textContent = "…";
        try {
          await setTicketStage(t.id, s);
          await reload();
        } catch (err) {
          said.textContent = (err as Error).message;
          said.hidden = false;
          pressed.textContent = label;
          for (const b of stages.querySelectorAll("button")) b.disabled = false;
        }
      } }, label)));
  const reply = t.email ? el("a", {
    href: `mailto:${t.email}?subject=${encodeURIComponent(`Re: your support ticket #${t.id}`)}` }, "Reply by email") : null;
  return el("li", {}, el("details", { class: "ticket" },
    el("summary", {},
      el("span", { class: "ticket-head" }, el("strong", {}, `#${t.id}`), ` · ${t.username ?? "no username"} · ${date(t.created)}`),
      el("span", { class: `ticket-badge s-${t.deleted ? "deleted" : t.stage}` },
        t.deleted ? "Deleted by player" : STAGES.find(([s]) => s === t.stage)![1]),
      el("span", { class: "ticket-preview" }, t.message)),
    el("p", { class: "note" }, `From ${t.username ?? "a player"}`, t.email ? ` · ${t.email} · ` : "", reply),
    el("p", { class: "ticket-message" }, t.message),
    t.attachments.length ? el("p", { class: "note ticket-files" },
      `${t.attachments.length} attachment${t.attachments.length === 1 ? "" : "s"}: `,
      ...t.attachments.flatMap((a, i) => [i ? ", " : "", el("a", { href: "#", onclick: async (e: Event) => {
        e.preventDefault();
        const tab = window.open("", "_blank");
        try { if (tab) tab.location.href = await attachmentLink(a.path); }
        catch (err) { tab?.close(); alert((err as Error).message); }
      } }, a.name), ` (${size(a.bytes)})`])) : null,
    t.deleted ? note("The player deleted this ticket; its stage can no longer be changed.") : stages,
    said));
}
