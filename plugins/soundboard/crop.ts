export const MIN_CLIP_SECONDS = 0.25;
export const MAX_CLIP_SECONDS = 5;
export const OUTPUT_SAMPLE_RATE = 48_000;

export interface CropSelection {
  startSeconds: number;
  endSeconds: number;
}

export function clampSelection(
  selection: CropSelection,
  sourceDuration: number
): CropSelection {
  if (!Number.isFinite(sourceDuration) || sourceDuration < MIN_CLIP_SECONDS) {
    throw new Error("Source is too short");
  }
  let start = Math.max(0, Math.min(selection.startSeconds, sourceDuration - MIN_CLIP_SECONDS));
  let end = Math.max(start + MIN_CLIP_SECONDS, Math.min(selection.endSeconds, sourceDuration));
  if (end - start > MAX_CLIP_SECONDS) end = start + MAX_CLIP_SECONDS;
  if (end > sourceDuration) {
    end = sourceDuration;
    start = Math.max(0, end - MAX_CLIP_SECONDS);
  }
  return { startSeconds: start, endSeconds: end };
}

export function buildWaveform(buffer: AudioBuffer, buckets: number): Float32Array {
  const count = Math.max(1, Math.floor(buckets));
  const result = new Float32Array(count);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  for (let bucket = 0; bucket < count; bucket++) {
    const from = Math.floor((bucket / count) * buffer.length);
    const to = Math.max(from + 1, Math.floor(((bucket + 1) / count) * buffer.length));
    let peak = 0;
    for (const channel of channels) {
      for (let i = from; i < to && i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
    }
    result[bucket] = peak;
  }
  return result;
}

export function cropToMonoPcm(
  buffer: AudioBuffer,
  selection: CropSelection,
  outputRate = OUTPUT_SAMPLE_RATE
): Float32Array {
  const selected = clampSelection(selection, buffer.duration);
  const duration = selected.endSeconds - selected.startSeconds;
  const outputLength = Math.max(1, Math.round(duration * outputRate));
  const output = new Float32Array(outputLength);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const startFrame = selected.startSeconds * buffer.sampleRate;

  for (let i = 0; i < outputLength; i++) {
    const sourcePosition = startFrame + (i * buffer.sampleRate) / outputRate;
    const left = Math.floor(sourcePosition);
    const fraction = sourcePosition - left;
    let sample = 0;
    for (const channel of channels) {
      const a = channel[Math.min(left, channel.length - 1)] ?? 0;
      const b = channel[Math.min(left + 1, channel.length - 1)] ?? a;
      sample += a + (b - a) * fraction;
    }
    output[i] = Math.max(-1, Math.min(1, sample / channels.length));
  }
  return output;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
}

export function encodePcm16Wav(samples: Float32Array, sampleRate = OUTPUT_SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
