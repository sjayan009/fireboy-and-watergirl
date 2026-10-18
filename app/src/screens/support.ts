/**
 * Support: one box to say what happened, and somewhere to put screenshots.
 *
 * Opened from the Menu in a tab of its own, so the game it is about stays
 * where it was. Only a signed-in account can send one -- the ticket is stored
 * against the account, and the database refuses anybody else (see
 * `submit_ticket`) -- so a signed-out visitor is asked to sign in, with the
 * address to write to for somebody who cannot.
 *
 * Attachments come three ways, because people have them in three places: a
 * screenshot on the clipboard (Ctrl+V anywhere on the page), files dragged
 * onto the box, or the file picker. All of them count against one limit,
 * `MAX_BYTES`, checked here for a quick answer and again by Storage itself,
 * which is the check that counts.
 */
import { auth, clearReturn, returnAfterSignIn } from "../auth.js";
import "../ui/support.css";
import { card as plainCard, el, form, note } from "../ui/dom.js";
import { attachmentLink, deleteTicket, isSupportAdmin, listTickets, submitTicket, type Stage, type Ticket } from "../support.js";

export const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
export const SUPPORT_EMAIL = "sirikonda.jayan9@gmail.com";

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB`
                             : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The account card, with the fire-and-water edge Support wears. */
const card: typeof plainCard = (...args) => {
  const c = plainCard(...args);
  c.classList.add("support-card");
  return c;
};

const emailLine = () => note("Can't sign in at all? Email ",
  el("a", { href: `mailto:${SUPPORT_EMAIL}` }, SUPPORT_EMAIL), ".");

export function supportScreen(host: HTMLElement): () => void {
  if (auth().stage !== "in") {
    host.append(card("Support",
      note("Sign in to open a ticket. It is tied to your account, so the reply " +
           "reaches you and nobody else can read it."),
      el("a", { class: "primary button-link", href: "#/login",
                onclick: () => returnAfterSignIn("/support-ticket") }, "Sign In"),
      emailLine()));
    return () => {};
  }


  clearReturn();
  const box = el("div", { class: "support-board" });
  host.append(card("Support", box));
  // The developer's way to every ticket; asked of the database, so it shows
  // for the support admin and for nobody else.
  void isSupportAdmin().then((yes) => {
    if (yes) box.before(el("p", { class: "support-admin-link" }, el("a", { href: "#/support-admin" }, "Open the admin view")));
  });
  let cleanup = () => {};
  // Fetched when the screen opens and after something changes them (a ticket
  // sent or deleted) -- never to switch piles, which only re-sorts what is
  // already here. The loading line shows on the first fetch alone; a refresh
  // leaves the board up until the new one is ready.
  let loaded = false;
  // The pile on show, kept here rather than in the board: a refresh that
  // lands after somebody switched piles redraws the pile they switched to.
  let current: Tab = "open";
  const showBoard = async () => {
    cleanup();
    cleanup = () => {};
    if (!loaded) box.replaceChildren(note("Loading your tickets…"));
    let tickets: Ticket[];
    try {
      tickets = await listTickets();
    } catch (e) {
      box.replaceChildren(el("p", { class: "error", role: "alert" }, (e as Error).message));
      return;
    }
    loaded = true;
    if (!tickets.length) { showForm(false); return; }
    box.replaceChildren(...board(tickets, current, () => showForm(), () => void showBoard(),
                                 (p) => { current = p; }));
  };
  const showForm = (canGoBack = true) => {
    cleanup();
    const view = ticketForm(() => void showBoard(), canGoBack ? () => void showBoard() : null);
    cleanup = view.remove;
    box.replaceChildren(...view.nodes);
  };
  void showBoard();
  return () => cleanup();
}

type Tab = "open" | "completed" | "deleted";
/** Each step: its short name on the track, and its full name on the badge. */
const STAGES: [Stage, string, string][] = [["sent", "Sent", "Sent"], ["reviewed", "Reviewed", "Reviewed by the dev team"],
  ["in_progress", "In progress", "In progress"], ["fixed", "Fixed", "Fixed"]];
const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * Every ticket this account has filed: how many, where each one stands, and
 * the three piles -- open, completed, deleted. A deleted ticket is hidden
 * from the open pile, not erased, so it is still there to look back on.
 */
function board(tickets: Ticket[], tab: Tab, compose: () => void, reload: () => void,
               chose: (tab: Tab) => void): Node[] {
  const pile = (t: Ticket): Tab => t.deleted ? "deleted" : t.stage === "fixed" ? "completed" : "open";
  const count = (p: Tab) => tickets.filter((t) => pile(t) === p).length;
  // Switching piles redraws the list and nothing else: the counts, the button
  // and the tabs stay put, so only what changed moves.
  const list = el("div", { class: "ticket-pile", role: "tabpanel" });
  const show = (p: Tab) => {
    tab = p;
    chose(p);
    for (const b of tabs.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.pile === p));
    const shown = tickets.filter((t) => pile(t) === p);
    list.replaceChildren(shown.length
      ? el("ul", { class: "tickets" }, ...shown.map((t) => ticketRow(t, reload)))
      : note(p === "open" ? "Nothing open. If something goes wrong, New Ticket is right above."
           : p === "completed" ? "Nothing fixed yet." : "Nothing deleted."));
  };
  const tabs = el("div", { class: "ticket-tabs", role: "tablist" },
    ...(["open", "completed", "deleted"] as Tab[]).map((p) => el("button", {
      class: "ghost", role: "tab", "data-pile": p, "aria-selected": String(p === tab),
      onclick: () => show(p) }, `${p[0].toUpperCase()}${p.slice(1)} · ${count(p)}`)));
  show(tab);
  return [
    el("div", { class: "ticket-stats" },
      stat(String(tickets.length), "filed", "gem-gold"),
      stat(String(count("open")), "open", "gem-fire"),
      stat(String(count("completed")), "fixed", "gem-water")),
    el("button", { class: "primary", onclick: compose }, "New Ticket"),
    tabs,
    list,
  ];
}

function stat(value: string, label: string, gem: string): HTMLElement {
  return el("div", { class: "ticket-stat" }, el("span", { class: `gem ${gem}`, "aria-hidden": "true" }),
    el("strong", {}, value), el("span", {}, label));
}

/** One ticket: the summary always, the whole message and its timeline on opening. */
function ticketRow(t: Ticket, redraw: () => void): HTMLElement {
  const at = STAGES.findIndex(([s]) => s === t.stage);
  const track = el("ol", { class: "ticket-track", style: `--done:${at / (STAGES.length - 1)}`,
    "aria-label": `Status: ${STAGES[at][2]}` },
    ...STAGES.map(([s, label], i) => el("li", { class: i < at ? "done" : i === at ? "now" : "" },
      el("span", { class: "gem", "aria-hidden": "true" }),
      el("span", { class: "ticket-step" }, label),
      t.reached[s] ? el("span", { class: "ticket-when" }, date(t.reached[s]!)) : null)));
  const remove = t.deleted ? null : el("button", { class: "ghost small", onclick: async () => {
    if (!confirm(`Delete ticket #${t.id}? It moves to Deleted, and we stop working on it.`)) return;
    try { await deleteTicket(t.id); redraw(); }
    catch (err) { alert((err as Error).message); }
  } }, "Delete ticket");
  return el("li", {}, el("details", { class: "ticket" },
    el("summary", {},
      el("span", { class: "ticket-head" }, el("strong", {}, `#${t.id}`), ` · Filed ${date(t.created)}`),
      el("span", { class: `ticket-badge s-${t.deleted ? "deleted" : t.stage}` },
        t.deleted ? "Deleted" : STAGES[at][2]),
      el("span", { class: "ticket-preview" }, t.message)),
    t.deleted ? note(`Deleted ${date(t.deleted)}.`) : track,
    el("p", { class: "ticket-message" }, t.message),
    t.attachments.length ? el("p", { class: "note ticket-files" },
      `${t.attachments.length} attachment${t.attachments.length === 1 ? "" : "s"}: `,
      ...t.attachments.flatMap((a, i) => [i ? ", " : "", el("a", { href: "#", onclick: async (e: Event) => {
        e.preventDefault();
        // Opened first, filled in after: a tab opened after an await is a popup.
        const tab = window.open("", "_blank");
        try { if (tab) tab.location.href = await attachmentLink(a.path); }
        catch (err) { tab?.close(); alert((err as Error).message); }
      } }, a.name), ` (${size(a.bytes)})`])) : null,
    remove));
}

