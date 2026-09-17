import { describe, expect, it } from "vitest";
import {
  buildWaveform,
  clampSelection,
  cropToMonoPcm,
  encodePcm16Wav,
  MAX_WAVEFORM_SAMPLES_PER_BUCKET,
} from "./crop";

function audio(channels: number[][], sampleRate = 10): AudioBuffer {
  const data = channels.map((values) => Float32Array.from(values));
  return {
    numberOfChannels: data.length,
    length: data[0].length,
    sampleRate,
    duration: data[0].length / sampleRate,
    getChannelData: (channel: number) => data[channel],
  } as AudioBuffer;
}

describe("sound crop processing", () => {
  it("clamps intervals to 250ms through five seconds and source bounds", () => {
    expect(clampSelection({ startSeconds: -1, endSeconds: 9 }, 8))
      .toEqual({ startSeconds: 0, endSeconds: 5 });
    expect(clampSelection({ startSeconds: 7.9, endSeconds: 8 }, 8))
      .toEqual({ startSeconds: 7.75, endSeconds: 8 });
  });

  it("accepts a larger caller-supplied clip duration", () => {
    expect(clampSelection({ startSeconds: 1, endSeconds: 9 }, 10, 8))
      .toEqual({ startSeconds: 1, endSeconds: 9 });

    const pcm = cropToMonoPcm(
      audio([Array.from({ length: 100 }, () => 0.25)]),
      { startSeconds: 1, endSeconds: 9 },
      10,
      8,
    );
    expect(pcm).toHaveLength(80);
  });

  it("extracts only the selected samples and downmixes stereo", () => {
    const buffer = audio([
      [0, 0, 1, 1, 0, 0, 0, 0, 0, 0],
      [0, 0, -1, -1, 0, 0, 0, 0, 0, 0],
    ]);
    const pcm = cropToMonoPcm(buffer, { startSeconds: 0.2, endSeconds: 0.5 }, 10);
    expect([...pcm]).toEqual([0, 0, 0]);
  });

  it("builds bounded waveform peaks", () => {
    const peaks = buildWaveform(audio([[0, -0.5, 1, 0]]), 2);
    expect([...peaks]).toEqual([0.5, 1]);
    expect([...buildWaveform(audio([[0.75]]), 2)]).toEqual([0.75, 0.75]);
  });

  it("bounds waveform reads while retaining representative long-buffer peaks", () => {
    const length = 100_000;
    let reads = 0;
    const channel = new Proxy({ length }, {
      get(target, property) {
        if (property === "length") return target.length;
        if (typeof property === "string" && /^\d+$/.test(property)) {
          reads++;
          return Number(property) === length - 1 ? 0.9 : 0.1;
        }
        return undefined;
      },
    }) as unknown as Float32Array;
    const buffer = {
      numberOfChannels: 1,
      length,
      sampleRate: 10,
      duration: length / 10,
      getChannelData: () => channel,
    } as unknown as AudioBuffer;

    const peaks = buildWaveform(buffer, 1);
    expect(peaks[0]).toBeCloseTo(0.9);
    expect(reads).toBeLessThanOrEqual(MAX_WAVEFORM_SAMPLES_PER_BUCKET);
  });

  it("encodes mono 48kHz signed PCM16 WAV headers and samples", async () => {
    const blob = encodePcm16Wav(Float32Array.from([-1, 0, 1]));
    const view = new DataView(await blob.arrayBuffer());
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...new Uint8Array(view.buffer, offset, length));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(32767);
  });
});
