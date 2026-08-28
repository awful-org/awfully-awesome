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

export interface AudioVolumeState {
  value: number;
}

export function createAudioVolumeController(state: AudioVolumeState) {
  let initialized = false;
  let loading: Promise<void> | null = null;
  let revision = 0;
  let writes = Promise.resolve();

  function initialize(storage: AudioPrefsStorage): Promise<void> {
    if (initialized) return Promise.resolve();
    if (loading) return loading;

    const readRevision = revision;
    loading = readAudioPrefs(storage)
      .then((value) => {
        // A slider interaction that happened while storage was loading wins.
        if (revision === readRevision) state.value = value;
        initialized = true;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  function set(storage: AudioPrefsStorage, value: unknown): Promise<void> {
    if (!validVolume(value)) return Promise.resolve();
    revision += 1;
    initialized = true;
    state.value = value;
    // Range inputs can emit rapidly. Serialize writes so an older, slower
    // storage request can never overwrite the user's final selected volume.
    writes = writes.then(() => writeAudioPrefs(storage, value));
    return writes;
  }

  return { initialize, set };
}
