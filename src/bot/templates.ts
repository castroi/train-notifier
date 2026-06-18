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
  return `Pick a route:\n${items}`;
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
