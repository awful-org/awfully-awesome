export interface AudioPrefsStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const DEFAULT_VOLUME = 100;
export const AUDIO_PREFS_KEY = "audio_prefs";

export function validVolume(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  );
}

export async function readAudioPrefs(storage: AudioPrefsStorage): Promise<number> {
  try {
    const prefs = await storage.get(AUDIO_PREFS_KEY);
    return validVolume(prefs) ? prefs : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

export async function writeAudioPrefs(
  storage: AudioPrefsStorage,
  volume: unknown
): Promise<void> {
  if (!validVolume(volume)) return;
  try {
    await storage.set(AUDIO_PREFS_KEY, volume);
  } catch {
    // The selected volume remains usable for this session.
  }
}
