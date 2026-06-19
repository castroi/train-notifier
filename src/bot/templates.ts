import type { BotRoute } from './types.ts';

/**
 * Pure string-building functions for all bot message templates (§14).
 *
 * Train lines are accepted as pre-formatted strings (formatted by the rail
 * module); this module does NOT format train data.
 */

/** "DD/MM/YYYY" in Asia/Jerusalem — used only for the route-report header. */
function reportDate(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(now);
}

/**
 * Route report header: "<label_en> — <DD/MM/YYYY>:" followed by each line
 * prefixed with " • ". Label is English only (the Hebrew label's RTL rendering
 * flips the "→" arrow direction).
 */
export function routeReport(route: BotRoute, lines: string[], now: Date): string {
  const header = `${route.label_en} — ${reportDate(now)}:`;
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
): string {
  const routeSection = routeReport(route, lines, now);
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

/** "Did you mean X as <role>? Reply yes / no." */
export function customConfirm(label: string, role: string): string {
  return `Did you mean ${label} as ${role}?\nReply yes / no (0 to cancel).`;
}

/** Reserved route-word used as a route half (custom-route-spec §8). */
export function customClarifyReserved(word: string): string {
  return `"${word}" is a saved route, not a station. Type a station name, or send "${word}" on its own for that route.`;
}

/** Pending custom flow aborted. */
export function customCancelled(): string {
  return '(custom route cancelled)';
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

/**
 * Custom-route schedule report. `routeLabel` is "<From EN> → <To EN>" built by
 * the caller; lines are pre-formatted train strings.
 */
export function customReport(routeLabel: string, lines: string[], now: Date): string {
  const header = `${routeLabel} — ${reportDate(now)}:`;
  const bullets = lines.map((l) => ` • ${l}`).join('\n');
  return `${header}\n${bullets}`;
}

/** Resolved route but the API returned zero upcoming trains. */
export function customNoTrains(routeLabel: string): string {
  return `No upcoming departures for ${routeLabel}.`;
}
