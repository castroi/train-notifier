import type { RailApiGetRoutesResult } from './types.ts';

function formatJerusalemDate(date: Date): { date: string; hour: string } {
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return {
    date: dateFmt.format(date),
    hour: timeFmt.format(date),
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 2): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = 500 * 2 ** (attempt - 1) + Math.random() * 200;
      await sleep(backoffMs);
    }

    try {
      const res = await fetch(url, init);
      if (res.ok) return res;

      // Don't fold the upstream response body into the error (it ends up in
      // logs); the status code is enough to diagnose.
      await res.body?.cancel().catch(() => {});
      lastError = new Error(`Rail API responded ${res.status}`);

      if (res.status >= 400 && res.status < 500) {
        throw lastError;
      }
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
    }
  }

  throw lastError;
}

export async function fetchRoutes(
  fromId: number,
  toId: number,
  when: Date,
  signal?: AbortSignal,
): Promise<RailApiGetRoutesResult> {
  const railUrl = process.env.RAIL_URL;
  const apiKey = process.env.RAIL_API_KEY;

  if (!railUrl) throw new Error('RAIL_URL environment variable is not set');
  if (!apiKey) throw new Error('RAIL_API_KEY environment variable is not set');

  const { date, hour } = formatJerusalemDate(when);

  const url = `${railUrl}/timetable/searchTrainForMobile`;

  const body = JSON.stringify({
    methodName: 'searchTrainLuzForDateTime',
    fromStation: fromId,
    toStation: toId,
    date,
    hour,
    systemType: '1',
    scheduleType: 'ByDeparture',
    languageId: 'English',
  });

  // Combine the internal 10s timeout with any caller-supplied abort signal
  // (e.g. the pipeline/scheduler deadline) so a deadline actually cancels the
  // in-flight request rather than leaving it running.
  const timeoutSignal = AbortSignal.timeout(10000);
  const reqSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Ocp-Apim-Subscription-Key': apiKey,
    },
    body,
    signal: reqSignal,
  });

  const data = (await res.json()) as RailApiGetRoutesResult;

  if (
    !data ||
    typeof data !== 'object' ||
    !('result' in data) ||
    !data.result ||
    !Array.isArray(data.result.travels)
  ) {
    throw new Error('Rail API returned unexpected response shape');
  }

  return data;
}
