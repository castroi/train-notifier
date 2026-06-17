import type { RailApiGetRoutesResult, Train } from './types.ts';

export interface TrainSummary {
  departHHMM: string;
  arriveHHMM: string;
  delayMin: number;
  platform: number;
  /** Day marker relative to "now": "" for today, "tomorrow", or e.g. "Thu 19/06". */
  dayNote: string;
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
 * The rail API ignores the requested `hour` and always returns the full day's
 * timetable from the first departure, so we filter to upcoming departures here
 * (this mirrors better-rail/server, which compares each route's departure to
 * `now`). The filter is delay-aware: a delayed train is kept until its actual
 * (delayed) departure has passed.
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

    const firstTrain: Train | undefined = travel.trains[0];
    if (!firstTrain) continue;

    const delayMin =
      (firstTrain.trainPosition as { calcDiffMinutes?: number } | null)?.calcDiffMinutes ?? 0;

    // Skip trains whose delay-adjusted departure is already in the past.
    const departMs = new Date(travel.departureTime).getTime();
    if (Number.isFinite(departMs) && departMs + delayMin * 60_000 < nowMs - PAST_GRACE_MS) {
      continue;
    }

    summaries.push({
      departHHMM: toJerusalemHHMM(travel.departureTime),
      arriveHHMM: toJerusalemHHMM(travel.arrivalTime),
      delayMin,
      platform: firstTrain.originPlatform,
      dayNote: dayNoteFor(departMs, nowMs),
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
