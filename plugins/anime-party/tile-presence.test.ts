import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vitest runs .svelte.ts modules uncompiled, so the $state rune does not
// exist here. These tests cover the module's PLAIN functions; for them the
// rune is just an identity wrapper.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).$state = (v: unknown) => v;
});

import {
  handoffIsReadyToRelease,
  livePosition,
  liveDurationState,
  parkHandoff,
  publishLivePosition,
  publishLiveDuration,
  registerPositionSource,
  rendererSyncUpdate,
  takeLiveRendererControl,
  takeParkedRendererControl,
  takeRendererPosition,
  takeHandoff,
} from "./tile-presence.svelte";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  // Consume any handoff a previous test parked.
  takeHandoff();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("position source", () => {
  it("prefers the live source and falls back when unregistered", () => {
    const unregister = registerPositionSource(() => 42);
    expect(livePosition(7)).toBe(42);
    unregister();
    expect(livePosition(7)).toBe(7);
  });

  it("falls back when the source throws or returns garbage", () => {
    const unregister = registerPositionSource(() => {
      throw new Error("player gone");
    });
    expect(livePosition(7)).toBe(7);
    unregister();
    const unregister2 = registerPositionSource(() => NaN);
    expect(livePosition(7)).toBe(7);
    unregister2();
  });

  it("publishes the renderer time for surfaces without a player", () => {
    publishLivePosition(142, true);
    expect(livePosition(7)).toBe(142);
  });

  it("publishes the renderer duration for a shared seek bar", () => {
    publishLiveDuration(205);
    expect(liveDurationState.duration).toBe(205);
  });

  it("a stale unregister does not clear a newer source", () => {
    const first = registerPositionSource(() => 1);
    const second = registerPositionSource(() => 2);
    first();
    expect(livePosition(7)).toBe(2);
    second();
  });
});

describe("renderer handoff", () => {
  it("keeps the handoff until the replacement player reaches its target", () => {
    expect(handoffIsReadyToRelease(true, 120, 120, 205)).toBe(false);
    expect(handoffIsReadyToRelease(false, 120, 120, 0)).toBe(false);
    expect(handoffIsReadyToRelease(false, 0, 120, 205)).toBe(false);
    expect(handoffIsReadyToRelease(false, 122, 120, 205)).toBe(true);
    expect(handoffIsReadyToRelease(false, 123, 120, 205)).toBe(true);
    expect(handoffIsReadyToRelease(false, 123.001, 120, 205)).toBe(false);
  });

  it("hands a paused position over as-is, exactly once", () => {
    parkHandoff("video", 120, 205, false);
    expect(takeHandoff("video")).toMatchObject({
      position: 120,
      duration: 205,
      playing: false,
    });
    expect(takeHandoff()).toBeNull();
  });

  it("extrapolates elapsed time while playing", () => {
    parkHandoff("video", 120, 205, true);
    vi.advanceTimersByTime(3000);
    expect(takeHandoff()?.position).toBeCloseTo(123);
  });

  it("does not extrapolate while paused", () => {
    parkHandoff("video", 120, 205, false);
    vi.advanceTimersByTime(3000);
    expect(takeHandoff()?.position).toBe(120);
  });

  it("expires after 15 seconds", () => {
    parkHandoff("video", 120, 205, true);
    vi.advanceTimersByTime(15_001);
    expect(takeHandoff()).toBeNull();
  });

  it("ignores useless positions", () => {
    parkHandoff("video", 0, 205, true);
    expect(takeHandoff()).toBeNull();
    parkHandoff("video", NaN, 205, true);
    expect(takeHandoff()).toBeNull();
  });

  it("allows a fresh handoff after the previous one was consumed", () => {
    parkHandoff("video", 100, 205, false);
    expect(takeHandoff("video")).toMatchObject({
      position: 100,
      duration: 205,
      playing: false,
    });
    expect(takeHandoff("video")).toBeNull();
    // Simulate the tile parking a new handoff after taking the first one.
    parkHandoff("video", 200, 205, true);
    expect(takeHandoff("video")?.position).toBeCloseTo(200);
  });

  it("captures a fresh live position on every renderer takeover", () => {
    const first = registerPositionSource(() => 120);
    expect(takeRendererPosition("video", 0)).toBe(120);
    first();

    const second = registerPositionSource(() => 180);
    expect(takeRendererPosition("video", 0)).toBe(180);
    second();
  });

  it("requests authoritative synchronization on every owner or listener takeover", () => {
    const ownerUpdate = rendererSyncUpdate("owner", "owner", 120.9, "unused");
    expect(ownerUpdate).toEqual({
      action: "seek",
      position: 120,
      atMs: expect.any(Number),
    });
    // The sender clock is what keeps the party's tick alive across a
    // renderer switch - a seek without it nulls drift correction for
    // everyone (the reducer treats a missing atMs as a legacy update).
    expect((ownerUpdate as { atMs: number }).atMs).toBeGreaterThan(0);
    expect(rendererSyncUpdate("listener", "owner", 120.9, "request-1")).toEqual(
      {
        action: "resync",
        requestId: "request-1",
        requesterDid: "listener",
      }
    );
  });

  it("captures the live chat seed and sync update as one tile takeover", () => {
    const unregister = registerPositionSource(() => 120.9);
    expect(
      takeLiveRendererControl("video", 0, "listener", "owner", "request-2")
    ).toEqual({
      position: 120.9,
      update: {
        action: "resync",
        requestId: "request-2",
        requesterDid: "listener",
      },
    });
    unregister();
  });

  it("captures the parked tile seed and sync update as one chat takeover", () => {
    parkHandoff("video", 180.9, 205, true);
    expect(
      takeParkedRendererControl("video", "owner", "owner", "unused")
    ).toMatchObject({
      handoff: { position: 180.9, duration: 205, playing: true },
      update: { action: "seek", position: 180 },
    });
  });
});
