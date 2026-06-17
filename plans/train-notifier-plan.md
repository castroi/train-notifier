# Train Schedule → Signal Notifier — High-Level Plan

Status: v9 (phone-number privacy: owner identified by UUID). Nothing is built yet. Items are numbered for reference. Changes new/revised in v9 are marked _[v9]_; earlier-round tags are kept where still the latest touch.

---

## 1. Goal & scope

A self-hosted service on a Raspberry Pi 3 (armv7) that:

1.1 Pushes train departures to me over Signal on a schedule (cron).
1.2 Answers on-demand: I text the bot and get the next 2–3 trains for a route.
1.3 Supports many predefined routes and many cron jobs.
1.4 Reuses the Israel Railways request/response logic and station id↔name map from `better-rail/server`, and nothing else from that project (no Redis, Mongo, APN, Firebase).

---

## 2. Decisions locked

2.1 Runtime: Node 22 LTS + TypeScript. Node 22 is confirmed published for `arm32v7`; Node 20 (same arch) is the drop-in fallback if armv7 pain appears.
2.2 Interaction: both scheduled push and on-demand.
2.3 Notification content: next-train info plus real-time status (delay / platform / cancellation).
2.4 Delay/disruption: reported as part of the scheduled snapshot — no separate continuous watcher.
2.5 State: static config file only, no database.
2.6 On-demand UX: numbered menu, fixed stateless numbering, eager-on-greeting. Menu labels are bilingual (EN + HE); message body is EN only (see 13.4).
2.7 No LLM and no MCP (see section 12).
2.8 One shared signal-cli-rest-api container; the bot gets its own dedicated number (number B).
2.9 Routing by destination number — no dispatcher, no per-message codes (see section 4).

---

## 3. Architecture / topology

One Pi, two containers on a private user-defined bridge network (a normal bridge with no host ports published — not `internal: true`, which would block needed egress; see 15.1); no published-to-LAN ports:

3.1 `signal-cli-rest-api` (existing bbernhard container):
- `MODE=json-rpc` (recommended for speed; matters on a Pi 3).
- Holds number A (existing workflow) and number B (this bot) in the same instance.
- Keys live in its config volume.

3.2 `train-notifier` (new, lightweight Node container — not a second Java container, so within the Pi's limits):
- Long-running process (must stay up to listen for on-demand messages).
- In-process scheduler (`node-cron`) + a receive loop.
- Talks to the Signal API over the private bridge; talks to the rail API outbound.
- No inbound ports.

3.3 Health checks (no inbound port — uses a Docker `HEALTHCHECK` exec command):
- Liveness: the loop touches a heartbeat file on a writable `tmpfs` mount (see 10.2) each cycle; healthcheck fails if it is stale.
- Readiness: ping Signal `/v1/health` plus a throttled/cached probe of the rail API.
- Clock-drift guard: compare local clock to an upstream HTTP `Date` header; skew beyond ~60s → degraded (see 11.3).

---

## 4. Routing model (no dispatcher)

4.1 `/v1/receive/{number}` is per-number, so the destination number is the routing key.
4.2 The bot polls receive on number B only and sends as B only.
4.3 The existing workflow stays on number A, untouched.
4.4 Hard rule: exactly one poller per number → no receive collisions.
4.5 No dispatcher and no user-typed codes needed: the number the user texts decides the handler.

---

## 5. On-demand behavior

5.1 _[v4]_ Recognized inputs, in order:
- A message starting with an integer (`^\s*\d+`) in range `1..N` (N = configured route count), trailing text ignored → run that route.
- A message whose normalized full text exactly matches a configured alias (EN or HE) → run that route. Normalization: trim, collapse whitespace, lowercase (Latin), and Hebrew normalization (strip niqqud, unify final-letter forms). Exact match only — no fuzzy (deterministic, no typo-misfires, no extra dependency).
- Anything else (incl. `0`, out-of-range, or unmatched text) → reply with the time-aware menu.
5.2 _[v4]_ Eager-on-greeting: in a time window with a clear preferred route the greeting reply includes that route's next trains plus the numbered menu; in a window with no clear default it shows the menu only. Test-default windows (placeholder until real hours given): 05:00–11:00 → work, 15:00–20:00 → home, otherwise menu.
5.3 _[v5]_ Fixed stateless numbering: route 1 is always the same route. Replying `2` cold works and is the fastest path. No session memory. Trains shown = the route's `count` override, else `defaults.on_demand_count` (7.3 / 7.4a).
5.4 Menu labels rendered in EN + HE; the selection itself is a language-neutral number.
5.5 _[v9]_ Sender allowlist: only the owner is answered, matched on the sender's Signal UUID (ACI) — with phone-number discoverability off, the inbound envelope's number may be empty, so the UUID is the reliable identifier. Unknown senders handled silently (no reply). Unknown-sender logs are rate-limited and never include the message body.
5.6 _[v9]_ Incoming dedup: cache keyed on the most specific unique id the receive payload exposes — `(sender UUID + sourceDevice + Signal message timestamp [+ envelope GUID if present])`, NOT a body hash. The sender id is the UUID (ACI), since the number may be absent when discoverability is off. Adding device/GUID avoids rare collisions across linked devices. Exact available fields are a build-time check against bbernhard's payload. TTL ~10 min, LRU-capped, in-memory.

---

## 6. Scheduled behavior

6.1 _[v6]_ `node-cron` in-process; many jobs. Overlap guard: per-job boolean lock — if the previous run hasn't finished when the next tick fires, skip it (don't queue). The lock is released in a `finally` block so a thrown error can never permanently stick a job.
6.2 Each job maps a cron expression → a route + a train count.
6.2a _[v6]_ Work-week: the cron day-of-week field uses `0-4` (Sun–Thu) for the Israeli work week, which excludes Friday (`5`) and Saturday (`6`) — no weekend messages. (Cron DoW: `0`/`7`=Sun … `6`=Sat; `1-5` would be the Western Mon–Fri and is wrong here.) Correct local days depend on `TZ=Asia/Jerusalem` (6.3).
6.3 `TZ=Asia/Jerusalem`.
6.4 Each push is a snapshot: next N trains with real-time status. No-trains template per 14.2.
6.5 DST (Asia/Jerusalem): spring-forward skips a job in the skipped hour; fall-back can double-fire in the repeated hour. Mitigations: (a) per-run guard keyed on `schedule_id + localDate + localTime`; (b) commute jobs sit outside 01:00–03:00, so exposure is near zero.

