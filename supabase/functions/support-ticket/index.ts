import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import { createSupportHandler, LINK_SECONDS, type FiledTicket } from "./handler.ts";

const env = (name: string) => Deno.env.get(name);
const BUCKET = "support-attachments";
// The service role, because this reads a ticket to mail it and signs links to
// a private bucket. The caller's identity is proved separately, by getUser.
const admin = createClient(env("SUPABASE_URL") ?? "", env("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(createSupportHandler({
  env,
  async verifyUser(token) {
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : data.user;
  },
  async ticket(id) {
    const { data } = await admin.from("support_tickets")
      .select("id, user_id, message, created_at, emailed_at, attachments").eq("id", id).maybeSingle();
    if (!data) return null;
    const { data: profile } = await admin.from("profiles").select("username").eq("id", data.user_id).maybeSingle();
    return { ...data, username: profile?.username ?? null } as FiledTicket;
  },
  async links(paths) {
    const { data } = await admin.storage.from(BUCKET).createSignedUrls(paths, LINK_SECONDS);
    return (data ?? []).map((d) => d.signedUrl ?? "");
  },
  async send(mail, apiKey) {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: mail.from, name: "Fireboy & Watergirl Support" },
        to: [{ email: mail.to }],
        ...(mail.replyTo ? { replyTo: { email: mail.replyTo } } : {}),
        subject: mail.subject, htmlContent: mail.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  },
  async markEmailed(id) {
    await admin.from("support_tickets").update({ emailed_at: new Date().toISOString() }).eq("id", id);
  },
  async purgeOlderThan(days) {
    const before = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data } = await admin.from("support_tickets").select("id, attachments")
      .lt("created_at", before).neq("attachments", "[]").limit(50);
    for (const row of data ?? []) {
      const paths = (row.attachments as { path: string }[]).map((a) => a.path);
      if (paths.length) await admin.storage.from(BUCKET).remove(paths);
      await admin.from("support_tickets").update({ attachments: [] }).eq("id", row.id);
    }
  },
}));
