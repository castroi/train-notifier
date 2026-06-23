# Plan: Position-based "next train" filtering (fix delayed-train drop)

Date: 2026-06-23
Issue: a delayed train disappears from results once *now* passes its **scheduled**
departure, even though it hasn't left the queried station yet.

## Root cause

`extractTrains` (src/rail/format.ts) decides catchability from
`scheduledDeparture + delayMin`, where `delayMin` comes from
`trains[0].trainPosition.calcDiffMinutes`. `trainPosition` is **null until the
train is physically moving**, so for a train delayed at/approaching the queried
station `delayMin` is 0, the "delay-adjusted" cutoff collapses to the scheduled
time, and the train is dropped at its scheduled departure.

## Decision (confirmed with the user)

- **Primary signal:** the train's live position vs. the queried station's place
  in the route. A train is catchable iff it has **not yet passed** the boarding
  station.
- **Fallback:** when position data is unusable, keep the **existing
  scheduled-time logic verbatim** (raw, delay-adjusted, no buffer). This is the
  known-quantity backup; if it proves insufficient we switch the fallback to a
  small grace buffer later. The existing test suite is the regression guarantee
  for this path.

## Verified API facts (live probes, 2026-06-23)

- `trains[0].orignStation` = the **queried boarding station** id (no need to
  thread `fromId` into `extractTrains`; signature unchanged → 3 callers
  unaffected).
- `trains[0].routeStations` = the train's **full physical route**, origin →
  terminus, containing stations both upstream and downstream of the boarding
  station.
- `trainPosition.currentLastStation` = the last station the train passed; it
  appears in `routeStations`. For a through-train it is populated **before** the
  train reaches the boarding station (e.g. boarding 2100 at 23:23 while the train
  is still up at 1500).
- The API already rolls the response forward over no-service days (Shabbat,
  multi-day chag) and across the day boundary, so multi-day/holiday "next train"
  cases need no special handling here. Filter on full timestamps, never `HH:MM`.

## Catchability rule (per travel)

```
board    = trains[0].orignStation
route    = trains[0].routeStations.map(s => s.stationId)
boardIx  = route.indexOf(board)
pos      = trains[0].trainPosition

usable = pos != null
      && boardIx >= 0
      && route.indexOf(pos.currentLastStation) >= 0

if usable:
    keep = route.indexOf(pos.currentLastStation) <= boardIx   // not yet past board
else:
    keep = <existing scheduled-time logic, verbatim>
```

- `curIx <  boardIx` → train upstream, approaching → keep (the bug fix).
- `curIx == boardIx` → train sitting at the platform, however delayed → keep.
- `curIx >  boardIx` → already rolled through → drop (no grace).

Summary fields (`delayMin`, `platform`, `dayNote`) are computed exactly as today;
the rule only changes the keep/drop decision.

## Tasks

1. **Types** — add `RouteStation` + typed `TrainPosition`
   (`currentLastStation`, `nextStation`, `calcDiffMinutes`) to src/rail/types.ts;
   add `routeStations` to `Train`.
2. **Tests (red)** — src/rail/format.test.ts, scenarios A–F:
   - A: through-train upstream, scheduled time passed → kept.
   - B: train past board, final arrival future → dropped.
   - C: train at board station → kept.
   - D: null position + routeStations present → fallback (old behavior).
   - E: `currentLastStation` not in `routeStations` → fallback.
   - F: `orignStation` not in `routeStations` → fallback.
3. **Implement** — position-primary decision with verbatim scheduled fallback in
   `extractTrains`.
4. **Verify** — `npm test`, `npm run typecheck`, `npm run lint`; existing tests
   must stay green (fallback path), new tests green.

## Out of scope (deferred)

- Grace buffer on the fallback (switch only if the raw fallback proves wrong).
- `< N results` next-day re-query net (API rollover covers the common case).
- Instrumentation counter for fallback rate.
