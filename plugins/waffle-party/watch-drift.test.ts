import { describe, expect, it } from "vitest";
import { driftSeekTarget, projectedTickPosition } from "./watch-drift";

const tick = (position: number, atMs: number, paused = false) => ({
  paused,
  position,
  atMs,
  rate: 1,
  seq: 0,
});
const est = (offsetMs: number) => ({ offsetMs, rttMs: 40, samples: 4 });

describe("driftSeekTarget", () => {
  const now = 1_700_000_010_000;

  it("seeks when the player is far behind the projected party", () => {
    // Tick: position 100 ten seconds ago on an aligned clock - the party is
    // at ~110 now. A player at 100 is 10s behind: seek.
    const target = driftSeekTarget(tick(100, now - 10_000), est(0), false, { position: 100, paused: false }, now);
    expect(target).toBeCloseTo(110, 1);
  });

  it("stays quiet inside the tolerance band", () => {
    expect(
      driftSeekTarget(tick(100, now - 1_000), est(0), false, { position: 100.5, paused: false }, now)
    ).toBeNull();
  });

  it("never rate-corrects: mid-band drift maps to null on YouTube", () => {
    // 2.5s of drift sits in Syncplay's rate band; YT has no fractional
    // rates, so nothing happens until the seek threshold.
    expect(
      driftSeekTarget(tick(100, now), est(0), false, { position: 102.5, paused: false }, now)
    ).toBeNull();
  });

  it("waits for a clock estimate instead of projecting on a guess", () => {
    expect(
      driftSeekTarget(tick(100, now - 60_000), null, false, { position: 100, paused: false }, now)
    ).toBeNull();
  });

  it("projects on offset zero for its own ticks without an estimate", () => {
    expect(
      driftSeekTarget(tick(100, now - 10_000), null, true, { position: 100, paused: false }, now)
    ).toBeCloseTo(110, 1);
  });

  it("leaves pause disagreements to the play/pause assertion", () => {
    expect(
      driftSeekTarget(tick(100, now - 60_000, true), est(0), false, { position: 100, paused: false }, now)
    ).toBeNull();
  });

  it("applies the sender's clock offset", () => {
    // The sender's clock runs 5s AHEAD of ours (offset +5000): their tick
    // from "10s ago" on their clock is 15s old... projected via remoteNow.
    const target = projectedTickPosition(tick(100, now - 10_000), est(5_000), false, now);
    expect(target).toBeCloseTo(115, 1);
  });

  it("a paused tick projects to its stored position", () => {
    expect(projectedTickPosition(tick(37, now - 60_000, true), est(0), false, now)).toBe(37);
  });
});
