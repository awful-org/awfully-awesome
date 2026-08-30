import { describe, expect, it, vi } from "vitest";
import { CropPreviewPlayer, type PreviewState } from "./preview";

class AudioMock {
  src = "";
  volume = 1;
  onended: (() => void) | null = null;
  play: ReturnType<typeof vi.fn<() => Promise<void>>>;
  pause = vi.fn();

  constructor(play: () => Promise<void>) {
    this.play = vi.fn(play);
  }
}

function setup(play: () => Promise<void> = async () => undefined) {
  const audios: AudioMock[] = [];
  const states: PreviewState[] = [];
  const revoked: string[] = [];
  const player = new CropPreviewPlayer(
    () => {
      const audio = new AudioMock(play);
      audios.push(audio);
      return audio;
    },
    () => `blob:preview-${audios.length}`,
    (url) => revoked.push(url),
    (state) => states.push(state),
  );
  return { audios, player, revoked, states };
}

describe("CropPreviewPlayer", () => {
  it("plays the rendered crop at its selected volume", async () => {
    const { audios, player, states } = setup();
    await player.play(new Blob(["crop"]), 0.35);
    expect(audios[0].src).toBe("blob:preview-1");
    expect(audios[0].volume).toBe(0.35);
    expect(audios[0].play).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe("playing");
  });

  it("replaces an active preview and revokes its temporary URL", async () => {
    const { audios, player, revoked } = setup();
    await player.play(new Blob(["first"]), 1);
    await player.play(new Blob(["second"]), 1);
    expect(audios[0].pause).toHaveBeenCalledOnce();
    expect(revoked).toEqual(["blob:preview-1"]);
    expect(audios[1].play).toHaveBeenCalledOnce();
  });

  it("cancels a preview while browser playback is pending", async () => {
    let release!: () => void;
    const { audios, player, states } = setup(
      () => new Promise<void>((resolve) => { release = resolve; })
    );
    const pending = player.play(new Blob(["crop"]), 1);
    player.stop();
    release();
    await pending;
    expect(audios[0].pause).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe("idle");
  });

  it("returns to idle and releases the URL when playback is rejected", async () => {
    const { player, revoked, states } = setup(async () => { throw new Error("blocked"); });
    await expect(player.play(new Blob(["crop"]), 1)).rejects.toThrow("blocked");
    expect(revoked).toEqual(["blob:preview-1"]);
    expect(states.at(-1)).toBe("idle");
  });
});
