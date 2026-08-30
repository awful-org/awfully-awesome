export type PreviewState = "idle" | "starting" | "playing";

type PreviewAudio = Pick<HTMLAudioElement, "src" | "volume" | "onended" | "play" | "pause">;

export class CropPreviewPlayer {
  private audio: PreviewAudio | null = null;
  private objectUrl: string | null = null;
  private generation = 0;

  constructor(
    private createAudio: () => PreviewAudio = () => new Audio(),
    private createUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
    private revokeUrl: (url: string) => void = (url) => URL.revokeObjectURL(url),
    private stateChanged: (state: PreviewState) => void = () => {},
  ) {}

  async play(blob: Blob, volume: number): Promise<void> {
    this.stopAudio();
    const generation = ++this.generation;
    this.stateChanged("starting");

    const audio = this.createAudio();
    const objectUrl = this.createUrl(blob);
    this.audio = audio;
    this.objectUrl = objectUrl;
    audio.src = objectUrl;
    audio.volume = volume;
    audio.onended = () => {
      if (this.audio !== audio) return;
      this.stopAudio();
      this.stateChanged("idle");
    };

    try {
      await audio.play();
      if (generation !== this.generation) return;
      this.stateChanged("playing");
    } catch (cause) {
      if (generation !== this.generation) return;
      this.stopAudio();
      this.stateChanged("idle");
      throw cause;
    }
  }

  stop(): void {
    ++this.generation;
    this.stopAudio();
    this.stateChanged("idle");
  }

  dispose(): void {
    this.stop();
  }

  private stopAudio(): void {
    if (this.audio) {
      this.audio.onended = null;
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.objectUrl) {
      this.revokeUrl(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
