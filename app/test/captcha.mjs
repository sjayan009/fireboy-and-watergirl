/**
 * Getting the browser tests past Turnstile without switching it off.
 *
 * Production asks for a Turnstile token on sign-up, password sign-in, resend
 * and reset, and a test browser cannot earn a real one. So, for every page in
 * a context handed to `passCaptcha`:
 *
 * - Cloudflare's script is replaced by a stand-in that renders nothing and
 *   hands out a token at once, and a fresh one after each reset -- the same
 *   contract as the real widget, without the network or a challenge that
 *   headless Chromium may not pass. The real widget is checked by hand.
 * - Each guarded request is checked for a token -- a form that forgot to send
 *   one is a bug this must catch -- and then sent on with the project's secret
 *   key, which Supabase lets past the check. No made-up token would satisfy
 *   production's real Turnstile secret.
 *
 * Sent from here, not from the page, with a non-browser User-Agent and no
 * Origin: Supabase refuses a secret key that arrives looking like a browser.
 */
const GUARDED = /\/auth\/v1\/(signup|recover|resend|otp|passkeys\/authentication\/options|token\?grant_type=password)/;

const STAND_IN = `(() => {
  let n = 0;
  const widgets = {};
  const issue = (id) => setTimeout(() => widgets[id]?.callback("fbwg-test-" + id + "-" + Date.now()));
  window.turnstile = {
    render(node, options) { const id = "w" + ++n; widgets[id] = options; issue(id); return id; },
    reset(id) { issue(id); },
    remove(id) { delete widgets[id]; },
  };
})();`;

/**
 * Set up `context` as above. `missing` is called with the path of any guarded
 * request that arrived without a token.
 *
 * Also takes WebAuthn away unless `passkeys` is set. With it, every password
 * sign-in on a project with Passkeys on stops at the "save a passkey" offer,
 * and suites about friends or play would each have to step around it; the
 * app hides every passkey control in a browser without WebAuthn, so here
 * they simply never appear. `passkeys.mjs` is the suite that wants them.
 */
export async function passCaptcha(context, api, secret, missing, { passkeys = false } = {}) {
  if (!passkeys) {
    await context.addInitScript(() => {
      Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
    });
  }
  await context.route("https://challenges.cloudflare.com/turnstile/**",
    (route) => route.fulfill({ contentType: "text/javascript", body: STAND_IN }));
  await context.route((url) => url.href.startsWith(api) && GUARDED.test(url.href),
    async (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.continue();
      let body = {};
      try { body = JSON.parse(request.postData() ?? "{}"); } catch { /* not JSON */ }
      if (!body.gotrue_meta_security?.captcha_token) missing(new URL(request.url()).pathname);
      const headers = { ...request.headers(), apikey: secret,
                        authorization: `Bearer ${secret}`, "user-agent": "fbwg-tests" };
      delete headers.origin;
      delete headers.referer;
      const response = await route.fetch({ headers });
      // supabase-js reads error codes only when it can see the API version
      // header, so it has to stay visible to the page, as Supabase's own CORS
      // keeps it; without it every refusal arrives with no code.
      await route.fulfill({ response, headers: { ...response.headers(),
                                                 "access-control-allow-origin": "*",
                                                 "access-control-expose-headers": "x-supabase-api-version" } });
    });
}
