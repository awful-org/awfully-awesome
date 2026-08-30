import { describe, expect, it, vi } from "vitest";
import { CropPreviewPlayer, type PreviewState } from "./preview";

class SourceMock {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

function setup(state: AudioContextState = "running") {
  const sources: SourceMock[] = [];
  const context = {
    state,
    destination: {},
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createBufferSource: vi.fn(() => {
      const source = new SourceMock();
      sources.push(source);
      return source;
    }),
  } as unknown as AudioContext;
  const states: PreviewState[] = [];
  const player = new CropPreviewPlayer(() => context, (next) => states.push(next));
  return { context, player, sources, states };
}

const buffer = {} as AudioBuffer;

describe("CropPreviewPlayer", () => {
  it("replaces an active preview and starts from the new selection", async () => {
    const { player, sources, states } = setup();
    await player.play(buffer, 1, 2);
    await player.play(buffer, 3, 1);
    expect(sources[0].stop).toHaveBeenCalledOnce();
    expect(sources[1].start).toHaveBeenCalledWith(0, 3, 1);
    expect(states.at(-1)).toBe("playing");
  });

  it("cancels a preview while browser audio permission is resuming", async () => {
    let release!: () => void;
    const { context, player, sources, states } = setup("suspended");
    vi.mocked(context.resume).mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    const pending = player.play(buffer, 0, 1);
    player.stop();
    release();
    await pending;
    expect(sources).toHaveLength(0);
    expect(states.at(-1)).toBe("idle");
  });

  it("returns to idle when the browser rejects playback", async () => {
    const { context, player, states } = setup("suspended");
    vi.mocked(context.resume).mockRejectedValue(new Error("blocked"));
    await expect(player.play(buffer, 0, 1)).rejects.toThrow("blocked");
    expect(states.at(-1)).toBe("idle");
  });

  it("stops playback and closes its context on dispose", async () => {
    const { context, player, sources } = setup();
    await player.play(buffer, 0, 1);
    player.dispose();
    expect(sources[0].stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });
});
