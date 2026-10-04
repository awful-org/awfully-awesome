import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import ResumeOverlay from "./ResumeOverlay.svelte";
import {
  createAutoplayResumeController,
  projectedReport,
  readPlayerEvent,
} from "./AnimePlayer.svelte";

const ORIGIN = "https://zokoanime.video";

function setup(playing = true) {
  vi.useFakeTimers();
  let active = playing;
  let needsClick = false;
  const calls: string[] = [];
  const embed = {
    moving: false,
    isPlaying() {
      return this.moving;
    },
    play() {
      calls.push("play");
    },
  };
  const controller = createAutoplayResumeController({
    isPlaying: () => active,
    setNeedsClick: (value) => (needsClick = value),
    setTimer: (callback, delay) =>
      setTimeout(callback, delay) as unknown as number,
    clearTimer: (timer) =>
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>),
  });
  return {
    calls,
    controller,
    embed,
    needsClick: () => needsClick,
    setPlaying: (value: boolean) => (active = value),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

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

  it("never projects past the end of the episode", () => {
    expect(projectedReport({ position: 1438, at: 0, paused: false }, 10_000, 1440)).toBe(1440);
  });
});

describe("autoplay resume", () => {
  it("renders a clickable Play overlay over the picture", () => {
    const { body } = render(ResumeOverlay, { props: { onclick: () => {} } });
    expect(body).toContain("<button");
    expect(body).toContain('aria-label="Resume playback"');
    expect(body).toContain("z-20");
    expect(body).toContain("lucide-play");
  });

  it("stays out of the way when the embed starts moving", () => {
    const subject = setup();
    subject.controller.schedule(subject.embed);
    subject.embed.moving = true;
    subject.controller.onPlaying();
    vi.advanceTimersByTime(2_000);
    expect(subject.needsClick()).toBe(false);
  });

  it("asks for a click when a requested play never moves", () => {
    const subject = setup();
    // The silent decline no event reports. Only the watchdog notices.
    subject.controller.schedule(subject.embed);
    vi.advanceTimersByTime(1_999);
    expect(subject.needsClick()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(subject.needsClick()).toBe(true);
  });

  it("uses the click to ask the embed to play, and re-arms the watchdog", () => {
    const subject = setup();
    subject.controller.resume(subject.embed);
    expect(subject.calls).toEqual(["play"]);
    expect(subject.needsClick()).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(subject.needsClick()).toBe(true);
  });

  it("cancels the fallback when paused or disposed", () => {
    const subject = setup();
    subject.controller.schedule(subject.embed);
    subject.setPlaying(false);
    subject.controller.pause();
    vi.advanceTimersByTime(2_000);
    expect(subject.needsClick()).toBe(false);

    subject.setPlaying(true);
    subject.controller.schedule(subject.embed);
    subject.controller.dispose();
    vi.advanceTimersByTime(2_000);
    expect(subject.needsClick()).toBe(false);
  });
});
