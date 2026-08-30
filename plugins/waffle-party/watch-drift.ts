// The waffle end of $lib/plugins/watch: pure decisions here, network and
// player wiring in the surfaces. Split for the same reason the lib is pure -
// this is the part worth testing without a YouTube iframe.
import {
  decideCorrection,
  projectPosition,
  type ClockEstimate,
  type WatchTick,
} from "$lib/plugins/watch";

/**
 * Where the local player should seek to align with the shared tick, or null
 * for "leave it alone".
 *
 * Null when: no tick (legacy state, track change); no clock estimate for
 * the tick's sender yet (projecting on an unknown offset invents drift and
 * the seek would ADD desync - wait for samples); the players disagree about
 * paused (the existing play/pause assertion owns that, not a seek); or the
 * drift is inside the tolerance band. YouTube's iframe rounds fractional
 * playback rates to its discrete steps, so Syncplay's rate-nudge lane does
 * not exist here - "rate" corrections map to null and only real seeks
 * (drift past DEFAULT_WATCH_SYNC.seekThresholdMs, 4s) act.
 */
export function driftSeekTarget(
  tick: WatchTick | null,
  offset: ClockEstimate | null,
  tickBySelf: boolean,
  local: { position: number; paused: boolean },
  nowMs: number
): number | null {
  if (!tick) return null;
  const offsetMs = tickBySelf ? 0 : offset?.offsetMs;
  if (offsetMs === undefined) return null;
  const c = decideCorrection({ ...local, rate: 1 }, tick, nowMs, offsetMs);
  return c.action === "seek" ? Math.max(0, c.targetPosition) : null;
}

/**
 * The tick's position right now on the local clock, or null when it cannot
 * be projected (same gating as driftSeekTarget). Used to seed a freshly
 * mounted player closer to the party than the raw stored position.
 */
export function projectedTickPosition(
  tick: WatchTick | null,
  offset: ClockEstimate | null,
  tickBySelf: boolean,
  nowMs: number
): number | null {
  if (!tick) return null;
  const offsetMs = tickBySelf ? 0 : offset?.offsetMs;
  if (offsetMs === undefined) return null;
  return Math.max(0, projectPosition(tick, nowMs, offsetMs));
}
