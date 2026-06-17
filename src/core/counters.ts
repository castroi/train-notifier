/**
 * Per-route outcome counters.
 * flush() returns a single aggregated log line and resets all counters.
 * No PII is stored or emitted.
 */

type Outcome = 'success' | 'fail' | 'timeout';

interface RouteCounts {
  success: number;
  fail: number;
  timeout: number;
}

export class Counters {
  private readonly routes: Map<string, RouteCounts> = new Map();

  /** Record one outcome for the given route key. */
  record(routeKey: string, outcome: Outcome): void {
    let counts = this.routes.get(routeKey);
    if (counts === undefined) {
      counts = { success: 0, fail: 0, timeout: 0 };
      this.routes.set(routeKey, counts);
    }
    counts[outcome] += 1;
  }

  /**
   * Returns a single aggregated log line, then resets all counters.
   * Format: "counters route=<key> success=N fail=N timeout=N | route=<key> ..."
   * Returns an empty string if no routes have been recorded yet.
   */
  flush(): string {
    if (this.routes.size === 0) return '';

    const segments: string[] = [];
    for (const [key, counts] of this.routes) {
      segments.push(
        `route=${key} success=${counts.success} fail=${counts.fail} timeout=${counts.timeout}`,
      );
    }

    this.routes.clear();
    return `counters ${segments.join(' | ')}`;
  }
}
