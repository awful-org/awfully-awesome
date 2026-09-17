import { describe, expect, it, vi } from "vitest";
import { hasMp3Signature, probeAudioDuration, validateMp3File } from "./import";

const SPEC_MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const SPEC_MAX_SOURCE_SECONDS = 10 * 60;

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
    const decode = vi.fn(async () => decoded(SPEC_MAX_SOURCE_SECONDS, 2));
    const probe = vi.fn(async () => SPEC_MAX_SOURCE_SECONDS);
    const file = mp3("BOUNDARY.MP3", "", SPEC_MAX_IMPORT_BYTES);
    const result = await validateMp3File(file, decode, probe);
    expect(result.buffer.duration).toBe(SPEC_MAX_SOURCE_SECONDS);
    expect(probe).toHaveBeenCalledWith(file);
    expect(decode).toHaveBeenCalledOnce();
  });

  it.each([
    [new File([new Uint8Array(SPEC_MAX_IMPORT_BYTES + 1)], "a.mp3", { type: "audio/mpeg" }), "32 MiB"],
    [mp3("a.wav"), "Choose an MP3"],
    [mp3("a.mp3", "audio/wav"), "Choose an MP3"],
    [new File([new Uint8Array([1, 2, 3])], "a.mp3", { type: "audio/mpeg" }), "valid MP3"],
  ])("rejects cheap invalid input before decode", async (file, message) => {
    const decode = vi.fn(async () => decoded());
    const probe = vi.fn(async () => 5);
    await expect(validateMp3File(file, decode, probe)).rejects.toThrow(message);
    expect(decode).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("preflights metadata duration before reading and decoding the whole file", async () => {
    const file = mp3();
    const readWholeFile = vi.spyOn(file, "arrayBuffer");
    const decode = vi.fn(async () => decoded());
    const probe = vi.fn(async () => SPEC_MAX_SOURCE_SECONDS + 0.001);

    await expect(validateMp3File(file, decode, probe)).rejects.toThrow("10 minutes");
    expect(probe).toHaveBeenCalledOnce();
    expect(readWholeFile).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it("passes the original full-file ArrayBuffer to the decoder without copying it", async () => {
    const file = mp3();
    const bytes = await file.arrayBuffer();
    vi.spyOn(file, "arrayBuffer").mockResolvedValue(bytes);
    const decode = vi.fn(async () => decoded());

    await validateMp3File(file, decode, async () => 5);

    expect(decode).toHaveBeenCalledWith(bytes);
  });

  it("rejects metadata failure, decode failure, decoded long sources and unsupported channels", async () => {
    await expect(validateMp3File(mp3(), async () => decoded(), async () => { throw new Error(); }))
      .rejects.toThrow("duration");
    await expect(validateMp3File(mp3(), async () => { throw new Error(); }, async () => 5))
      .rejects.toThrow("decoded");
    await expect(validateMp3File(mp3(), async () => decoded(SPEC_MAX_SOURCE_SECONDS + 0.001), async () => 5))
      .rejects.toThrow("10 minutes");
    await expect(validateMp3File(mp3(), async () => decoded(1, 3), async () => 1))
      .rejects.toThrow("mono or stereo");
  });
});

describe("audio metadata duration probe", () => {
  it("loads metadata through an object URL without real media playback", async () => {
    const revoked: string[] = [];
    const audio = {
      src: "",
      preload: "" as HTMLAudioElement["preload"],
      duration: 12.5,
      onloadedmetadata: null as (() => void) | null,
      onerror: null as (() => void) | null,
      load: vi.fn(() => audio.onloadedmetadata?.()),
    };

    await expect(probeAudioDuration(
      new Blob(["audio"]),
      () => audio,
      () => "blob:metadata",
      (url) => revoked.push(url),
    )).resolves.toBe(12.5);
    expect(audio.preload).toBe("metadata");
    expect(audio.load).toHaveBeenCalledOnce();
    expect(revoked).toEqual(["blob:metadata"]);
  });
});
