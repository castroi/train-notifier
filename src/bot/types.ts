/**
 * Minimal local types for the bot module.
 * Defined here to keep src/bot self-contained (no cross-module deps).
 */

export interface BotRoute {
  key: string;
  index: number;
  label_en: string;
  label_he: string;
  aliases: string[];
}

/**
 * A time window during which a specific route is pre-selected.
 * start/end are "HH:mm" strings (Asia/Jerusalem local time).
 * Windows do not cross midnight.
 */
export interface BotWindow {
  start: string;
  end: string;
  route_key?: string;
}
