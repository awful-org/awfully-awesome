import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_PREFS_KEY,
  DEFAULT_VOLUME,
  readAudioPrefs,
  writeAudioPrefs,
} from "./audio-prefs";

describe("audio preferences", () => {
  it("restores every valid integer volume", async () => {
    const storage = { get: vi.fn().mockResolvedValue(37), set: vi.fn() };
    await expect(readAudioPrefs(storage)).resolves.toBe(37);
    expect(storage.get).toHaveBeenCalledWith(AUDIO_PREFS_KEY);
  });

  it("uses 100 for missing, malformed, out-of-range, and failed reads", async () => {
    for (const value of [undefined, null, "37", 12.5, -1, 101]) {
      await expect(
        readAudioPrefs({ get: vi.fn().mockResolvedValue(value), set: vi.fn() })
      ).resolves.toBe(DEFAULT_VOLUME);
    }
    await expect(
      readAudioPrefs({ get: vi.fn().mockRejectedValue(new Error("blocked")), set: vi.fn() })
    ).resolves.toBe(DEFAULT_VOLUME);
  });

  it("persists only valid integer volumes under audio_prefs", async () => {
    const storage = { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined) };
    await writeAudioPrefs(storage, 0);
    await writeAudioPrefs(storage, 100);
    await writeAudioPrefs(storage, 42.5);
    await writeAudioPrefs(storage, 101);
    expect(storage.set).toHaveBeenNthCalledWith(1, AUDIO_PREFS_KEY, 0);
    expect(storage.set).toHaveBeenNthCalledWith(2, AUDIO_PREFS_KEY, 100);
    expect(storage.set).toHaveBeenCalledTimes(2);
  });

  it("keeps the session usable when persistence fails", async () => {
    await expect(
      writeAudioPrefs({ get: vi.fn(), set: vi.fn().mockRejectedValue(new Error("blocked")) }, 55)
    ).resolves.toBeUndefined();
  });
});
