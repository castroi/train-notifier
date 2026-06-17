# train-notifier

A self-hosted Node 22 + TypeScript service that runs on a Raspberry Pi 3 and pushes Israel Railways departure times to the owner over Signal on a cron schedule, and answers on-demand route queries via Signal message. It talks HTTPS outbound to the rail API and HTTP over a private Docker bridge to a local `signal-cli-rest-api` container; it exposes no inbound ports and persists no state beyond a static `config.yaml`.

```
npm install       # install dependencies
npm run build     # compile TypeScript → dist/
npm test          # run tests with node --test
npm start         # run compiled app (node dist/app.js)
npm run typecheck # type-check without emitting files
```
