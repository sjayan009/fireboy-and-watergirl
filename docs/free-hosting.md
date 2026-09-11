# Free hosting decision — 4 September 2026

The release must not create paid resources. No provider has been upgraded and
the paid Render blueprint was removed. The Docker verifier can run on an
existing free Linux VM with `docker compose -f worker/compose.yaml up -d --build`.
This command requires a provisioned machine and the scoped database credential;
it does not create either one. The worker exposes no inbound ports.

| Component | Free option | Relevant limit / qualification |
| --- | --- | --- |
| Static app and assets | Cloudflare Pages Free | 500 builds/month, 20,000 files/site, 25 MiB/file. Confirm the built asset inventory before publishing. |
| Accounts, progress, verification queue | Existing Supabase Free project `hkuhkzcnwircqcmxurxi` | 200 Realtime connections, 100 events/sec, 20 presence messages/sec, 2 million Realtime messages/month. Keep it Free. |
| Replay verifier | Oracle Always Free A1 Linux VM | Current documentation lists 2 OCPUs and 12 GB total. Provision only resources labeled Always Free in the home region. Capacity can be unavailable and idle VMs can be reclaimed. Container compatibility and actual queue latency still need validation on the chosen VM. |
| Alternative relay | Cloudflare Durable Objects Free | 100,000 request units/day, 13,000 GB-s/day. Incoming WebSocket messages use a 20:1 request ratio; outgoing messages are not charged. Requires a new authenticated relay integration and hibernation. This is a candidate, not an implemented replacement. |

Sources: [Pages limits](https://developers.cloudflare.com/pages/platform/limits/),
[Supabase Realtime limits](https://supabase.com/docs/guides/realtime/limits),
[Supabase pricing](https://supabase.com/docs/guides/realtime/pricing),
[Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Capacity is an acceptance gate

With 100 players, one batched relay message per player every 230 ms is about
435 sends/second. Counting one recipient per send gives about 870 Supabase
events/second before presence, control traffic, or spectators. One hour would
use about 3.13 million events. This estimate alone exceeds both the existing
Free rate and monthly allowance. Actual transport sends must be measured;
the release cannot claim the 100-player all-relay target on Supabase Free.

230 ms is the interval a pair starts on, not the only one they can be on. A
pair whose measured input age eats more than 60% of its rollback window is
moved to 115 ms until it drops back under 40% -- because that wait is spent
before a packet has left the browser, and two people far enough apart are
stalled by the arithmetic rather than by their connection. Such a pair sends
about twice as much, so the figure above is a floor: the worst case is an
all-relay population that is also all struggling, at roughly 870 sends/second.
Measure the real mix before sizing anything on either number.

Two things changed how often that is reached. The rollback window went from 14
frames to 30 -- 538 ms to 1154 ms -- because the input redundancy it is capped
by went from 16 frames to 32, which costs sixteen bytes a packet and about six
tenths of a millisecond of re-simulation in the worst case measured. And a pair
that still does not fit buys frames of window with **input delay** before it
buys them with messages, because a frame of delay costs 38.5 ms of feel and no
quota at all. The 115 ms interval is now the last lever rather than the first,
which should make an all-relay population cheaper than the floor above rather
than dearer.

The same workload on Durable Objects would use about 78,261 incoming request
units/hour before connection setup, signalling and spectators. That leaves
less than the required 25% daily headroom. Moving the relay alone is therefore
insufficient to certify the planned test. A separately measured batching change
or a relay on the free VM is needed. Hibernation must be used for a Durable
Objects implementation; permanently active per-match objects can also exceed
the duration allowance. These are estimates, not results of a load test.

Free resources can support a bounded launch. They do not provide an unlimited
100-player service or a production availability guarantee. Do not spread the
same workload across duplicate free accounts to bypass quotas. Keep admission
and error states honest when the provider has no capacity.

## Options excluded from a strict $0 default

Render offers no free background worker. Its free web services sleep after
15 minutes without inbound traffic and are not a substitute for this private,
continuously polling verifier. [Render free services](https://render.com/docs/free)

Cloud Run includes request-based monthly allowances of 180,000 vCPU-seconds,
360,000 GiB-seconds and 2 million requests, but usage beyond allowances is billed.
An always-running two-slot worker would need an event-driven redesign. Its
free allowance is useful, but is not a hard zero-cost guarantee.
[Cloud Run pricing](https://cloud.google.com/run/pricing)

## External prerequisites

A free compute account/VM has not been supplied or provisioned. The Supabase
project alone cannot host the isolated Node worker. Oracle signup, account
verification, and accepting its terms require the account owner. No credential
belongs in source control or in a browser build. A private, limited verifier
login must be created by an administrator after the additive migration passes
review, then supplied only to the worker.

Production remains gated on the real browser-pair flow, deployed database and
worker checks, and a measured one-hour capacity run with 25% headroom. The
reproducible local checks do not stand in for these external gates.
