// Per-peer clock offsets for tick projection, sampled through
// host.clockSample and folded by the watch library's estimateClock.
// Module-level on purpose: offsets describe machines, not surfaces, and the
// card and the call tile should not each pay for their own samples.
import { estimateClock, type ClockEstimate, type ClockSample } from "$lib/plugins/watch";
import type { HostApi } from "$lib/plugins/api";

const SAMPLES_PER_ROUND = 4;
const SAMPLE_GAP_MS = 250;
const MAX_KEPT_SAMPLES = 8;
/** Clocks drift slowly; refreshing every few minutes is plenty. */
const REFRESH_MS = 5 * 60_000;

const estimates = new Map<string, { est: ClockEstimate; at: number }>();
const samples = new Map<string, ClockSample[]>();
const inFlight = new Set<string>();

export function clockEstimateFor(did: string | null): ClockEstimate | null {
  if (!did) return null;
  return estimates.get(did)?.est ?? null;
}

/** Fire-and-forget: make sure we hold a fresh offset for this peer. */
export function ensureClock(host: HostApi, did: string | null): void {
  if (!did || inFlight.has(did)) return;
  const held = estimates.get(did);
  if (held && Date.now() - held.at < REFRESH_MS) return;
  inFlight.add(did);
  void (async () => {
    try {
      for (let i = 0; i < SAMPLES_PER_ROUND; i++) {
        const sample = await host.clockSample(did, { timeoutMs: 2000 });
        if (sample) {
          const kept = samples.get(did) ?? [];
          kept.push(sample);
          samples.set(did, kept.slice(-MAX_KEPT_SAMPLES));
        }
        await new Promise((r) => setTimeout(r, SAMPLE_GAP_MS));
      }
      const kept = samples.get(did);
      if (kept?.length) {
        estimates.set(did, { est: estimateClock(kept), at: Date.now() });
      }
    } finally {
      inFlight.delete(did);
    }
  })();
}

/** Test seam. */
export function _resetClocks(): void {
  estimates.clear();
  samples.clear();
  inFlight.clear();
}
