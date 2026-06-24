import type { BotRoute } from './types.ts';

/**
 * Pure string-building functions for all bot message templates (§14).
 *
 * Train lines are accepted as pre-formatted strings (formatted by the rail
 * module); this module does NOT format train data.
 */

/** "DD/MM" in Asia/Jerusalem — used only for the route-report header. */
function reportDate(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
  }).format(now);
}

/**
 * Route report header: "<label_en> — <day>:" followed by each line
 * prefixed with " • ". Label is English only (the Hebrew label's RTL rendering
 * flips the "→" arrow direction). The header day is the first line's `dayNote`
 * ("tomorrow" / "Sun 21/06") when set, else today's "DD/MM".
 */
export function routeReport(
  route: BotRoute,
  lines: string[],
  now: Date,
  firstDayNote: string,
): string {
  const header = `${route.label_en} — ${firstDayNote || reportDate(now)}:`;
  const bullets = lines.map((l) => ` • ${l}`).join('\n');
  return `${header}\n${bullets}`;
}

/**
 * Menu message: "Pick a route:" followed by numbered entries.
 * " <n>. <label_en>"
 */
export function menu(routes: BotRoute[]): string {
  const items = routes.map((r) => ` ${r.index}. ${r.label_en}`).join('\n');
  return `Pick a route:\n${items}\n 0. Other route  (יעד אחר)`;
}

/**
 * Eager greeting: greeting line, then the route's train lines bulleted,
 * then "Other routes:" followed by numbered entries for all other routes.
 *
 * The greeting string is provided by the caller (e.g. "Good morning!").
 */
export function eagerGreeting(
  route: BotRoute,
  lines: string[],
  otherRoutes: BotRoute[],
  greeting: string,
  now: Date,
  firstDayNote: string,
): string {
  const routeSection = routeReport(route, lines, now, firstDayNote);
  const otherItems = otherRoutes.map((r) => ` ${r.index}. ${r.label_en}`).join('\n');
  return `${greeting}\n${routeSection}\nOther routes:\n${otherItems}`;
}

/**
 * No upcoming trains for the given route.
 */
export function noTrains(route: BotRoute): string {
  return `No upcoming departures for ${route.label_en}.`;
}

/**
 * Rail API is down or returned an error.
 */
export function outage(): string {
  return 'Train data is unavailable right now — please try again shortly.';
}

// ---------------------------------------------------------------------------
// Custom-route templates (custom-route-spec.md §12).
//
// These are pure string builders. Station labels are passed in pre-rendered
// by the caller (route orchestrator) — this module never touches station data.
// Menu labels may be bilingual (EN + HE); report headers stay EN-only because
// the Hebrew label's RTL rendering flips the "→" arrow.
// ---------------------------------------------------------------------------

/** Entry prompt shown after `0` / "Other route". */
export function customAskRoute(): string {
  return 'Custom route. Send it as "From to To" (e.g. "Haifa to Afula"), or just the origin.';
}

/**
 * Numbered disambiguation menu. `prompt` is e.g. "Which origin?" / "Which
 * destination?"; `labels` are pre-rendered bilingual station labels.
 */
export function customMenu(prompt: string, labels: string[]): string {
  const items = labels.map((l, i) => ` ${i + 1}. ${l}`).join('\n');
  return `${prompt}\n${items}\n(0 to cancel)`;
}

/**
 * "Did you mean X as <role>?" with a numbered 1=yes / 2=no choice, matching the
 * menu input model so the user never has to type a word (or switch keyboard
 * layout). The words yes/no/כן/לא are still accepted, just no longer required.
 */
export function customConfirm(label: string, role: string): string {
  return `Did you mean ${label} as ${role}?\n 1. Yes\n 2. No\n(0 to cancel)`;
}

/** Reserved route-word used as a route half (custom-route-spec §8). */
export function customClarifyReserved(word: string): string {
  return `"${word}" is a saved route, not a station. Type a station name, or send "${word}" on its own for that route.`;
}

/** Pending custom flow / wizard aborted (§4.6). */
export function customCancelled(): string {
  return 'Cancelled. Send a route any time (like Afula to Akko).';
}

/** No station matched; offer the closest suggestions as a menu. */
export function customNotFound(labels: string[]): string {
  if (labels.length === 0) {
    return "Couldn't find that station. Try a different spelling.";
  }
  const items = labels.map((l, i) => ` ${i + 1}. ${l}`).join('\n');
  return `Couldn't find that station. Did you mean:\n${items}\n(0 to cancel)`;
}

