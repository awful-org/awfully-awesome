export type PreviewState = "idle" | "starting" | "playing";

type PreviewContext = Pick<
  AudioContext,
  "state" | "destination" | "resume" | "createBufferSource" | "close"
>;

export class CropPreviewPlayer {
  private context: PreviewContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private generation = 0;

  constructor(
    private createContext: () => PreviewContext = () => new AudioContext(),
    private stateChanged: (state: PreviewState) => void = () => {},
  ) {}

  async play(buffer: AudioBuffer, start: number, duration: number): Promise<void> {
    this.stopSource();
    const generation = ++this.generation;
    this.stateChanged("starting");

    try {
      this.context ??= this.createContext();
      if (this.context.state === "suspended") await this.context.resume();
      if (generation !== this.generation) return;

      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      source.onended = () => {
        if (this.source !== source) return;
        source.disconnect();
        this.source = null;
        this.stateChanged("idle");
      };
      this.source = source;
      source.start(0, start, duration);
      this.stateChanged("playing");
    } catch (cause) {
      if (generation === this.generation) this.stateChanged("idle");
      throw cause;
    }
  }

  stop(): void {
    ++this.generation;
    this.stopSource();
    this.stateChanged("idle");
  }

  dispose(): void {
    this.stop();
    void this.context?.close();
    this.context = null;
  }

  private stopSource(): void {
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    source.onended = null;
    try { source.stop(); } catch {}
    source.disconnect();
  }
}
