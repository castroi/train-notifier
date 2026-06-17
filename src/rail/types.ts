export interface Train {
  trainNumber: number;
  orignStation: number; // intentionally misspelled to match the API
  destinationStation: number;
  originPlatform: number;
  destPlatform: number;
  arrivalTime: string;
  departureTime: string;
  trainPosition: unknown;
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
