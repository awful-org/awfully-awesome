<script module lang="ts">
  let youtubeApiPromise: Promise<unknown> | null = null;
</script>

<script lang="ts">
  import { onMount } from "svelte";

  interface Props {
    videoId: string | null;
    playlistId?: string | null;
    hidden?: boolean;
    playing: boolean;
    position: number;
    volume?: number;
    onPosition?: (position: number) => void;
    onDuration?: (duration: number) => void;
    onEnded?: () => void;
    onReady?: () => void;
    onPlayable?: () => void;
    onError?: () => void;
    onPlaylist?: (videoIds: string[]) => void;
  }
  let {
    videoId,
    playlistId = null,
    hidden = false,
    playing,
    position,
    volume = 100,
    onPosition,
    onDuration,
    onEnded,
    onReady,
    onPlayable,
    onError,
    onPlaylist,
  }: Props = $props();
  interface WaffleEmbedPlayer {
    loadVideoById(id: string, position?: number): void;
    seekTo(position: number, allowSeekAhead: boolean): void;
    playVideo(): void;
    pauseVideo(): void;
    getCurrentTime(): number;
    getDuration(): number;
    setVolume(value: number): void;
    getIframe(): HTMLIFrameElement;
    destroy(): void;
    cuePlaylist(options: { listType: "playlist"; list: string }): void;
    getPlaylist(): string[];
  }
  interface WaffleEmbedApi {
    Player: new (
      element: HTMLElement,
      options: Record<string, unknown>
    ) => WaffleEmbedPlayer;
  }
  declare global {
    interface Window {
      YT?: WaffleEmbedApi;
      onYouTubeIframeAPIReady?: () => void;
    }
  }

  let mount: HTMLDivElement;
  let player: WaffleEmbedPlayer | null = null;
  let error = $state("");
  let last = "";

  let ready = false;
  let loaded = "";
  let disposed = false;
  let reportedPlaylist = "";
  let playlistReporter: ReturnType<typeof window.setInterval> | null = null;

  function loadApi(): Promise<WaffleEmbedApi> {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (youtubeApiPromise) return youtubeApiPromise as Promise<WaffleEmbedApi>;
    youtubeApiPromise = new Promise<WaffleEmbedApi>((resolve, reject) => {
      const finish = () =>
        window.YT?.Player
          ? resolve(window.YT)
          : reject(new Error("YouTube API unavailable"));
      const prior = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prior?.();
        finish();
      };
      const script = document.querySelector<HTMLScriptElement>(
        'script[src="https://www.youtube.com/iframe_api"]'
      );
      if (!script) {
        const next = document.createElement("script");
        next.src = "https://www.youtube.com/iframe_api";
        next.onerror = () => reject(new Error("YouTube API failed to load"));
        document.head.append(next);
      }
      if (window.YT?.Player) finish();
    });
    return youtubeApiPromise as Promise<WaffleEmbedApi>;
  }

  export function currentTime(): number {
    const current = player?.getCurrentTime();
    return typeof current === "number" && Number.isFinite(current)
      ? current
      : position;
  }

  function sync() {
    const next = `${videoId}:${playing}:${position}`;
    if (!player || !ready) return;
    player.setVolume(volume);
    if (!videoId) return;
    if (next === last) return;
    last = next;
    if (loaded !== videoId) {
      loaded = videoId;
      player.loadVideoById(videoId, position);
    } else player.seekTo(position, true);
    playing ? player.playVideo() : player.pauseVideo();
  }

  onMount(() => {
    const reporter = window.setInterval(() => {
      onPosition?.(currentTime());
      onDuration?.(player?.getDuration() ?? 0);
    }, 1_000);
    void loadApi()
      .then((YT) => {
        if (disposed) return;
        player = new YT.Player(mount, {
          width: "100%",
          height: "200",
          ...(videoId ? { videoId } : {}),
          playerVars: {
            playsinline: 1,
            controls: 1,
            fs: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              ready = true;
              player?.getIframe().setAttribute("allowfullscreen", "");
              if (playlistId) {
                player?.cuePlaylist({ listType: "playlist", list: playlistId });
                playlistReporter = window.setInterval(reportPlaylist, 250);
                reportPlaylist();
              } else sync();
              onReady?.();
            },
            onStateChange: (event: { data: number }) => {
              if (event.data === 0) onEnded?.();
              if (event.data === 5) reportPlaylist();
              if (event.data === 1 || event.data === 2 || event.data === 5)
                onPlayable?.();
            },
            onError: () => {
              error = "The YouTube player could not play this video.";
              onError?.();
            },
          },
        });
      })
      .catch(() => {
        error = "The YouTube player could not load on this device.";
        onError?.();
      });
    return () => {
      disposed = true;
      window.clearInterval(reporter);
      if (playlistReporter) window.clearInterval(playlistReporter);
      player?.destroy();
    };
  });
  $effect(() => {
    videoId;
    playing;
    position;
    volume;
    sync();
  });

  function reportPlaylist() {
    if (!playlistId || playlistId === reportedPlaylist) return;
    const videoIds =
      player?.getPlaylist().filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)) ??
      [];
    if (!videoIds.length) return;
    reportedPlaylist = playlistId;
    if (playlistReporter) window.clearInterval(playlistReporter);
    onPlaylist?.(videoIds);
  }
</script>

<div
  class:fixed={hidden}
  class:pointer-events-none={hidden}
  class:opacity-0={hidden}
  class:-z-50={hidden}
  class="space-y-2"
>
  <div
    bind:this={mount}
    class="min-w-[200px] min-h-[200px] overflow-hidden rounded-md border border-border bg-black"
  ></div>
  {#if error}<p class="text-xs text-destructive">{error}</p>{/if}
</div>
