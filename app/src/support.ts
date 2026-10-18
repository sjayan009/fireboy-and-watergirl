/**
 * Support tickets: the account's own, and sending a new one.
 *
 * Everything here runs as the signed-in player. Reading is row level security
 * (`support_tickets_read_own`); writing is two functions, `submit_ticket` and
 * `delete_ticket`, which check the account is fully in and hold the limits.
 * Attachments go to the private `support-attachments` bucket first, under the
 * player's own folder, and the ticket then names them.
 */
import { auth } from "./auth.js";
import { supabase } from "./supabase.js";

export type Stage = "sent" | "reviewed" | "in_progress" | "fixed";

export interface Attachment { path: string; name: string; bytes: number }

export interface Ticket {
  id: number;
  message: string;
  stage: Stage;
  created: string;
  /** When each stage was reached, for the timeline. */
  reached: Partial<Record<Stage, string>>;
  attachments: Attachment[];
  deleted?: string;
}

const BUCKET = "support-attachments";

interface Row {
  id: number; message: string; stage: Stage; created_at: string;
  reviewed_at: string | null; in_progress_at: string | null; fixed_at: string | null;
  deleted_at: string | null; attachments: Attachment[];
}

export async function listTickets(): Promise<Ticket[]> {
  const { data, error } = await supabase.from("support_tickets")
    .select("id, message, stage, created_at, reviewed_at, in_progress_at, fixed_at, deleted_at, attachments")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load your tickets: ${error.message}`);
  return (data as Row[]).map((r) => ({
    id: r.id, message: r.message, stage: r.stage, created: r.created_at,
    reached: { sent: r.created_at, reviewed: r.reviewed_at ?? undefined,
               in_progress: r.in_progress_at ?? undefined, fixed: r.fixed_at ?? undefined },
    attachments: r.attachments ?? [], deleted: r.deleted_at ?? undefined,
  }));
}

/** A name Storage will take, still recognisable: letters, digits, dot, dash. */
function safe(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "file").slice(-80);
}

/**
 * Upload the files, then file the ticket that names them.
 *
 * If filing fails the uploads are taken back, so a refused ticket leaves
 * nothing behind. The email to the developer is asked for afterwards and not
 * waited on: the ticket is stored either way, and a failed email must not
 * read to the player as a failed ticket.
 */
export async function submitTicket(message: string, files: File[]): Promise<number> {
  const me = auth().user?.id;
  if (!me) throw new Error("Sign in again to send this.");
  const folder = `${me}/${crypto.randomUUID()}`;
  const paths: string[] = [];
  try {
    for (const [i, f] of files.entries()) {
      const path = `${folder}/${i + 1}-${safe(f.name)}`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, f, {
        contentType: f.type || "application/octet-stream", upsert: false });
      if (error) throw new Error(`${f.name} did not upload: ${error.message}`);
      paths.push(path);
    }
    const { data, error } = await supabase.rpc("submit_ticket", { message, paths });
    if (error) throw new Error(error.message);
    void supabase.functions.invoke("support-ticket", { body: { ticket: data } })
      .catch((e: unknown) => console.warn("the support email was not sent:", e));
    return data as number;
  } catch (e) {
    if (paths.length) await supabase.storage.from(BUCKET).remove(paths).catch(() => {});
    throw e;
  }
}

export async function deleteTicket(id: number): Promise<void> {
  const { error } = await supabase.rpc("delete_ticket", { ticket: id });
  if (error) throw new Error(error.message);
}

/** A link to one of your own attachments, good for a minute. */
export async function attachmentLink(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
  if (error || !data) throw new Error("That attachment is no longer available.");
  return data.signedUrl;
}