---

## 6A. Failure & retry policy

6A.1 Rail fetch: timeout 10s; 2 retries, exponential backoff + jitter.
6A.2 Signal send: timeout 15s; 2 retries + jitter.
6A.3 _[v7]_ Final failure: on-demand → reply with outage template (14.3); scheduled → log only. Precedence: if the failure is the Signal send itself being down, the outage reply cannot be delivered either, so it degrades to 6A.4 (log + drop) — 6A.4 wins over 6A.3 whenever Signal is the broken link.
6A.4 Signal send failing after retries: log and drop.
6A.5 Ops visibility: in-memory per-route counters (success/fail/timeout) flushed to the log as one aggregated line per hour. No PII.
6A.6 _[v6]_ On-demand end-to-end deadline: ~25s cap over the whole request (it bounds the retry budget in 6A.1, so retries never run past it). On breach, fail fast to the outage template (14.3) rather than leaving the user waiting. Scheduled jobs are also capped (looser) so a slow run can't hold the per-job lock indefinitely.

---

## 7. Config schema (static file, read-only mount, no DB)

7.1 _[v9]_ `allowlist`: the owner identity/identities permitted to use on-demand — each an E.164 number OR a Signal UUID. Matched against the sender UUID per 5.5.
7.1a _[v9]_ `signal.ownerNumber`: the owner identity used as the scheduled-push recipient (passed to signal-cli's `recipients`). Accepts a phone number OR a UUID. With Signal "Who can find me by number?" set to Nobody, the bot can't resolve a phone number to an account — put the UUID here instead (see 11.4). Build-time check: confirm your signal-cli-rest-api version accepts a UUID in `recipients`.
7.2 `bot_number`: number B.
7.3 _[v5]_ `routes[]`: stable `key`/number, `from_id`, `to_id`, `label_en`, `label_he`, `aliases[]` (EN + HE, matched after normalization per 5.1), and optional `count` (on-demand trains to show for this route; overrides the global default).
7.4 `schedules[]`: required unique `id`, `cron`, `route_key`, train `count` (this is the scheduled-push count, independent of the on-demand count).
7.4a _[v5]_ `defaults.on_demand_count`: global number of trains shown for an on-demand request when a route has no `count` override (e.g. 3).
7.5 _[v7]_ `time_windows[]`: time-of-day ranges → suggested `route_key` (a window may have no default). Evaluated top-to-bottom, first match wins; any time not covered by a window → menu only. Cross-midnight windows are unsupported (we dropped wrap), so `end` must be > `start`. Any overlap between windows is rejected at startup (even same-route overlaps, which are merely redundant) — simpler to reason about. Seeded with the 5.2 test default until real hours are set.
7.6 Rail API settings (`RAIL_URL`, `RAIL_API_KEY`, `PROXY_URL`), the Signal API base URL, and the log-hash salt via environment/secrets — not in the committed config.
7.7 _[v9]_ Startup validation — fail fast on: duplicate route keys; duplicate/missing schedule `id`s; invalid cron; station ids not in the better-rail map; schedules referencing a missing route key; owner identifiers (allowlist / `signal.ownerNumber`) that are neither valid E.164 nor a valid UUID; missing bot number; time-window with `end ≤ start` (cross-midnight, unsupported); and any overlapping time-windows (regardless of route).

Adding routes or cron jobs = editing this file only.

---

## 8. Reuse from better-rail/server

8.1 Rail request builders.
8.2 Rail response types/interfaces.
8.3 Station id ↔ name map (most valuable reusable asset — the rail API uses numeric ids).
8.4 Station ids are pinned per route in config, avoiding the "Tel Aviv has several stations" ambiguity at query time.

---

## 9. Security (OWASP) & privacy

9.1 A01: sender allowlist; Signal API not published to LAN. The bbernhard API has no built-in auth, so network reach = full access; co-located trusted containers are one trust boundary.
9.2 A03: HTTP to Signal, never shell/CLI strings → no command injection. On-demand input validates to a bounded integer or an exact known alias.
9.3 A05: non-root, read-only rootfs (+ tmpfs per 10.2), `no-new-privileges`, dropped caps; secrets via env/mounted file, not baked in.
9.4 A06: Node 22 LTS, near-zero deps (built-in `fetch`; only `node-cron`), pinned lockfile, image pinned by digest, `npm audit` / Dependabot.
9.5 A10: rail URL only from config, never from a user message.
9.6 _[v6]_ Privacy/logging: stays local on the Pi; no raw numbers or message bodies in logs — sender stored as a truncated salted HMAC. Salt policy: a stable long-lived salt (stored as a secret), chosen deliberately so a recurring sender hashes the same over time and trend debugging works; rotating the salt is the documented alternative if unlinkability is preferred over correlation. Signal key volume locked down and excluded from plaintext backups.
9.7 _[v9]_ Phone-number privacy: the owner can set Signal "Who can find me by number?" to Nobody so the number isn't discoverable. The bot then identifies the owner by UUID (ACI) for both receive-matching (5.5) and sends (7.1a), never relying on number→account resolution. Setup in 11.4.

---

## 10. Build / runtime (armv7)

10.1 Multi-stage build → runtime `node:22-slim` (or alpine), confirmed for `arm32v7`. Build/test on the Pi (emulation hides armv7 bugs). Fallback Node 20.
10.2 Non-root UID, read-only root filesystem, plus a small writable `tmpfs` (e.g. `/run`, in-RAM) for the heartbeat and any scratch. No writes touch the rootfs.
10.3 Distroless not used — not published for `linux/arm/v7`.
10.4 Signal API in `json-rpc` mode (`normal` mode spins Java per command, slow on a Pi 3).
10.5 Resource guardrails (train-notifier): `mem_limit ≈ 192m`, `reservation ≈ 64m`, `restart: unless-stopped`, `json-file` logging `max-size=10m` / `max-file=3`.

---

## 11. External prerequisites (yours to confirm)

11.1 Register bot number B on a real, Signal-accepted number (Signal often rejects VoIP; a spare SIM is reliable).
11.2 Confirm the Pi can reach the Israel Railways API (key/endpoint/proxy). Unreachable behavior → 6A.3 + 14.3.
11.3 Reliable host NTP sync — cron + departure correctness depend on it, and containers inherit the host clock. Large drift = degraded readiness (3.3).
11.4 _[v9]_ Obtaining the owner UUID (one-time, when discoverability is Nobody): (1) from your phone, send any Signal message to the bot's number; (2) query the signal-cli-rest-api identities endpoint for the bot number and read the entry whose `number` is empty — that entry's `uuid` is yours; (3) put that UUID in `signal.ownerNumber` and restart the container. The identities call is a host-side request to wherever the Signal API is bound (e.g. `http://localhost:8088/v1/identities/<BOT_NUMBER>`, BOT_NUMBER in E.164), consistent with the localhost-only bind in 15.2.

---

## 12. Explicitly rejected (with rationale)

12.1 Local tiny LLM: a Pi 3 can't host one usefully; enlarges attack/prompt-injection surface; input is a closed menu.
12.2 MCP routing: essentially one tool; nothing to route.
12.3 Second dedicated Signal container: the Pi can't run two Java/Signal containers.
12.4 Dispatcher: destination number already routes deterministically; content routing would reintroduce ambiguity.

---

## 13. Open items — resolved

13.1 _[v4]_ Matching: Numbers + exact word aliases (no fuzzy). See 5.1.
13.2 Message formatting: see section 14.
13.3 _[v4]_ Time windows: custom; test default `05–11 → work, 15–20 → home, else menu` until real hours supplied. See 5.2 / 7.5.
13.4 _[v4]_ Body language: EN only. Menu labels stay bilingual (EN + HE) for route recognition; all train-info and system text is EN.
13.5 _[v4]_ Deployment/hardening: see section 15.

---

## 14. Message & reply templates (contract) — EN

14.1 _[v7]_ Train line: `HH:MM → HH:MM · <status> · plat N`.
- `<status>` (time-state, single token) precedence: `CANCELLED` > `+M min` > `on time`.
- Platform is decoupled from the status token: the `· plat N` segment shows the platform, and a change is flagged inline as `· plat N (changed)`. So a delayed, re-platformed train shows both, e.g. `08:12 → 09:30 · +6 min · plat 5 (changed)`.
- `CANCELLED` dominates: when cancelled, show only the status token and omit the platform segment.
- Graceful degradation: omit `· plat N` if platform missing; omit status if unknown; never break below `HH:MM → HH:MM`.
14.2 No-trains: "No upcoming departures for <route label> in the next <window>."
14.3 Rail outage (on-demand only; scheduled logs silently): "Train data is unavailable right now — please try again shortly."
14.4 Dependency: exact real-time fields (delay minutes, platform, cancelled flag) must be confirmed against the actual rail response once API access exists.
14.5 _[v5]_ // IMPLEMENTATION NOTE (status derivation, to resolve at build): derive `<status>` from the rail response's delay field — empty / null / 0 → `on time`; a positive value → `+M min`. Exact field name and shape are TBD against the real response (see 14.4); treat a missing/unparseable field as "status unknown" and omit the segment per 14.1.

---

## 15. Deployment & hardening spec (13.5) _[v4]_

Documented as settings to apply; the actual `docker-compose.yml` will be generated at build time.

15.1 Network: a user-defined bridge shared by train-notifier and signal-cli-rest-api. Do NOT use `internal: true` (it would block the egress both containers need to the rail/Signal servers). "Not exposed to LAN" is achieved by publishing no host ports for the bot, not by an internal network.
15.2 Signal API exposure: prefer reaching it only over the docker network (service name, no host port). If the existing workflow runs on the host and needs the port, bind it to `127.0.0.1:8080` only — never `0.0.0.0`.
15.3 train-notifier service hardening flags:
- `read_only: true` + `tmpfs: /run` (small, e.g. size-capped).
- `user: "<uid>:<gid>"` (non-root).
- `cap_drop: [ALL]` (no caps added — it's a plain network client).
- `security_opt: ["no-new-privileges:true"]`.
- `restart: unless-stopped`.
- `init: true` (proper PID 1 / signal handling for the long-running process).
- `mem_limit: 192m`, `mem_reservation: 64m`.
- `logging: json-file` with `max-size=10m`, `max-file=3`.
- `networks: [the shared bridge]`, and no `ports:`.
- Config mounted read-only: `./config.yaml:/app/config.yaml:ro`.
- Secrets via `env_file` / environment (`RAIL_API_KEY`, `PROXY_URL`, log-hash salt), not baked into the image.
- Image pinned by digest; `HEALTHCHECK` exec checking heartbeat freshness, tuned for Pi 3 cold starts: `start_period: 60s`, `interval: 30s`, `timeout: 10s`, `retries: 3` (so a slow-but-healthy boot isn't restarted).
15.4 signal-cli-rest-api (existing, yours): recommended but optional — same bridge, log rotation, `restart: unless-stopped`, localhost-only port bind if host access is needed. Limits left to you (it's the memory-heavy one).

---

## 16. Flow simulations (use-case traces) _[v8]_

Grounding config for all traces below:

```
routes:
  1 work   Afula → TLV    aliases: work, to work, עבודה   count: 3
  2 home   TLV → Afula    aliases: home, בית
  3 haifa  Haifa → TLV    aliases: haifa, חיפה
defaults.on_demand_count: 3
allowlist: +9725XXXXXXX (me)
time_windows: 05:00–11:00 → work, 15:00–20:00 → home, else menu
schedules:
  - { id: s1, cron: "0 7 * * 0-4",  route_key: work, count: 3 }   # Sun–Thu 07:00
  - { id: s2, cron: "30 16 * * 0-4", route_key: home, count: 2 }  # Sun–Thu 16:30
```

Body is EN; route labels bilingual. Train line per 14.1: `HH:MM → HH:MM · <status> · plat N`, status `CANCELLED > +M min > on time`, platform change shown as `plat N (changed)`.

### 16.1 On-demand pipeline

`allowlist check → dedup check (5.6) → parse (leading integer? exact alias? else) → fetch+format (count) or menu → send (retry per 6A, ~25s deadline)`

**A. Greeting, morning 08:10**
```
me → hi
bot → Good morning. Your usual — Afula → TLV / עפולה → ת״א:
       • 08:12 → 09:30 · on time · plat 2
       • 08:42 → 10:00 · +5 min
       • 09:12 → 10:30 · on time · plat 2
      Other routes:
       2. TLV → Afula / ת״א → עפולה
       3. Haifa → TLV / חיפה → ת״א
```
Not an integer/alias → greeting; window 05–11 → work → eager (count 3).

**B. Cold number, no greeting**
```
me → 2
bot → TLV → Afula / ת״א → עפולה — next 3:
       • 09:05 → 10:28 · on time
       • 09:35 → 10:58 · on time
       • 10:05 → 11:28 · +4 min · plat 5 (changed)
```
Leading integer in range → route 2 (count falls back to default 3).

**C. Word alias** — `me → home` → exact alias → route 2 (same as B).

**D. Hebrew alias** — `me → בית` → normalized HE alias → route 2 (EN body).

**E. Greeting, midday 12:30**
```
me → hello
bot → Pick a route:
       1. Afula → TLV / עפולה → ת״א
       2. TLV → Afula / ת״א → עפולה
       3. Haifa → TLV / חיפה → ת״א
```
No window matches 12:30 → menu only, no eager trains.

**F. Out-of-range number** — `me → 9` → integer not in `1..3` → menu (E). No error text.

**G. Free text with a number** — `me → there in 5 min` → no leading integer, no exact alias → menu. (The `5` never fires route 5.)

**H. Number with trailing text** — `me → 2 trains pls` → leading `2` → route 2; trailing ignored.

**I. Unknown sender**
```
+1202UNKNOWN → 1
(no reply — silent; one rate-limited log line; body not logged)
```

**J. Duplicate redelivery (reconnect)**
```
me → 2   (envelope/timestamp X)
me → 2   (same envelope/timestamp X, redelivered)
→ first processed; second hits dedup cache → dropped. One reply only.
```
A genuine re-send of `2` has a different timestamp → both answered.

**K. Rail API down, on-demand**
```
me → 1
→ rail fetch times out, retries fail within ~25s deadline →
bot → Train data is unavailable right now — please try again shortly.
```
If Signal itself is down, the outage reply can't be sent → log + drop (6A.3/6A.4).

### 16.2 Automatic (cron) pipeline

`cron tick → acquire per-job lock (skip if running; release in finally) → DST run-guard (schedule_id+localDate+localTime) → fetch rail (retry) → format count trains → send to me → on final failure log silently`

**A. Sun–Thu 07:00 — s1 (work, 3 trains, one delayed)**
```
bot → Afula → TLV / עפולה → ת״א — next 3:
       • 07:12 → 08:30 · on time · plat 2
       • 07:42 → 09:01 · +6 min
       • 08:12 → 09:30 · on time · plat 2
```
Unprompted — the schedule pushed it.

**B. Sun–Thu 16:30 — s2 (home, 2 trains, one cancelled)**
```
bot → TLV → Afula / ת״א → עפולה — next 2:
       • 16:45 → 18:08 · on time
       • 17:15 → 18:38 · CANCELLED
```
Cancelled line omits the platform segment per 14.1.

**C. Overlap — previous s1 run still running at next tick**
```
(no message) → lock held → tick skipped, one log line.
```

**D. DST fall-back, job in the repeated hour**
```
first fire → sends; second fire → same run-guard key → skipped.
```
Not a concern for s1/s2 (07:00 / 16:30, outside 01:00–03:00).

**E. Rail API down at 07:00**
```
(no message) → retries fail → scheduled path logs silently; hourly counter records the failure (6A.5).
```
Differs from on-demand K: scheduled stays silent.

**F. Friday/Saturday** — `0-4` excludes Fri (`5`) and Sat (`6`) → s1/s2 never fire on the weekend.

**G. No departures in the lookahead window**
```
bot → No upcoming departures for Afula → TLV in the next window.
```
