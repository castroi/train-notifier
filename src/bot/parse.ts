import { normalize } from './normalize.ts';
import type { BotRoute, BotWindow } from './types.ts';

export type ParseResult = { kind: 'route'; route: BotRoute } | { kind: 'menu' };

/**
 * Parse user input text and resolve to a route or a menu prompt.
 *
 * Rule order (§5.1):
 * (a) If the text begins with an integer (leading whitespace allowed):
 *     - value in 1..routes.length → that route (by 1-based index; trailing text ignored)
 *     - value out of range         → menu
 * (b) Else: exact normalized full-text alias match
 *     (normalize(text) === normalize(alias) for any alias of any route) → that route
 * (c) Else → menu
 */
export function parseInput(text: string, routes: BotRoute[]): ParseResult {
  // Rule (a): leading integer
  const intMatch = text.match(/^\s*(\d+)/);
  if (intMatch !== null) {
    const n = parseInt(intMatch[1], 10);
    if (n >= 1 && n <= routes.length) {
      // Find the route whose .index === n (1-based)
      const route = routes.find((r) => r.index === n);
      if (route !== undefined) {
        return { kind: 'route', route };
      }
    }
    // Integer present but out of range (or no matching index) → menu
    return { kind: 'menu' };
  }

  // Rule (b): exact normalized alias match
  const normalizedText = normalize(text);
  for (const route of routes) {
    for (const alias of route.aliases) {
      if (normalize(alias) === normalizedText) {
        return { kind: 'route', route };
      }
    }
  }

  // Rule (c): no match → menu
  return { kind: 'menu' };
}

/**
 * Given the current time and a list of time windows, return the route_key
 * of the first window whose [start, end) interval contains the current
 * Asia/Jerusalem local time, or null if no window matches or the matching
 * window has no route_key.
 *
 * Windows are "HH:mm" strings and do not cross midnight.
 */
export function resolveEager(now: Date, windows: BotWindow[]): string | null {
  // Format current time as HH:mm in Asia/Jerusalem
  const timeStr = now.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  for (const window of windows) {
    if (timeStr >= window.start && timeStr < window.end) {
      return window.route_key ?? null;
    }
  }

  return null;
}
