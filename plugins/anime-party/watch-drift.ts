// The anime-party end of $lib/plugins/watch: pure decisions here, network
// and player wiring in the surfaces. Split for the same reason the lib is
// pure - this is the part worth testing without a media element.
import {
  decideCorrection,
  projectPosition,
  type ClockEstimate,
  type Correction,
  type WatchTick,
} from "$lib/plugins/watch";

/**
 * What the local player should do to align with the shared tick, or null for
 * "leave it alone".
 *
 * Null when: no tick (legacy state, track change); no clock estimate for the
 * tick's sender yet (projecting on an unknown offset invents drift and the
 * correction would ADD desync - wait for samples); or the players disagree
 * about paused, which the surfaces' own play/pause assertion owns.
 *
 * Unlike waffle-party's, this returns the WHOLE correction. There the player
 * was a YouTube iframe, which rounds fractional playback rates to its own
 * discrete steps, so Syncplay's rate-nudge lane did not exist and "rate"
 * collapsed to null. A native <video> honours playbackRate exactly, so the
 * middle band is real: a 5% speed change closes a second or two of drift
 * without the audible, visible jump a seek costs. The surfaces apply it -
 * "seek" seeks, "rate" nudges, "none" restores rate 1.
 */
export function driftCorrection(
  tick: WatchTick | null,
  offset: ClockEstimate | null,
  tickBySelf: boolean,
  local: { position: number; paused: boolean; rate?: number },
  nowMs: number
): Correction | null {
  if (!tick) return null;
  const offsetMs = tickBySelf ? 0 : offset?.offsetMs;
  if (offsetMs === undefined) return null;
  const c = decideCorrection(
    { position: local.position, paused: local.paused, rate: local.rate ?? 1 },
    tick,
    nowMs,
    offsetMs
  );
  // pause/resume corrections are the play/pause assertion's job: the shared
  // state is authoritative there, and a correction that fought it would
  // toggle playback behind the party's back.
  if (c.action === "pause" || c.action === "resume") return null;
  return c.action === "seek"
    ? { ...c, targetPosition: Math.max(0, c.targetPosition) }
    : c;
}

/**
 * The tick's position right now on the local clock, or null when it cannot
 * be projected (same gating as driftCorrection). Used to seed a freshly
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
