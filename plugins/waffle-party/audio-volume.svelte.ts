import {
  createAudioVolumeController,
  DEFAULT_VOLUME,
  type AudioPrefsStorage,
} from "./audio-prefs";

/** Shared local audio preference for every waffle-party renderer surface. */
export const audioVolume = $state({ value: DEFAULT_VOLUME });
const controller = createAudioVolumeController(audioVolume);

export function initializeAudioVolume(storage: AudioPrefsStorage): Promise<void> {
  return controller.initialize(storage);
}

export function setAudioVolume(
  storage: AudioPrefsStorage,
  value: unknown
): Promise<void> {
  return controller.set(storage, value);
}
