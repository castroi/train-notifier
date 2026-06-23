/** Live position of a moving train; null until the train is physically tracked. */
export interface TrainPosition {
  /** Last station the train has passed; appears in `routeStations`. */
  currentLastStation?: number;
  nextStation?: number;
  calcDiffMinutes?: number;
}

/** One station on the train's full physical route, origin → terminus. */
export interface RouteStation {
  stationId: number;
}

export interface Train {
  trainNumber: number;
  orignStation: number; // intentionally misspelled to match the API
  destinationStation: number;
  originPlatform: number;
  destPlatform: number;
  arrivalTime: string;
  departureTime: string;
  trainPosition: TrainPosition | null;
  routeStations?: RouteStation[];
}

export interface RailApiRouteItem {
  departureTime: string;
  arrivalTime: string;
  trains: Train[];
}

export interface RailApiGetRoutesResult {
  result: {
    travels: RailApiRouteItem[];
  };
}
