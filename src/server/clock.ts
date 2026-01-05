import { performance } from 'node:perf_hooks';

/**
 * Monotonic microseconds timestamp, similar to asyncio loop.time()*1e6.
 */
export function serverNowUs(): number {
  return Math.round(performance.now() * 1000);
}
