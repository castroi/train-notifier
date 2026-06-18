# train-notifier

A self-hosted service that pushes train departures to the owner over Signal on a schedule (cron), and answers on-demand route queries via Signal message. It talks HTTPS outbound to the rail API and HTTP over a private Docker bridge to a local `signal-cli-rest-api` container; it exposes no inbound ports and persists no state beyond a static `config.yaml`.

## Features

- Pushes train departures over Signal on a schedule (cron)
- Answers on-demand: text the bot, get the next 2–3 trains for a route
- Supports many predefined routes and many cron jobs

## Deployment

```bash
docker pull ghcr.io/castroi/train-notifier:latest
docker compose up -d
```

**Configuration** — copy `config.example.yaml` → `config.yaml`, then set the `.env` values documented in `docker-compose.yml`:

- `RAIL_URL` — Israel Railways API base URL
- `RAIL_API_KEY` — rail API credentials
- `SIGNAL_API_URL` — the signal-cli-rest-api URL, e.g. `http://signal-cli:8080`
- `SIGNAL_NETWORK` — the Docker network your signal-cli container is on (find it with `docker network ls`)
- `LOG_SALT` — a random string (≥16 chars) used to salt hashed senders in logs (see [Generate LOG_SALT](#generate-log_salt))

## Owner one-time setup (deploy)

1. Register/link **number B** in signal-cli-rest-api (register + captcha + verify, or QR link).
2. Set Signal "Who can find me by number?" → Nobody.
3. Text the bot from your phone; `GET /v1/identities/{botNumber}` → read the entry with empty `number` → that `uuid` is yours.
4. In `config.yaml`:
   - Set `signal.owner_uuid` to your UUID from step 3.
   - Set `signal.allowlist` to the list of UUIDs (or phone numbers, if your signal-cli-rest-api version supports it) that may use the bot. Add multiple UUIDs to allow friends/family. Example:
     ```yaml
     signal:
       owner_uuid: "00000000-0000-0000-0000-000000000000"
       allowlist:
         - "00000000-0000-0000-0000-000000000000"  # you
         - "11111111-1111-1111-1111-111111111111"  # friend
     ```
   - Verify `recipients` accepts a UUID on your image version (else use E.164). Restart the container.

## Generate LOG_SALT

`LOG_SALT` must be a random string of **at least 16 characters**. Generate one (the commands below produce 48 hex chars) with any of:

```bash
# with openssl
openssl rand -hex 24

# with Node.js
node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))'

# with /dev/urandom (fallback)
head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
```

Or use a helper that picks whichever tool is available:

```bash
gen_salt() {
  if command -v openssl &>/dev/null; then
    openssl rand -hex 24
  elif command -v node &>/dev/null; then
    node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))'
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}
LOG_SALT=$(gen_salt)
echo "LOG_SALT=$LOG_SALT"
```

Add the output to your `.env` file.

## Flow simulations (use-case traces)

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
  - { id: s1, cron: "0 7 * * 0-4",   route_key: work, count: 3 }  # Sun–Thu 07:00
  - { id: s2, cron: "30 16 * * 0-4", route_key: home, count: 2 }  # Sun–Thu 16:30
```

### On-demand pipeline

**A. Greeting, morning 08:10**
```
me  → hi
bot → Good morning. Your usual — Afula → TLV:
       • 08:12 → 09:30 · on time · plat 2
       • 08:42 → 10:00 · +5 min
       • 09:12 → 10:30 · on time · plat 2
```

**B. Cold number, no greeting**
```
me  → 2
bot → TLV → Afula:
       • 09:05 → 10:28 · on time
       • 09:35 → 10:58 · on time
       • 10:05 → 11:28 · +4 min · plat 5 (changed)
```

**C. Word alias** — exact alias match → route 2
```
me  → home
bot → TLV → Afula:
       • 09:05 → 10:28 · on time
       • 09:35 → 10:58 · on time
       • 10:05 → 11:28 · +4 min · plat 5 (changed)
```

**D. Hebrew alias** — normalized HE alias → route 2 (EN body)
```
me  → בית
bot → TLV → Afula:
       • 09:05 → 10:28 · on time
       • 09:35 → 10:58 · on time
       • 10:05 → 11:28 · +4 min · plat 5 (changed)
```

### Automatic (cron) pipeline

**Sun–Thu 07:00 — s1 (work, 3 trains, one delayed)**
```
bot → Afula → TLV:
       • 07:12 → 08:30 · on time · plat 2
       • 07:42 → 09:01 · +6 min
       • 08:12 → 09:30 · on time · plat 2
```

## Development

```
npm install       # install dependencies
npm run build     # compile TypeScript → dist/
npm test          # run tests with node --test
npm start         # run compiled app (node dist/app.js)
npm run typecheck # type-check without emitting files
```
