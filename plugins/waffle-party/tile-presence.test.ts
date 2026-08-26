import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vitest runs .svelte.ts modules uncompiled, so the $state rune does not
// exist here. These tests cover the module's PLAIN functions; for them the
// rune is just an identity wrapper.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).$state = (v: unknown) => v;
});

import {
  livePosition,
  parkHandoff,
  registerPositionSource,
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

  it("a stale unregister does not clear a newer source", () => {
    const first = registerPositionSource(() => 1);
    const second = registerPositionSource(() => 2);
    first();
    expect(livePosition(7)).toBe(2);
    second();
  });
});

describe("renderer handoff", () => {
  it("hands a paused position over as-is, exactly once", () => {
    parkHandoff(120, false);
    expect(takeHandoff()).toEqual({ position: 120, playing: false });
    expect(takeHandoff()).toBeNull();
  });

  it("extrapolates elapsed time while playing", () => {
    parkHandoff(120, true);
    vi.advanceTimersByTime(3000);
    expect(takeHandoff()?.position).toBeCloseTo(123);
  });

  it("does not extrapolate while paused", () => {
    parkHandoff(120, false);
    vi.advanceTimersByTime(3000);
    expect(takeHandoff()?.position).toBe(120);
  });

  it("expires after 15 seconds", () => {
    parkHandoff(120, true);
    vi.advanceTimersByTime(15_001);
    expect(takeHandoff()).toBeNull();
  });

  it("ignores useless positions", () => {
    parkHandoff(0, true);
    expect(takeHandoff()).toBeNull();
    parkHandoff(NaN, true);
    expect(takeHandoff()).toBeNull();
  });
});
