import { describe, expect, it, vi } from "vitest";
import { createAutoplayResumeController } from "./WafflePlayer.svelte";

function setup(playing = true) {
  vi.useFakeTimers();
  let active = playing;
  let needsClick = false;
  const calls: string[] = [];
  const player = {
    state: 2,
    getPlayerState() {
      return this.state;
    },
    mute: () => calls.push("mute"),
    unMute: () => calls.push("unmute"),
    setVolume: (volume: number) => calls.push(`volume:${volume}`),
    playVideo: () => calls.push("play"),
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
    player,
    needsClick: () => needsClick,
    setPlaying: (value: boolean) => (active = value),
  };
}

describe("muted autoplay resume", () => {
  it("mutes before the initial sync and shows fallback after one second", () => {
    const subject = setup();
    subject.controller.prepare(subject.player, () => subject.calls.push("sync"));
    expect(subject.calls).toEqual(["mute", "sync"]);
    vi.advanceTimersByTime(999);
    expect(subject.needsClick()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(subject.needsClick()).toBe(true);
    vi.useRealTimers();
  });

  it("unmutes and restores volume when YouTube reaches playing state", () => {
    const subject = setup();
    subject.controller.prepare(subject.player, () => subject.calls.push("sync"));
    subject.player.state = 1;
    subject.controller.onPlaying(subject.player);
    expect(subject.needsClick()).toBe(false);
    expect(subject.calls).toEqual(["mute", "sync", "unmute", "volume:37"]);
    vi.advanceTimersByTime(1_000);
    expect(subject.needsClick()).toBe(false);
    vi.useRealTimers();
  });

  it("uses the resume gesture to restore audio and request playback", () => {
    const subject = setup();
    subject.controller.resume(subject.player);
    expect(subject.calls).toEqual(["unmute", "volume:37", "play"]);
    expect(subject.needsClick()).toBe(false);
    vi.useRealTimers();
  });

  it("cancels the fallback when paused or disposed", () => {
    const subject = setup();
    subject.controller.schedule(subject.player);
    subject.setPlaying(false);
    subject.controller.pause();
    vi.advanceTimersByTime(1_000);
    expect(subject.needsClick()).toBe(false);

    subject.setPlaying(true);
    subject.controller.schedule(subject.player);
    subject.controller.dispose();
    vi.advanceTimersByTime(1_000);
    expect(subject.needsClick()).toBe(false);
    vi.useRealTimers();
  });
});
