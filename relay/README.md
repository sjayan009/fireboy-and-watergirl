# Binary Durable Object relay evaluation

Decision, 2026-09-11: **not enabled or deployed**. The default remains direct
unordered, unreliable WebRTC and the existing private Supabase relay. There is
no new production endpoint, service key, TURN service, or billable account.

The 65-byte input packet can be forwarded unchanged in one binary WebSocket
frame. This would remove Supabase's scoped base64/JSON framing and its 230ms
batch wait. TCP/WebSocket still has head-of-line blocking; a binary relay is
not equivalent to unreliable SCTP. A steady pair generates 52 incoming WS
messages/s. At 20:1 metering that is 9,360 request units per pair-hour. The
100,000/day allowance supports **10.68 pair-hours/day before all setup, probes,
auth, control and abuse**; a 75,000-unit gameplay allocation supports 8.01.
See [the deployment guide](../docs/HIGH_LEVEL/DEPLOYMENT.md) for the complete model.

The published Free plan is SQLite-only, fails at quota exhaustion, and includes
13,000 GB-s/day. The relay must use `ctx.acceptWebSocket` and hibernatable event
handlers, preserve any connection metadata through attachments, and avoid
timers/outbound connections that prevent hibernation. Do not assume hibernation
makes continuous gameplay free. At 0.128GB per object, fully active pair-hours
consume 460.8 GB-s each; actual handler duration needs production measurement.
[Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
were checked on 2026-09-11.

## Requirements before enabling an experiment

1. Remain on Workers **Free**, use SQLite class migrations, and forbid paid
   services/upgrades. Free's hard failure is the billing boundary; a browser
   counter or alert is not an account-wide spending cap.
2. Authorize each socket using the existing Supabase user identity and accepted
   friendship. Issue short-lived, attempt-bound, slot-bound capabilities with
   a trusted verifier; never put a service-role key in the client or authorize
   a public room merely because its ID is hard to guess. Preserve current RLS.
3. Maintain a durable **global admission reservation** for all relay rooms and
   probes in this deployment, including simultaneous requests and midnight UTC
   rollover. Reserve worst-case message/duration consumption before admitting
   a short lease; cap per-socket rate/size and lease length. Include every HTTP,
   RPC, alarm, SQL read/write and setup request in the model. Shared-account
   unrelated Workers usage remains an external account constraint.
4. Offer a renewal failure/lease expiry to both peers over their private pair
   channel *before* the reserved budget ends. Agree a new attempt and retry
   direct P2P, or use Supabase only if that independent quota has headroom.
   If both managed free services refuse admission, display availability limits
   and retain local play. Quota exhaustion cannot justify adding a paid relay.
5. Benchmark the actual hosted relay for both players. A local fake cannot
   establish Internet latency, placement, NAT success, or hibernation duration.

## Joint region measurements

Survev uses bounded one-byte WebSocket echo probes in
[pingTest.ts](https://github.com/survev/survev/blob/master/client/src/pingTest.ts).
Its single-client minimum-RTT policy is unsuitable for this two-player game.
The evaluation helper [region-selection.mjs](region-selection.mjs) instead
minimizes the worse player's p95, then their sum of medians, with a fixed tie
order. It has seven automated assertions, including opposing nearest regions,
timeouts, missing regions, and deterministic ties. These fixtures are **not
measured global latencies**.

In an admitted experiment both players would probe the same candidate objects,
six echoes per region, share authenticated timing reports on the private,
attempt-scoped pair channel, and run this selector. Eight candidates require
16 initial WS upgrades plus 96 echoes (4.8 metered message units), excluding
control/authorization costs. Reserve their duration and request costs too.
Probe the object that will carry the selected relay, not a generic edge URL:
edge RTT does not reveal the object's route.

`enam`, `wnam`, `weur`, `eeur`, `apac`, `apac-ne`, `apac-se`, and `oc` are
best-effort hints. Supply `locationHint` on the **first** access; a later hint
does not relocate an existing object. Object naming must include the region
and authenticated room attempt so another initiator cannot accidentally fix
placement before the measurements.
[Cloudflare data location](https://developers.cloudflare.com/durable-objects/reference/data-location/).

Oracle Always Free compute/coturn can only be an optional operator-owned
experiment. Capacity, reclamation, home-region routing and maintenance make it
unsuitable as a required game dependency. It is neither configured nor needed.
