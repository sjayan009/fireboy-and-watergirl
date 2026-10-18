/**
 * Email the developer a ticket that has just been filed, once.
 *
 * Called by the player's browser straight after `submit_ticket`, with the
 * ticket's number. It proves who is calling, mails only a ticket that caller
 * owns and that has not been mailed before (`emailed_at`), so it cannot be
 * used to send mail about anything else or to send the same mail twice.
 * Tickets are capped at three a day per account, so the mail is too.
 *
 * Attachments go as links, signed for seven days, not as attachments: they
 * stay in the private bucket and the mail stays small.
 *
 * Each call also clears attachments from tickets over 90 days old -- the
 * retention promised in the migration -- so no scheduled job is needed.
 */
export const LINK_SECONDS = 7 * 24 * 60 * 60;
export const KEEP_DAYS = 90;

export interface FiledTicket {
  id: number; user_id: string; message: string; created_at: string;
  emailed_at: string | null; username: string | null;
  attachments: { path: string; name: string; bytes: number }[];
}

export interface Mail { to: string; from: string; replyTo?: string; subject: string; html: string }

export interface SupportDependencies {
  env(name: string): string | undefined;
  verifyUser(token: string): Promise<{ id: string; email?: string; is_anonymous?: boolean } | null>;
  ticket(id: number): Promise<FiledTicket | null>;
  links(paths: string[]): Promise<string[]>;
  send(mail: Mail, apiKey: string): Promise<boolean>;
  markEmailed(id: number): Promise<void>;
  purgeOlderThan(days: number): Promise<void>;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const size = (b: number) => b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`;

export function ticketMail(t: FiledTicket, email: string | undefined, links: string[]): { subject: string; html: string } {
  const who = t.username ?? "a player";
  const files = t.attachments.map((a, i) =>
    `<li><a href="${escape(links[i] ?? "")}">${escape(a.name)}</a> (${size(a.bytes)})</li>`).join("");
  return {
    subject: `Support #${t.id} from ${who}`,
    html: `<h2>Support ticket #${t.id}</h2>` +
      `<p>From <strong>${escape(who)}</strong>${email ? ` &lt;${escape(email)}&gt;` : ""}, ` +
      `${escape(new Date(t.created_at).toUTCString())}.</p>` +
      `<p style="white-space:pre-wrap">${escape(t.message)}</p>` +
      (files ? `<p>Attachments (links work for 7 days):</p><ul>${files}</ul>` : "") +
      `<p>Move it along in the Supabase Table Editor: <code>support_tickets</code>, column <code>stage</code>.</p>`,
  };
}

export function createSupportHandler(deps: SupportDependencies): (req: Request) => Promise<Response> {
  const allowed = (deps.env("SUPPORT_ALLOWED_ORIGINS") ?? deps.env("TURN_ALLOWED_ORIGINS") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return async (req) => {
    const origin = req.headers.get("origin");
    const originAllowed = !origin || allowed.includes(origin);
    const headers: Record<string, string> = {
      "Cache-Control": "no-store", "Content-Type": "application/json", "Vary": "Origin",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (originAllowed && origin) headers["Access-Control-Allow-Origin"] = origin;
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
    if (!originAllowed) return reply(403, { error: "Origin not allowed" });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

    const bearer = /^Bearer ([^\s]+)$/i.exec(req.headers.get("authorization") ?? "");
    if (!bearer || bearer[1].length > 8192) return reply(401, { error: "Authentication required" });
    let user: Awaited<ReturnType<SupportDependencies["verifyUser"]>>;
    try { user = await deps.verifyUser(bearer[1]); } catch { user = null; }
    if (!user?.id || user.is_anonymous) return reply(401, { error: "Authentication required" });

    let id: number;
    try {
      const body = await req.json() as { ticket?: unknown };
      id = Number(body.ticket);
    } catch { return reply(400, { error: "Bad request" }); }
    if (!Number.isSafeInteger(id) || id < 1) return reply(400, { error: "Bad request" });

    const ticket = await deps.ticket(id);
    // Somebody else's ticket reads exactly like no ticket.
    if (!ticket || ticket.user_id !== user.id) return reply(404, { error: "No such ticket" });
    if (ticket.emailed_at) return reply(200, { emailed: true });

    const apiKey = deps.env("BREVO_API_KEY");
    const to = deps.env("SUPPORT_EMAIL_TO");
    const from = deps.env("SUPPORT_EMAIL_FROM");
    if (!apiKey || !to || !from) return reply(503, { error: "Support email is not set up" });
    const links = ticket.attachments.length ? await deps.links(ticket.attachments.map((a) => a.path)) : [];
    const { subject, html } = ticketMail(ticket, user.email, links);
    if (!await deps.send({ to, from, replyTo: user.email, subject, html }, apiKey)) {
      return reply(502, { error: "Support email failed" });
    }
    await deps.markEmailed(id);
    try { await deps.purgeOlderThan(KEEP_DAYS); } catch { /* next ticket tries again */ }
    return reply(200, { emailed: true });
  };
}
