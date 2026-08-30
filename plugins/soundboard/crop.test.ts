import { describe, expect, it } from "vitest";
import {
  buildWaveform,
  clampSelection,
  cropToMonoPcm,
  encodePcm16Wav,
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
