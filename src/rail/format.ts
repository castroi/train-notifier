import type { RailApiGetRoutesResult, Train } from './types.ts';

export interface TrainSummary {
  departHHMM: string;
  arriveHHMM: string;
  delayMin: number;
  platform: number;
  /** Day marker relative to "now": "" for today, "tomorrow", or e.g. "Thu 19/06". */
  dayNote: string;
  /** Absolute departure epoch (ms) — lets the wizard render the service-day header. */
  departEpoch: number;
}

function toJerusalemHHMM(timeStr: string): string {
  const date = new Date(timeStr);
  if (Number.isNaN(date.getTime())) {
    return timeStr.slice(0, 5);
  }
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** "YYYY-MM-DD" for an epoch, in Asia/Jerusalem. */
function jerusalemDateStr(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/**
 * Day marker for a departure relative to `nowMs`, in Asia/Jerusalem:
 * "" if same day, "tomorrow" if the next day, else a short "Wkd DD/MM".
 */
function dayNoteFor(departMs: number, nowMs: number): string {
  if (!Number.isFinite(departMs)) return '';
  const dep = jerusalemDateStr(departMs);
  if (dep === jerusalemDateStr(nowMs)) return '';
  if (dep === jerusalemDateStr(nowMs + 24 * 60 * 60 * 1000)) return 'tomorrow';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(departMs));
}

/** Trains whose (delay-adjusted) departure is older than this are treated as past. */
const PAST_GRACE_MS = 60_000;

/**
 * Summarise the next `count` upcoming trains.
 *
 * The rail API always returns the full day's (and next service day's) timetable,
 * so we filter to trains still catchable at the boarding station here.
 *
 * Primary signal: live position. `trains[0].routeStations` is the train's full
 * physical route and `trainPosition.currentLastStation` is where it currently is;
 * a train is catchable while it has not yet passed the boarding station
 * (`orignStation`). This keeps a delayed train that is still upstream of — or
 * sitting at — the boarding station, even after its scheduled time has passed.
 *
 * Fallback (no usable position, e.g. a train not yet moving): the original
 * delay-adjusted scheduled-time filter — a train is kept until its (delayed)
 * scheduled departure passes.
 *
 * Departure strings carry no timezone and are Israel-local; the process runs
 * `TZ=Asia/Jerusalem`, so `new Date(str)` yields the correct epoch to compare
 * against `nowMs`.
 */
export function extractTrains(
  result: RailApiGetRoutesResult,
  count: number,
  nowMs: number = Date.now(),
): TrainSummary[] {
  const travels = result.result.travels;
  const summaries: TrainSummary[] = [];

  for (const travel of travels) {
    if (summaries.length >= count) break;

    // trains[0] is the boarding leg of the journey, so its `orignStation` is the
    // queried station and its position/route describe the train the rider catches.
    const firstTrain: Train | undefined = travel.trains[0];
    if (!firstTrain) continue;

    const pos = firstTrain.trainPosition;
    const delayMin = pos?.calcDiffMinutes ?? 0;
    const departMs = new Date(travel.departureTime).getTime();

    // Locate the boarding station and the train's current position on the route.
    // Routes are acyclic, so first-occurrence `indexOf` uniquely orders the stops.
    const route = firstTrain.routeStations?.map((s) => s.stationId);
    const boardIx = route ? route.indexOf(firstTrain.orignStation) : -1;
    const curIx =
      route && pos?.currentLastStation !== undefined ? route.indexOf(pos.currentLastStation) : -1;

    if (boardIx >= 0 && curIx >= 0) {
      // Position is usable: drop the train only once it has rolled past the
      // boarding station (curIx > boardIx). Upstream or at-platform → keep.
      if (curIx > boardIx) continue;
    } else if (Number.isFinite(departMs) && departMs + delayMin * 60_000 < nowMs - PAST_GRACE_MS) {
      // Fallback: no usable position → original delay-adjusted scheduled-time filter.
      continue;
    }

    summaries.push({
      departHHMM: toJerusalemHHMM(travel.departureTime),
      arriveHHMM: toJerusalemHHMM(travel.arrivalTime),
      delayMin,
      platform: firstTrain.originPlatform,
      dayNote: dayNoteFor(departMs, nowMs),
      departEpoch: departMs,
    });
  }

  return summaries;
}

export function formatTrainLine(summary: TrainSummary): string {
  const { departHHMM, arriveHHMM, delayMin, platform, dayNote } = summary;

  const status = delayMin <= 0 ? 'on time' : `+${delayMin} min`;
  const platPart = platform ? ` · plat ${platform}` : '';
  const dayPart = dayNote ? ` · ${dayNote}` : '';

  return `${departHHMM} → ${arriveHHMM} · ${status}${platPart}${dayPart}`;
}