/** More than 8 candidates — ask the user to narrow. */
export function customTooBroad(): string {
  return 'Too broad — add a city or another word.';
}

/** Origin and destination resolved to the same station (G4). */
export function customSameStation(): string {
  return 'Origin and destination are the same station — please send a different route.';
}

/** Resolved route but the API returned zero upcoming trains. */
export function customNoTrains(routeLabel: string): string {
  return `No upcoming departures for ${routeLabel}.`;
}

// ---------------------------------------------------------------------------
// Wizard templates (wizard plan §5/§6/§8). Prompts are bounded; every result
// echoes the resolved absolute datetime as a safeguard against a wrong slot.
// ---------------------------------------------------------------------------

/** "YYYY-MM-DD" for an instant, in Asia/Jerusalem (day-equality check). */
function jerusalemDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Date prompt — entry to the wizard after a route resolves (§4.1). */
export function askDate(): string {
  return 'When?\nnow / today / tomorrow / custom date (like 17/09)';
}

/** Time prompt. `dayWord` (e.g. "tomorrow") personalises it: "When tomorrow?". */
export function askTime(dayWord?: string): string {
  const head = dayWord ? `When ${dayWord}?` : 'When?';
  return `${head}\nnow / custom time (like 7, 19, 12:30)`;
}

/** Invalid date input — restate the accepted forms, stay on the step (§6.3). */
export function badDate(): string {
  return "Didn't catch that. Type one of: now / today / tomorrow / a date like 17/09";
}

/** Invalid time input — restate the accepted forms, stay on the step (§6.3). */
export function badTime(): string {
  return "That's not a valid time. Type a time like 7:00, 19, or 12:30";
}

/** Follow-up nudge shown after every result (§8.5). Advertises refresh in
 * English; the Hebrew triggers are accepted but never listed (issue #15). */
export function resultsNudge(): string {
  return 'Refresh, a different date/time, or a new route?';
}

/** Refresh word during an unfinished flow — route not yet resolved to results. */
export function refreshNotReady(): string {
  return 'Finish choosing your route first.';
}

/** A lone date/time arrived with no active wizard (e.g. after the TTL lapsed, §7.2). */
export function wizardNoRoute(): string {
  return 'I don\'t have a route in mind — send one like "Afula to Akko" first.';
}

/**
 * Resolved-datetime header for a wizard result (§8.2):
 *   now / day-only → "<label> · Today 22 Jun:" or "<label> · Tue 23 Jun:"
 *   with time      → "<label> · Tue 23 Jun, 17:00:"
 * Only the current Jerusalem day is labelled "Today"; every other day shows its
 * weekday (so tomorrow renders "Tue 23 Jun", per the spec examples).
 */
export function wizardHeader(label: string, when: Date, now: Date, showTime: boolean): string {
  const dayMon = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    day: 'numeric',
    month: 'short',
  }).format(when); // "22 Jun"
  const dayPart =
    jerusalemDateStr(when) === jerusalemDateStr(now)
      ? `Today ${dayMon}`
      : `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(when)} ${dayMon}`;
  const timePart = showTime
    ? `, ${new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jerusalem',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(when)}`
    : '';
  return `${label} · ${dayPart}${timePart}:`;
}

/** Full wizard result: datetime header + bulleted lines + the follow-up nudge. */
export function wizardReport(
  label: string,
  lines: string[],
  when: Date,
  now: Date,
  showTime: boolean,
): string {
  const header = wizardHeader(label, when, now, showTime);
  const bullets = lines.map((l) => ` • ${l}`).join('\n');
  return `${header}\n${bullets}\n\n${resultsNudge()}`;
}

/**
 * No service left on the requested day → roll to the next service day (§8.4).
 * `serviceDay` is the first remaining train's departure instant; `requestedWhen`
 * is the datetime the user asked for (so we only say "today" when it truly is).
 */
export function wizardRollover(
  label: string,
  lines: string[],
  serviceDay: Date,
  now: Date,
  requestedWhen: Date,
): string {
  const header = wizardHeader(label, serviceDay, now, false);
  const bullets = lines.map((l) => ` • ${l}`).join('\n');
  const day = jerusalemDateStr(requestedWhen) === jerusalemDateStr(now) ? 'today' : 'that day';
  return `No more trains ${day} for ${label}. Next service:\n${header}\n${bullets}\n\n${resultsNudge()}`;
}
