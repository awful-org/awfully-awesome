import { describe, expect, it, vi } from "vitest";
import { createHostDepartureGrace } from "./host-departure";

describe("host departure grace", () => {
  it("closes once after five seconds when the host stays absent", () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const grace = createHostDepartureGrace("host", () => [], close);
    grace.observeDisconnect("host");
    grace.observeDisconnect("host");
    vi.advanceTimersByTime(4_999);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("cancels closure when the host reappears", () => {
    vi.useFakeTimers();
    let online = false;
    const close = vi.fn();
    const grace = createHostDepartureGrace("host", () => (online ? [{ did: "host" }] : []), close);
    grace.observeDisconnect("host");
    online = true;
    grace.observePeers();
    vi.advanceTimersByTime(5_000);
    expect(close).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not schedule for another peer and clears on disposal", () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const grace = createHostDepartureGrace("host", () => [], close);
    grace.observeDisconnect("other");
    grace.observeDisconnect("host");
    grace.dispose();
    vi.advanceTimersByTime(5_000);
    expect(close).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
