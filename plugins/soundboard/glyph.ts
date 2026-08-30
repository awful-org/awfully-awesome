import type { SoundRecord } from "./storage";

/**
 * What a sound shows on a tile or widget button: its emoji, or the name's
 * first character for sounds saved before emoji existed.
 */
export function soundGlyph(sound: Pick<SoundRecord, "emoji" | "name">): string {
  if (sound.emoji) return sound.emoji;
  return [...sound.name][0]?.toUpperCase() ?? "♪";
}
