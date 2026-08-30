export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_SECONDS = 120;
const ACCEPTED_MIME = new Set(["", "audio/mpeg", "audio/mp3"]);

export interface DecodedSource {
  file: File;
  buffer: AudioBuffer;
}

export function hasMp3Signature(bytes: Uint8Array): boolean {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const layer = (bytes[i + 1] >> 1) & 0x03;
    if (layer !== 0) return true;
  }
  return false;
}

export async function validateMp3File(
  file: File,
  decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>
): Promise<DecodedSource> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error("MP3 must be 8 MiB or smaller");
  if (!file.name.toLowerCase().endsWith(".mp3")) throw new Error("Choose an MP3 file");
  if (!ACCEPTED_MIME.has(file.type.toLowerCase())) throw new Error("Choose an MP3 file");

  const bytes = await file.arrayBuffer();
  if (!hasMp3Signature(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4096)))) {
    throw new Error("This file is not a valid MP3");
  }

  let buffer: AudioBuffer;
  try {
    buffer = await decode(bytes.slice(0));
  } catch {
    throw new Error("This MP3 could not be decoded");
  }
  if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
    throw new Error("This MP3 could not be decoded");
  }
  if (buffer.duration > MAX_SOURCE_SECONDS) throw new Error("MP3 source must be 2 minutes or shorter");
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) {
    throw new Error("Only mono or stereo MP3 files are supported");
  }
  return { file, buffer };
}
