import { describe, expect, it, vi } from "vitest";
import { createAudioVolumeController } from "./audio-prefs";

describe("shared audio volume", () => {
  it("keeps a live change made while the stored preference is loading", async () => {
    const state = { value: 100 };
    const controller = createAudioVolumeController(state);
    let resolveRead!: (value: unknown) => void;
    const pendingRead = new Promise<unknown>((resolve) => {
      resolveRead = resolve;
    });
    const storage = {
      get: vi.fn(() => pendingRead),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const loading = controller.initialize(storage);
    const saving = controller.set(storage, 42);
    resolveRead(17);
    await Promise.all([loading, saving]);

    expect(state.value).toBe(42);
    expect(storage.set).toHaveBeenCalledWith("audio_prefs", 42);
  });

  it("serializes rapid changes so the final stored volume wins", async () => {
    const state = { value: 100 };
    const controller = createAudioVolumeController(state);
    let resolveFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const storage = {
      get: vi.fn(),
      set: vi
        .fn()
        .mockImplementationOnce(() => firstWrite)
        .mockResolvedValueOnce(undefined),
    };

    const first = controller.set(storage, 60);
    const second = controller.set(storage, 75);
    await Promise.resolve();
    expect(storage.set).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([first, second]);
    expect(storage.set.mock.calls).toEqual([
      ["audio_prefs", 60],
      ["audio_prefs", 75],
    ]);
    expect(state.value).toBe(75);
  });
});
