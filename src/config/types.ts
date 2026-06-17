export interface Route {
  key: string;
  from_id: number;
  to_id: number;
  label_en: string;
  label_he: string;
  aliases: string[];
  count?: number;
}

export interface Schedule {
  id: string;
  cron: string;
  route_key: string;
  count: number;
}

/** start/end are "HH:mm" in 24h format */
export interface TimeWindow {
  start: string;
  end: string;
  route_key?: string;
}

export interface SignalConfig {
  bot_number: string;
  owner_uuid: string;
  allowlist: string[];
}

export interface Config {
  signal: SignalConfig;
  routes: Route[];
  schedules: Schedule[];
  time_windows: TimeWindow[];
  defaults: {
    on_demand_count: number;
  };
}
