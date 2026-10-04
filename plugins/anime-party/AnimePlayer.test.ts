import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import ResumeOverlay from "./ResumeOverlay.svelte";
import {
  createPlayAsserter,
  nextReport,
  PROJECTION_CAP_S,
  projectedReport,
  readPlayerEvent,
  statedReport,
  stuckRetryDelay,
} from "./AnimePlayer.svelte";

const ORIGIN = "https://zokoanime.video";

describe("embed messages", () => {
  it("reads the embed's own events", () => {
    expect(
      readPlayerEvent({
        origin: ORIGIN,
        data: { channel: "zokoanime", type: "time", position: 12.5, duration: 1440, percent: 1 },
      })
    ).toEqual({
      type: "time",
      position: 12.5,
      duration: 1440,
      paused: undefined,
      muted: undefined,
    });
    expect(
      readPlayerEvent({
        origin: ORIGIN,
        data: { channel: "zokoanime", type: "state", position: 3, duration: 9, paused: true, muted: true },
      })
    ).toMatchObject({ type: "state", paused: true, muted: true });
  });

  it("ignores anything another frame could post", () => {
    const data = { channel: "zokoanime", type: "ended" };
    // A forged "ended" from any other origin would skip the party's episode.
    expect(readPlayerEvent({ origin: "https://evil.example", data })).toBeNull();
    expect(readPlayerEvent({ origin: "https://zokoanime.video.evil", data })).toBeNull();
    expect(readPlayerEvent({ origin: ORIGIN, data: { type: "ended" } })).toBeNull();
    expect(readPlayerEvent({ origin: ORIGIN, data: { channel: "zokoanime" } })).toBeNull();
    expect(readPlayerEvent({ origin: ORIGIN, data: "ended" })).toBeNull();
    expect(readPlayerEvent({ origin: ORIGIN, data: null })).toBeNull();
  });

  it("drops fields that are not usable numbers or flags", () => {
    expect(
      readPlayerEvent({
        origin: ORIGIN,
        data: { channel: "zokoanime", type: "time", position: -1, duration: Infinity, paused: "no" },
      })
    ).toEqual({
      type: "time",
      position: undefined,
      duration: undefined,
      paused: undefined,
      muted: undefined,
    });
  });
});

describe("projectedReport", () => {
  it("moves a playing report forward by the time since it arrived", () => {
    expect(projectedReport({ position: 10, at: 1_000, paused: false }, 3_500, 0)).toBe(12.5);
  });

  it("holds a paused report where it is", () => {
    expect(projectedReport({ position: 10, at: 1_000, paused: true }, 9_000, 0)).toBe(10);
  });

  it("stops a few seconds past the last report: no reports means stalled", () => {
    expect(projectedReport({ position: 10, at: 0, paused: false }, 60_000, 0)).toBe(
      10 + PROJECTION_CAP_S
    );
  });

  it("never projects past the end of the episode", () => {
    expect(projectedReport({ position: 1438, at: 0, paused: false }, 10_000, 1440)).toBe(1440);
  });
});

describe("nextReport", () => {
  it("keeps a paused embed paused through the time events a seek sends", () => {
    // What the embed really sends after a pause that comes with a seek: the
    // pause, then "time" at the seek target - sometimes before the "seeked",
    // sometimes after - all at the very same position. The projection used
    // to take each as playback and ran on through the pause.
    for (const order of [
      ["time", "seeked", "time", "time"],
      ["seeked", "time", "time", "time"],
    ] as const) {
      let report = statedReport(10.52, true, 1_000);
      let at = 1_000;
      for (const type of order) report = nextReport(report, type, 10.428, (at += 100));
      expect(report.paused).toBe(true);
      expect(projectedReport(report, 9_000, 0)).toBe(10.428);
    }
  });

  it("calls the embed playing once consecutive time reports move forward", () => {
    let report = statedReport(10, true, 0);
    report = nextReport(report, "time", 10, 100);
    expect(report.paused).toBe(true);
    report = nextReport(report, "time", 10.25, 350);
    expect(report.paused).toBe(false);
  });

  it("does not read a jump as playback", () => {
    // A seek target landing after the last tick is not a tick.
    let report = nextReport(statedReport(10, true, 0), "time", 10, 100);
    report = nextReport(report, "time", 300, 200);
    expect(report.paused).toBe(true);
  });

  it("keeps a playing embed playing, and lets a seek move it without a verdict", () => {
    let report = nextReport(statedReport(10, false, 0), "time", 10, 100);
    expect(report.paused).toBe(false);
    report = nextReport(report, "seeked", 300, 200);
    expect(report).toEqual({ position: 300, at: 200, paused: false, lastTime: null });
    expect(nextReport(null, "seeked", 300, 0).paused).toBe(true);
  });
});

describe("stuckRetryDelay", () => {
  it("waits longer before each reload of a media-less embed, then gives up", () => {
    expect(stuckRetryDelay(0)).toBe(20_000);
    expect(stuckRetryDelay(1)).toBe(30_000);
    expect(stuckRetryDelay(2)).toBe(45_000);
    expect(stuckRetryDelay(3)).toBeNull();
  });
});

describe("play asserter", () => {
  function setup() {
    const sent: string[] = [];
    let needsClick = false;
    const asserter = createPlayAsserter({
      send: (type) => sent.push(type),
      setNeedsClick: (value) => (needsClick = value),
    });
    return { asserter, sent, needsClick: () => needsClick };
  }

  it("renders a clickable Play overlay over the picture", () => {
    const { body } = render(ResumeOverlay, { props: { onclick: () => {} } });
    expect(body).toContain("<button");
    expect(body).toContain('aria-label="Resume playback"');
    expect(body).toContain("z-20");
    expect(body).toContain("lucide-play");
  });

  it("keeps asking until the embed moves: a single early play can be swallowed", () => {
    const { asserter, sent, needsClick } = setup();
    asserter.assert(false);
    asserter.assert(false);
    expect(sent.filter((t) => t === "play")).toHaveLength(2);
    asserter.moved();
    asserter.assert(true);
    expect(sent.filter((t) => t === "play")).toHaveLength(2);
    expect(needsClick()).toBe(false);
  });

  it("does not put up the overlay for an episode that is merely slow to start", () => {
    const { asserter, needsClick } = setup();
    for (let i = 0; i < 15; i++) asserter.assert(false);
    expect(needsClick()).toBe(false);
  });

  it("asks for a click after the browser refuses twice, and stops asking", () => {
    const { asserter, sent, needsClick } = setup();
    asserter.assert(false);
    asserter.paused(false);
    expect(needsClick()).toBe(false);
    asserter.paused(false);
    expect(needsClick()).toBe(true);
    const before = sent.length;
    asserter.assert(false);
    expect(sent).toHaveLength(before);
  });

  it("forgives a pause that comes after real playback", () => {
    const { asserter, needsClick } = setup();
    asserter.paused(false);
    asserter.moved();
    asserter.paused(true);
    expect(needsClick()).toBe(false);
  });

  it("uses the click to ask the embed to play", () => {
    const { asserter, sent, needsClick } = setup();
    asserter.paused(false);
    asserter.paused(false);
    asserter.clicked();
    expect(needsClick()).toBe(false);
    expect(sent.at(-1)).toBe("play");
    asserter.assert(false);
    expect(sent.at(-2)).toBe("play");
  });
});
