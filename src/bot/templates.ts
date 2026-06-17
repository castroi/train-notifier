import type { BotRoute } from './types.ts';

/**
 * Pure string-building functions for all bot message templates (§14).
 *
 * Train lines are accepted as pre-formatted strings (formatted by the rail
 * module); this module does NOT format train data.
 */

/**
 * Route report header: "<label_en> / <label_he> — next <count>:"
 * followed by each line prefixed with " • ".
 */
export function routeReport(route: BotRoute, lines: string[], count: number): string {
  const header = `${route.label_en} / ${route.label_he} — next ${count}:`;
  const bullets = lines.map((l) => ` • ${l}`).join('\n');
  return `${header}\n${bullets}`;
}

/**
 * Menu message: "Pick a route:" followed by numbered bilingual entries.
 * " <n>. <label_en> / <label_he>"
 */
export function menu(routes: BotRoute[]): string {
  const items = routes.map((r) => ` ${r.index}. ${r.label_en} / ${r.label_he}`).join('\n');
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
): string {
  const routeSection = routeReport(route, lines, lines.length);
  const otherItems = otherRoutes
    .map((r) => ` ${r.index}. ${r.label_en} / ${r.label_he}`)
    .join('\n');
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
