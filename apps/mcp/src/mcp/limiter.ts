// One limiter per server process, shared by every tool call and every HTTP client, around the
// client's transport: abgeordnetenwatch.de is someone else's production service, and one tool
// call can mean several requests (paging, name -> mandate -> votes).
//  - at most `inFlight` requests at once (default 2);
//  - at most `perMinute` request starts in any 60 s (default 120);
//  - a 429 pauses every start for its Retry-After (or 5 s), on top of the engine's own retry;
//  - at most `queue` requests wait (default 32); one more is refused at once (AwNetworkError);
//  - a waiting request whose signal aborts leaves the queue.

import { AwNetworkError, parseRetryAfter, type HttpRequest, type HttpResponse, type Transport } from "@maschinenlesbar.org/abgeordnetenwatch-client";

export interface LimiterOptions {
  inFlight?: number;
  perMinute?: number;
  queue?: number;
  /** The clock (ms); tests inject one. */
  now?: () => number;
}

const WINDOW_MS = 60_000;
const DEFAULT_PAUSE_MS = 5_000;

interface Waiter {
  start: () => void;
  fail: (err: Error) => void;
}

export function limitTransport(transport: Transport, options: LimiterOptions = {}): Transport {
  const inFlight = options.inFlight ?? 2;
  const perMinute = options.perMinute ?? 120;
  const queueSize = options.queue ?? 32;
  const now = options.now ?? Date.now;
  const starts: number[] = [];
  const waiting: Waiter[] = [];
  let active = 0;
  let pausedUntil = 0;
  let timer: NodeJS.Timeout | undefined;

  /** Start as many waiters as the limits allow; else wake up when the next one may start. */
  const pump = (): void => {
    while (waiting.length > 0) {
      const t = now();
      while (starts.length > 0 && (starts[0] as number) <= t - WINDOW_MS) starts.shift();
      if (active >= inFlight) return;
      const wait = Math.max(pausedUntil - t, starts.length >= perMinute ? (starts[0] as number) + WINDOW_MS - t : 0);
      if (wait > 0) {
        if (timer === undefined) {
          timer = setTimeout(() => {
            timer = undefined;
            pump();
          }, wait);
          timer.unref();
        }
        return;
      }
      const next = waiting.shift() as Waiter;
      active += 1;
      starts.push(t);
      next.start();
    }
  };

  return async (request: HttpRequest): Promise<HttpResponse> => {
    if (waiting.length >= queueSize) {
      throw new AwNetworkError(`The server is busy: ${queueSize} requests to the API are already waiting. Try again shortly.`);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { start: resolve, fail: reject };
      const signal = request.signal;
      if (signal !== undefined) {
        const leave = (): void => {
          const at = waiting.indexOf(waiter);
          if (at >= 0) {
            waiting.splice(at, 1);
            reject(signal.reason instanceof Error ? signal.reason : new AwNetworkError("aborted"));
          }
        };
        if (signal.aborted) return leave();
        signal.addEventListener("abort", leave, { once: true });
        waiter.start = () => {
          signal.removeEventListener("abort", leave);
          resolve();
        };
      }
      waiting.push(waiter);
      pump();
    });
    try {
      const response = await transport(request);
      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers["retry-after"], now());
        pausedUntil = Math.max(pausedUntil, now() + (retryAfter ?? DEFAULT_PAUSE_MS));
      }
      return response;
    } finally {
      active -= 1;
      pump();
    }
  };
}
