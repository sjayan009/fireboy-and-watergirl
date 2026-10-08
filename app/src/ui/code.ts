/**
 * Typing in a code from an email: the field, and how long it has left.
 *
 * Shared by sign-up, password reset and changing address, so all three behave
 * the same way.
 */
import { el, field, inputOf } from "./dom.js";

/**
 * These three mirror Supabase's settings and must change with them: Email OTP
 * Length, Email OTP Expiration (900 s), and the one-email-per-address-per-
 * minute limit. The field accepts any length from 6 to 10 so a mismatch
 * cannot lock anybody out; it only loses the auto-submit.
 */
export const CODE_LENGTH = 8;
export const CODE_LIFETIME = 15 * 60_000;
export const RESEND_GAP = 60_000;

/**
 * The code input. Strips anything that is not a digit as it is typed or
 * pasted ("1234 5678", "1234-5678"), and submits its form the moment the
 * code is whole and nothing else is missing, so a pasted or autofilled code
 * needs no second press.
 */
export function codeField(label = "Code from the email"): HTMLLabelElement {
  const wrap = field(label, {
    class: "code-input", required: true, inputmode: "numeric",
    autocomplete: "one-time-code", maxlength: 14, spellcheck: "false",
    enterkeyhint: "go",
  });
  const input = inputOf(wrap);
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "");
    if (digits !== input.value) input.value = digits;
    // Not while another field is still empty -- the email-change form has
    // two codes -- or the browser would flag that field mid-typing.
    if (digits.length === CODE_LENGTH && input.form?.checkValidity()) {
      input.form.requestSubmit();
    }
  });
  return wrap;
}

/** The code as typed, or the reason it cannot be one. */
export function readCode(wrap: HTMLLabelElement): string {
  const code = inputOf(wrap).value.replace(/\D/g, "");
  if (!/^\d{6,10}$/.test(code)) {
    throw new Error(`The code is the ${CODE_LENGTH}-digit number in the email.`);
  }
  return code;
}

/**
 * Try a code; on a refusal, select it so typing again replaces it.
 */
export async function tryCode(wrap: HTMLLabelElement,
                              attempt: (code: string) => Promise<void>): Promise<void> {
  try {
    await attempt(readCode(wrap));
  } catch (e) {
    inputOf(wrap).select();
    throw e;
  }
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * "Expires in 14:32", and the way to a new code beside it.
 *
 * `sentAt` is when the newest code was asked for, or null when this page does
 * not know (it was reloaded, or the code was sent from another device). Then
 * there is no clock to show, only the resend.
 *
 * The ticking text is a `timer`, which screen readers do not announce every
 * second; what changes the situation -- expired, resent -- goes to a separate
 * status line that is announced once.
 */
export function codeClock(sentAt: number | null,
                          resend: () => Promise<void>): HTMLElement {
  const left = el("span", { role: "timer" });
  const said = el("p", { class: "note", role: "status" });
  const button = el("button", { type: "button", class: "link-button" },
                    "Send a new code");
  const row = el("p", { class: "note code-clock" }, left, button);
  const box = el("div", {}, row, said);

  let expired = false;
  const tick = () => {
    const now = Date.now();
    if (sentAt === null) {
      left.textContent = "";
      button.disabled = false;
      button.textContent = "Send a new code";
      return;
    }
    const remaining = sentAt + CODE_LIFETIME - now;
    const wait = sentAt + RESEND_GAP - now;
    if (remaining > 0) {
      left.textContent = `Expires in ${clock(remaining)}`;
      left.className = "";
    } else {
      left.textContent = "This code has expired.";
      left.className = "warn";
      if (!expired) said.textContent = "That code has expired. Send a new one.";
    }
    expired = remaining <= 0;
    button.disabled = wait > 0;
    button.textContent = wait > 0 ? `Send a new code in ${clock(wait)}`
                                  : "Send a new code";
  };

  const press = async () => {
    button.disabled = true;
    said.textContent = "";
    try {
      await resend();
      sentAt = Date.now();
      said.textContent = "A new code is on its way. Only the newest one works.";
    } catch (e) {
      said.textContent = (e as Error).message;
    }
    tick();
  };
  button.addEventListener("click", () => void press());

  tick();
  // Stops itself once the screen it belongs to is gone.
  const timer = setInterval(() => {
    if (!box.isConnected) { clearInterval(timer); return; }
    tick();
  }, 1000);
  return box;
}
