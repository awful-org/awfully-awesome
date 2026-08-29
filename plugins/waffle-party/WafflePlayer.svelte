<script module lang="ts">
  let youtubeApiPromise: Promise<unknown> | null = null;

  export interface AutoplayResumePlayer {
    getPlayerState(): number;
    mute(): void;
    unMute(): void;
    setVolume(value: number): void;
    playVideo(): void;
  }

  interface AutoplayResumeOptions {
    isPlaying: () => boolean;
    volume: () => number;
    setNeedsClick: (value: boolean) => void;
    setTimer: (callback: () => void, delay: number) => number;
    clearTimer: (timer: number) => void;
  }

  export function createAutoplayResumeController(
    options: AutoplayResumeOptions
  ) {
    let timer: number | null = null;

    function clear() {
      if (timer !== null) options.clearTimer(timer);
      timer = null;
    }

    function playerIsPlaying(player: AutoplayResumePlayer | null): boolean {
      return player?.getPlayerState() === 1;
    }

    function schedule(player: AutoplayResumePlayer) {
      clear();
      timer = options.setTimer(() => {
        timer = null;
        if (options.isPlaying() && !playerIsPlaying(player))
          options.setNeedsClick(true);
      }, 1_000);
    }

    return {
      playerIsPlaying,
      prepare(player: AutoplayResumePlayer, sync: () => void) {
        if (options.isPlaying()) player.mute();
        sync();
        if (options.isPlaying()) schedule(player);
      },
      schedule,
      onPlaying(player: AutoplayResumePlayer) {
        clear();
        options.setNeedsClick(false);
        player.unMute();
        player.setVolume(options.volume());
      },
      resume(player: AutoplayResumePlayer) {
        options.setNeedsClick(false);
        clear();
        player.unMute();
        player.setVolume(options.volume());
        player.playVideo();
        schedule(player);
      },
      pause() {
        clear();
        options.setNeedsClick(false);
      },
      dispose() {
        clear();
        options.setNeedsClick(false);
      },
    };
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import ResumeOverlay from "./ResumeOverlay.svelte";

  interface Props {
    videoId: string | null;
    playlistId?: string | null;
    hidden?: boolean;
    playing: boolean;
    position: number;
    volume?: number;
    /** false = strip YouTube's own controls; only synced controls remain. */
    controls?: boolean;
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
    controls = true,
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
    getPlayerState(): number;
    mute(): void;
    unMute(): void;
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
  let needsResumeClick = $state(false);
  let reportedPlaylist = "";
  let playlistReporter: ReturnType<typeof window.setInterval> | null = null;
  const autoplayResume = createAutoplayResumeController({
    isPlaying: () => playing,
    volume: () => volume,
    setNeedsClick: (value) => (needsResumeClick = value),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer),
  });

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
    // The YT.Player object grows its API only after the iframe handshake;
    // the 1s reporter starts before that and crashed on the missing method.
    const current =
      typeof player?.getCurrentTime === "function"
        ? player.getCurrentTime()
        : undefined;
    return typeof current === "number" && Number.isFinite(current)
      ? current
      : position;
  }

  function resumePlayback() {
    if (!player) return;
    autoplayResume.resume(player);
  }

  function sync() {
    const next = `${videoId}:${playing}:${position}`;
    if (!player || !ready) return;
    player.setVolume(volume);
    if (!videoId) return;
    if (next !== last) {
      last = next;
      if (loaded !== videoId) {
        loaded = videoId;
        player.loadVideoById(videoId, position);
      } else player.seekTo(position, true);
    }
    // Playback state must be asserted even when the position tuple did not
    // change: a newly-created iframe can report the same position while still
    // paused after a renderer handoff.
    playing ? player.playVideo() : player.pauseVideo();
  }

  let reportedOnce = false;
  onMount(() => {
    const reporter = window.setInterval(() => {
      // A paused party does not move: polling the iframe every second
      // forever (two postMessage round-trips each) bought nothing after
      // the first report, even for tiles parked paused for hours.
      if (!playing && reportedOnce) return;
      reportedOnce = true;
      onPosition?.(currentTime());
      onDuration?.(
        typeof player?.getDuration === "function" ? player.getDuration() : 0
      );
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
            mute: playing ? 1 : 0,
            controls: controls ? 1 : 0,
            // No fullscreen when our controls own the surface - the native
            // fullscreen UI would expose the unsynced YouTube controls.
            fs: controls ? 1 : 0,
            disablekb: controls ? 0 : 1,
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
              } else {
                // A muted first play is permitted by autoplay policies that
                // reject an unmuted play after a page refresh.
                if (player) autoplayResume.prepare(player, sync);
              }
              // Loading a new iframe can briefly leave YouTube paused even
              // though the shared party state is still playing. Re-assert
              // playback after the initial load without changing paused
              // parties or their synchronized position.
              if (playing) {
                window.setTimeout(() => {
                  if (!disposed && playing) player?.playVideo();
                }, 0);
              }
              onReady?.();
            },
            onStateChange: (event: { data: number }) => {
              if (event.data === 0) onEnded?.();
              if (event.data === 5) reportPlaylist();
              if (event.data === 1 && playing) {
                if (player) autoplayResume.onPlaying(player);
              }
              if (event.data === 2 && playing) {
                // YouTube may pause once while an iframe is handed from the
                // card to the call. The party state is authoritative, so
                // immediately resume when it still says playing.
                window.setTimeout(() => {
                  if (!disposed && playing) player?.playVideo();
                }, 0);
                if (player) autoplayResume.schedule(player);
              }
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
      autoplayResume.dispose();
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
    if (!playing) {
      autoplayResume.pause();
    } else if (ready && player && !autoplayResume.playerIsPlaying(player)) {
      autoplayResume.schedule(player);
    }
  });

  function reportPlaylist() {
    if (!playlistId || playlistId === reportedPlaylist) return;
    // The reducer enforces QUEUE_CAP; slicing here just spares the room a
    // doomed tail of resolve batches for a multi-thousand-video playlist.
    const videoIds = (
      player?.getPlaylist().filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)) ?? []
    ).slice(0, 200);
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
  class="relative space-y-2"
>
  <div
    bind:this={mount}
    class="min-w-[200px] min-h-[200px] overflow-hidden rounded-md border border-border bg-black"
  ></div>
  <!-- YouTube controls are local-only. This inert shield consumes pointer
       input while Waffle Party's own controls render above the component. -->
  <div class="absolute inset-0 z-10" aria-hidden="true"></div>
  {#if needsResumeClick}
    <ResumeOverlay onclick={resumePlayback} />
  {/if}
  {#if error}<p class="text-xs text-destructive">{error}</p>{/if}
</div>
