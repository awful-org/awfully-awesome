import { describe, expect, it, vi } from "vitest";
import { hasMp3Signature, MAX_IMPORT_BYTES, validateMp3File } from "./import";

function mp3(name = "sound.mp3", type = "audio/mpeg", size = 8) {
  const bytes = new Uint8Array(size);
  bytes.set([0x49, 0x44, 0x33]);
  return new File([bytes], name, { type });
}

function decoded(duration = 5, channels = 2) {
  return { duration, numberOfChannels: channels } as AudioBuffer;
}

describe("MP3 import validation", () => {
  it("recognizes ID3 and MPEG frame signatures", () => {
    expect(hasMp3Signature(new Uint8Array([0x49, 0x44, 0x33]))).toBe(true);
    expect(hasMp3Signature(new Uint8Array([0xff, 0xfb, 0x90]))).toBe(true);
    expect(hasMp3Signature(new Uint8Array([0, 1, 2]))).toBe(false);
  });

  it("accepts exact size and duration boundaries", async () => {
    const decode = vi.fn(async () => decoded(120, 2));
    const file = mp3("BOUNDARY.MP3", "", MAX_IMPORT_BYTES);
    const result = await validateMp3File(file, decode);
    expect(result.buffer.duration).toBe(120);
    expect(decode).toHaveBeenCalledOnce();
  });

  it.each([
    [new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], "a.mp3", { type: "audio/mpeg" }), "8 MiB"],
    [mp3("a.wav"), "Choose an MP3"],
    [mp3("a.mp3", "audio/wav"), "Choose an MP3"],
    [new File([new Uint8Array([1, 2, 3])], "a.mp3", { type: "audio/mpeg" }), "valid MP3"],
  ])("rejects cheap invalid input before decode", async (file, message) => {
    const decode = vi.fn(async () => decoded());
    await expect(validateMp3File(file, decode)).rejects.toThrow(message);
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects decode failure, long sources and unsupported channels", async () => {
    await expect(validateMp3File(mp3(), async () => { throw new Error(); }))
      .rejects.toThrow("decoded");
    await expect(validateMp3File(mp3(), async () => decoded(120.001)))
      .rejects.toThrow("2 minutes");
    await expect(validateMp3File(mp3(), async () => decoded(1, 3)))
      .rejects.toThrow("mono or stereo");
  });
});
