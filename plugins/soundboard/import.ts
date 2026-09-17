export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
export const MAX_SOURCE_SECONDS = 10 * 60;
const ACCEPTED_MIME = new Set(["", "audio/mpeg", "audio/mp3"]);

export interface DecodedSource {
  file: File;
  buffer: AudioBuffer;
}

type MetadataAudio = Pick<
  HTMLAudioElement,
  "src" | "preload" | "duration" | "onloadedmetadata" | "onerror" | "load"
>;

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

export function probeAudioDuration(
  file: Blob,
  createAudio: () => MetadataAudio = () => new Audio(),
  createUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
  revokeUrl: (url: string) => void = (url) => URL.revokeObjectURL(url),
): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = createAudio();
    const objectUrl = createUrl(file);
    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.src = "";
      revokeUrl(objectUrl);
    };

    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error("Audio duration is unavailable"));
        return;
      }
      resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("Audio metadata could not be loaded"));
    };
    audio.src = objectUrl;
    audio.load();
  });
}

export async function validateMp3File(
  file: File,
  decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>,
  probeDuration: (file: Blob) => Promise<number> = probeAudioDuration,
): Promise<DecodedSource> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error("MP3 must be 32 MiB or smaller");
  if (!file.name.toLowerCase().endsWith(".mp3")) throw new Error("Choose an MP3 file");
  if (!ACCEPTED_MIME.has(file.type.toLowerCase())) throw new Error("Choose an MP3 file");

  const header = await file.slice(0, 4096).arrayBuffer();
  if (!hasMp3Signature(new Uint8Array(header))) {
    throw new Error("This file is not a valid MP3");
  }

  let metadataDuration: number;
  try {
    metadataDuration = await probeDuration(file);
  } catch {
    throw new Error("This MP3's duration could not be read");
  }
  if (!Number.isFinite(metadataDuration) || metadataDuration <= 0) {
    throw new Error("This MP3's duration could not be read");
  }
  if (metadataDuration > MAX_SOURCE_SECONDS) {
    throw new Error("MP3 source must be 10 minutes or shorter");
  }

  const bytes = await file.arrayBuffer();
  let buffer: AudioBuffer;
  try {
    buffer = await decode(bytes);
  } catch {
    throw new Error("This MP3 could not be decoded");
  }
  if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
    throw new Error("This MP3 could not be decoded");
  }
  if (buffer.duration > MAX_SOURCE_SECONDS) throw new Error("MP3 source must be 10 minutes or shorter");
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) {
    throw new Error("Only mono or stereo MP3 files are supported");
  }
  return { file, buffer };
}