/** The new-ticket form, and what to undo when it goes. */
function ticketForm(sent: () => void, back: (() => void) | null): { nodes: Node[]; remove: () => void } {
  const files: File[] = [];
  const message = el("textarea", {
    class: "support-message", required: true, minlength: 10, maxlength: 5000,
    rows: 6, placeholder: "What happened, and what did you expect? Which level, if it was in the game.",
  });
  const list = el("ul", { class: "attachments" });
  const meter = el("p", { class: "attach-meter" });
  const problem = el("p", { class: "error", role: "alert" });
  problem.hidden = true;
  const picker = el("input", { type: "file", multiple: true, hidden: true });

  const draw = () => {
    const used = files.reduce((n, f) => n + f.size, 0);
    meter.textContent = files.length ? `${size(used)} of ${size(MAX_BYTES)}` : `Up to ${size(MAX_BYTES)} in all`;
    list.replaceChildren(...files.map((f, i) => {
      const thumb = f.type.startsWith("image/")
        ? el("img", { class: "attach-thumb", src: URL.createObjectURL(f), alt: "" })
        : el("span", { class: "attach-thumb attach-file", "aria-hidden": "true" }, "FILE");
      return el("li", {}, thumb,
        el("span", { class: "attach-name" }, f.name, el("br"), el("span", { class: "note" }, size(f.size))),
        el("button", { type: "button", class: "ghost small", "aria-label": `Remove ${f.name}`,
          onclick: () => { files.splice(i, 1); draw(); } }, "Remove"));
    }));
  };
  const add = (incoming: Iterable<File>) => {
    problem.hidden = true;
    for (const f of incoming) {
      const used = files.reduce((n, x) => n + x.size, 0);
      if (files.length >= MAX_FILES) { problem.textContent = `Up to ${MAX_FILES} files.`; problem.hidden = false; break; }
      if (used + f.size > MAX_BYTES) {
        problem.textContent = `${f.name} would take this past ${size(MAX_BYTES)}. Leave it out, or send it in another ticket.`;
        problem.hidden = false;
        continue;
      }
      // A pasted screenshot is always "image.png"; number them so two read apart.
      files.push(f.name === "image.png" ? new File([f], `screenshot-${files.length + 1}.png`, { type: f.type }) : f);
    }
    draw();
  };

  picker.addEventListener("change", () => { add(picker.files ?? []); picker.value = ""; });
  const drop = el("div", { class: "attach-drop", tabindex: "0", role: "button",
    "aria-label": "Add files: paste with Control V, drop files here, or press to choose",
    onclick: () => picker.click(),
    onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") { e.preventDefault(); picker.click(); } } },
    el("strong", {}, "Paste a screenshot"), el("span", {}, " with Ctrl+V, drop files here, or ",
      el("span", { class: "attach-pick" }, "choose files")));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); add(e.dataTransfer?.files ?? []); });
  // Anywhere on the page: nobody should have to aim a paste.
  const paste = (e: ClipboardEvent) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (!pasted.length) return;
    e.preventDefault();
    add(pasted);
  };
  document.addEventListener("paste", paste);
  draw();


  const who = auth();
  return {
    remove: () => document.removeEventListener("paste", paste),
    nodes: [
      note("Tell us what went wrong. A screenshot usually says it fastest."),
      form({
        submit: "Send to Support",
        children: [
          el("label", { class: "field" }, el("span", {}, "What's going on?"), message),
          drop, picker, meter, list, problem,
          note("We'll reply to ", el("strong", {}, who.user?.email ?? "your address"), "."),
        ],
        onSubmit: async () => {
          await submitTicket(message.value.trim(), files);
          sent();
        },
        footer: back ? el("p", { class: "note" }, el("a", { href: "#", onclick: (e: Event) => {
          e.preventDefault();
          back();
        } }, "Back to my tickets")) : emailLine(),
      })],
  };
}
