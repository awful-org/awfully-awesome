import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import { setRuntimeConfig } from "$lib/runtime-config";
import ResumeOverlay from "./ResumeOverlay.svelte";
import {
  createAutoplayResumeController,
  elementVolume,
  proxiedLoaderUrl,
  videoIsPlaying,
} from "./AnimePlayer.svelte";

function setup(playing = true) {
  vi.useFakeTimers();
  let active = playing;
  let needsClick = false;
  let refusals = 0;
  const calls: string[] = [];
  const video = {
    paused: true,
    ended: false,
    muted: false,
    volume: 1,
    async play() {
      calls.push(this.muted ? "play:muted" : "play");
      if (refusals > 0) {
        refusals -= 1;
        // What a browser throws when the autoplay policy declines.
        throw new Error("NotAllowedError");
      }
      this.paused = false;
    },
  };
  const controller = createAutoplayResumeController({
    isPlaying: () => active,
    volume: () => 37,
    setNeedsClick: (value) => (needsClick = value),
    setTimer: (callback, delay) =>
      setTimeout(callback, delay) as unknown as number,
    clearTimer: (timer) =>
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>),
  });
  return {
    calls,
    controller,
    video,
    needsClick: () => needsClick,
    setPlaying: (value: boolean) => (active = value),
    refuse: (times: number) => (refusals = times),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stream urls", () => {
  it("sends every hls.js request through the instance's streaming relay", () => {
    setRuntimeConfig({ apiUrl: "https://relay.example" });
    const master = "https://hls.anidb.app/stream/abc/master.m3u8";
    expect(proxiedLoaderUrl(master)).toBe(
      `https://relay.example/plugin-stream?url=${encodeURIComponent(master)}`
    );
    // Segments arrive at the loader as absolute upstream urls (the
    // provider's playlists carry no relative paths), so the same wrapping
    // covers them without any base-url resolution of our own.
    const segment = "https://hls.anidb.app/stream/abc/file-1-f1-v1-a1.xls";
    expect(proxiedLoaderUrl(segment)).toContain(encodeURIComponent(segment));
  });

  it("refuses to proxy anything but the provider's stream host", () => {
    setRuntimeConfig({ apiUrl: "https://relay.example" });
    for (const url of [
      "https://evil.example/master.m3u8",
      "https://relay.example/plugin-stream?url=x",
      "http://hls.anidb.app/a/master.m3u8",
      "https://hls.anidb.app.evil.example/a/master.m3u8",
    ]) {
      // A throw is the useful answer here: hls.js then opens the request
      // plainly against the original url, which fails loudly on CORS
      // instead of the relay being asked to fetch a host somebody else
      // picked - its own included.
      expect(() => proxiedLoaderUrl(url)).toThrow();
    }
  });

  it("is read per call, so an instance's address is never inlined", () => {
    setRuntimeConfig({ apiUrl: "https://one.example" });
    const first = proxiedLoaderUrl("https://hls.anidb.app/a/master.m3u8");
    setRuntimeConfig({ apiUrl: "https://two.example" });
    const second = proxiedLoaderUrl("https://hls.anidb.app/a/master.m3u8");
    expect(first).toContain("one.example");
    expect(second).toContain("two.example");
  });
});

describe("playback state helpers", () => {
  it("counts only an element that is neither paused nor finished", () => {
    const base = { paused: false, ended: false, muted: false, volume: 1, play: async () => {} };
    expect(videoIsPlaying(base)).toBe(true);
    expect(videoIsPlaying({ ...base, paused: true })).toBe(false);
    expect(videoIsPlaying({ ...base, ended: true })).toBe(false);
    expect(videoIsPlaying(null)).toBe(false);
  });

  it("maps the 0..100 preference onto the element's own scale", () => {
    expect(elementVolume(0)).toBe(0);
    expect(elementVolume(37)).toBe(0.37);
    expect(elementVolume(100)).toBe(1);
    expect(elementVolume(140)).toBe(1);
    expect(elementVolume(-5)).toBe(0);
    expect(elementVolume(Number.NaN)).toBe(1);
  });
});

describe("muted autoplay resume", () => {
  it("renders a clickable Play overlay over the picture", () => {
    const { body } = render(ResumeOverlay, { props: { onclick: () => {} } });
    expect(body).toContain("<button");
    expect(body).toContain('aria-label="Resume playback"');
    expect(body).toContain("z-20");
    expect(body).toContain("lucide-play");
  });

  it("plays unmuted when the policy allows it", async () => {
    const subject = setup();
    await subject.controller.attempt(subject.video);
    expect(subject.calls).toEqual(["play"]);
    expect(subject.video.muted).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(subject.needsClick()).toBe(false);
  });

  it("falls back to a muted play when the policy refuses", async () => {
    const subject = setup();
    subject.refuse(1);
    await subject.controller.attempt(subject.video);
    expect(subject.calls).toEqual(["play", "play:muted"]);
    expect(subject.video.muted).toBe(true);
    expect(subject.video.paused).toBe(false);
    expect(subject.needsClick()).toBe(false);
  });

  it("asks for a click when even the muted play is refused", async () => {
    const subject = setup();
    subject.refuse(2);
    await subject.controller.attempt(subject.video);
    expect(subject.calls).toEqual(["play", "play:muted"]);
    expect(subject.needsClick()).toBe(true);
  });

  it("shows the overlay when a permitted play never actually moves", async () => {
    const subject = setup();
    // play() resolves but the element stays parked - the silent decline no
    // event reports. Only the watchdog notices.
    subject.video.play = async () => {
      subject.calls.push("play");
    };
    await subject.controller.attempt(subject.video);
    vi.advanceTimersByTime(999);
    expect(subject.needsClick()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(subject.needsClick()).toBe(true);
  });

  it("restores the sound once playback is real, and re-arms the watchdog", () => {
    const subject = setup();
    subject.video.muted = true;
    subject.video.paused = false;
    subject.controller.onPlaying(subject.video);
    expect(subject.video.muted).toBe(false);
    expect(subject.video.volume).toBe(0.37);
    expect(subject.needsClick()).toBe(false);
    // Unmuting can pause playback in some browsers; the re-armed watchdog
    // is what turns that into a resume overlay instead of silence.
    subject.video.paused = true;
    vi.advanceTimersByTime(1_000);
    expect(subject.needsClick()).toBe(true);
  });

  it("uses the resume gesture to restore audio and request playback", () => {
    const subject = setup();
    subject.video.muted = true;
    subject.controller.resume(subject.video);
    expect(subject.calls).toEqual(["play"]);
    expect(subject.video.muted).toBe(false);
    expect(subject.video.volume).toBe(0.37);
    expect(subject.needsClick()).toBe(false);
  });

  it("cancels the fallback when paused or disposed", () => {
    const subject = setup();
    subject.controller.schedule(subject.video);
    subject.setPlaying(false);
    subject.controller.pause();
    vi.advanceTimersByTime(1_000);
    expect(subject.needsClick()).toBe(false);

    subject.setPlaying(true);
    subject.controller.schedule(subject.video);
    subject.controller.dispose();
    vi.advanceTimersByTime(1_000);
    expect(subject.needsClick()).toBe(false);
  });
});
