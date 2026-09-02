import { describe, expect, it } from "vitest";
import { DEFAULT_WATCH_SYNC } from "$lib/plugins/watch";
import { driftCorrection, projectedTickPosition } from "./watch-drift";

const tick = (position: number, atMs: number, paused = false) => ({
  paused,
  position,
  atMs,
  rate: 1,
  seq: 0,
});
const est = (offsetMs: number) => ({ offsetMs, rttMs: 40, samples: 4 });

describe("driftCorrection", () => {
  const now = 1_700_000_010_000;

  it("seeks when the player is far behind the projected party", () => {
    // Tick: position 100 ten seconds ago on an aligned clock - the party is
    // at ~110 now. A player at 100 is 10s behind: seek.
    const c = driftCorrection(
      tick(100, now - 10_000),
      est(0),
      false,
      { position: 100, paused: false },
      now
    );
    expect(c?.action).toBe("seek");
    expect(c?.targetPosition).toBeCloseTo(110, 1);
  });

  it("stays quiet inside the tolerance band", () => {
    const c = driftCorrection(
      tick(100, now - 1_000),
      est(0),
      false,
      { position: 100.5, paused: false },
      now
    );
    expect(c?.action).toBe("none");
    expect(c?.rate).toBe(1);
  });

  it("nudges the rate in the middle band, which a native video can honour", () => {
    // 2.5s ahead: past Syncplay's rate threshold, under its seek threshold.
    // waffle-party mapped this to null because the YouTube iframe rounds
    // fractional rates away; a <video> does not, so the lane is live here.
    const c = driftCorrection(
      tick(100, now),
      est(0),
      false,
      { position: 102.5, paused: false },
      now
    );
    expect(c?.action).toBe("rate");
    expect(c?.rate).toBe(DEFAULT_WATCH_SYNC.slowRate);
  });

  it("speeds up when the player is behind by a rate-band amount", () => {
    const c = driftCorrection(
      tick(100, now),
      est(0),
      false,
      { position: 98, paused: false },
      now
    );
    expect(c?.action).toBe("rate");
    expect(c?.rate).toBe(DEFAULT_WATCH_SYNC.fastRate);
  });

  it("keeps correcting below the entry threshold while already nudged", () => {
    const c = driftCorrection(
      tick(100, now),
      est(0),
      false,
      { position: 100.3, paused: false, rate: DEFAULT_WATCH_SYNC.slowRate },
      now
    );
    expect(c?.action).toBe("rate");
    expect(c?.rate).toBe(DEFAULT_WATCH_SYNC.slowRate);
  });

  it("waits for a clock estimate instead of projecting on a guess", () => {
    expect(
      driftCorrection(
        tick(100, now - 60_000),
        null,
        false,
        { position: 100, paused: false },
        now
      )
    ).toBeNull();
  });

  it("projects on offset zero for its own ticks without an estimate", () => {
    const c = driftCorrection(
      tick(100, now - 10_000),
      null,
      true,
      { position: 100, paused: false },
      now
    );
    expect(c?.action).toBe("seek");
    expect(c?.targetPosition).toBeCloseTo(110, 1);
  });

  it("leaves pause disagreements to the play/pause assertion", () => {
    expect(
      driftCorrection(
        tick(100, now - 60_000, true),
        est(0),
        false,
        { position: 100, paused: false },
        now
      )
    ).toBeNull();
    expect(
      driftCorrection(
        tick(100, now),
        est(0),
        false,
        { position: 100, paused: true },
        now
      )
    ).toBeNull();
  });

  it("never asks for a negative seek target", () => {
    // A tick stamped 20 seconds in the FUTURE (a peer's clock estimate that
    // has not settled, a wrong system clock) projects to a negative
    // position. Seeking there is a media element error, so it clamps to 0.
    const c = driftCorrection(
      tick(0, now + 20_000),
      est(0),
      false,
      { position: 0, paused: false },
      now
    );
    expect(c?.action).toBe("seek");
    expect(c?.targetPosition).toBe(0);
  });

  it("returns nothing without a tick", () => {
    expect(
      driftCorrection(null, est(0), false, { position: 1, paused: false }, now)
    ).toBeNull();
  });
});

describe("projectedTickPosition", () => {
  const now = 1_700_000_010_000;

  it("applies the sender's clock offset", () => {
    // The sender's clock runs 5s AHEAD of ours (offset +5000): their tick
    // from "10s ago" on their clock is 15s old, projected via remoteNow.
    expect(
      projectedTickPosition(tick(100, now - 10_000), est(5_000), false, now)
    ).toBeCloseTo(115, 1);
  });

  it("a paused tick projects to its stored position", () => {
    expect(
      projectedTickPosition(tick(37, now - 60_000, true), est(0), false, now)
    ).toBe(37);
  });

  it("waits for an estimate, and needs none for its own ticks", () => {
    expect(
      projectedTickPosition(tick(100, now - 10_000), null, false, now)
    ).toBeNull();
    expect(
      projectedTickPosition(tick(100, now - 10_000), null, true, now)
    ).toBeCloseTo(110, 1);
  });
});
