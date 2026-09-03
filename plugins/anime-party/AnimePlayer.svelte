<script module lang="ts">
  import { streamUrl } from "$lib/plugins/api";

  /**
   * Where hls.js must actually send a request.
   *
   * hls.anidb.app pins CORS to its own origin, so nothing the page fetches
   * from it can be read: the master playlist, every variant playlist and
   * every segment ride the instance's streaming relay instead. Called per
   * request rather than hoisted, because the api origin is read from
   * /config.json after load and there is nothing to inline.
   *
   * Anything that is not the provider's stream host throws instead of being
   * proxied. hls.js answers a throwing xhrSetup by opening the request
   * plainly against the original url, which fails loudly on CORS - much
   * better than the relay being asked to fetch a hostname somebody else
   * chose, including its own.
   */
  const STREAM_HOST_PREFIX = "https://hls.anidb.app/";

  export function proxiedLoaderUrl(url: string): string {
    if (!url.startsWith(STREAM_HOST_PREFIX))
      throw new Error(`refusing to proxy ${url}`);
    return streamUrl(url);
  }

  /** The slice of a media element the autoplay controller touches. */
  export interface AutoplayResumeVideo {
    paused: boolean;
    ended: boolean;
    muted: boolean;
    volume: number;
    play(): Promise<void>;
  }

  /**
   * Is this element actually moving? There is no YouTube state number here:
   * a media element is playing when it is neither paused nor finished.
   * `play()` resolving is not the same fact - it resolves for a muted
   * element the policy then stalls.
   */
  function errName(err: unknown): string {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  export function videoIsPlaying(video: AutoplayResumeVideo | null): boolean {
    return !!video && !video.paused && !video.ended;
  }

  /** 0..100 party-local preference to the element's own 0..1 scale. */
  export function elementVolume(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.min(1, Math.max(0, value / 100));
  }

  interface AutoplayResumeOptions {
    isPlaying: () => boolean;
    /** The viewer's volume preference, 0..100. */
    volume: () => number;
    setNeedsClick: (value: boolean) => void;
    setTimer: (callback: () => void, delay: number) => number;
    clearTimer: (timer: number) => void;
  }

  /**
   * The autoplay policy, handled the way waffle-party handles it, against a
   * media element instead of the YouTube iframe.
   *
   * The shape is the same because the problem is: after a refresh the
   * browser refuses an unmuted play, and a party that says "playing" must
   * not sit silently on a still frame. So play optimistically, fall back to
   * a MUTED play (which the policy does permit), restore the sound the
   * moment playback is real, and if even the muted attempt is refused put a
   * click target on the picture - one gesture unmutes and plays.
   *
   * The watchdog exists because no event fires for "the policy quietly
   * declined": a second after asking for playback, either the element is
   * moving or the overlay goes up.
   */
  export function createAutoplayResumeController(
    options: AutoplayResumeOptions
  ) {
    let timer: number | null = null;

    function clear() {
      if (timer !== null) options.clearTimer(timer);
      timer = null;
    }

    function restoreAudio(video: AutoplayResumeVideo) {
      video.muted = false;
      video.volume = elementVolume(options.volume());
    }

    function schedule(video: AutoplayResumeVideo) {
      clear();
      timer = options.setTimer(() => {
        timer = null;
        if (options.isPlaying() && !videoIsPlaying(video))
          options.setNeedsClick(true);
      }, 1_000);
    }

    return {
      playerIsPlaying: videoIsPlaying,
      /** Ask for playback, muting only as far as the policy forces. */
      async attempt(video: AutoplayResumeVideo) {
        clear();
        try {
          await video.play();
        } catch (err) {
          // NotAllowedError. A muted play is permitted where an unmuted one
          // is not, so take it and let onPlaying give the sound back.
          console.warn("[anime-party] play refused, retrying muted:", errName(err));
          video.muted = true;
          try {
            await video.play();
          } catch (err2) {
            console.warn("[anime-party] muted play refused too:", errName(err2));
            options.setNeedsClick(true);
            return;
          }
        }
        if (options.isPlaying()) schedule(video);
      },
      schedule,
      onPlaying(video: AutoplayResumeVideo) {
        clear();
        options.setNeedsClick(false);
        restoreAudio(video);
        // Unmuting a muted autoplay can itself PAUSE playback in some
        // browsers - and this is the last watchdog standing, so the party
        // would die silently with no resume overlay. Re-arm it: if playback
        // survives the unmute the check passes, if not the overlay shows.
        schedule(video);
      },
      resume(video: AutoplayResumeVideo) {
        options.setNeedsClick(false);
        clear();
        restoreAudio(video);
        void video.play().catch((err) => {
          console.warn("[anime-party] resume refused:", errName(err));
          options.setNeedsClick(true);
        });
        schedule(video);
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
  import Hls from "hls.js";
  import ResumeOverlay from "./ResumeOverlay.svelte";
  import { masterUrl, UpstreamDownError, type Lang } from "./anidb";

  interface Props {
    episodeId: number | null;
    /**
     * The audio language THIS viewer asked for. Local: sub and dub are two
     * different files upstream, so changing it re-resolves and reloads only
     * this element, and nothing about it reaches the room.
     */
    lang: Lang;
    hidden?: boolean;
    playing: boolean;
    position: number;
    volume?: number;
    onPosition?: (position: number) => void;
    onDuration?: (duration: number) => void;
    onEnded?: () => void;
    onReady?: () => void;
    onPlayable?: () => void;
    onError?: (message: string) => void;
    /** What actually played, which is not always what was asked for: an
     *  episode can exist in one audio language only. */
    onResolvedLang?: (lang: Lang) => void;
  }
  let {
    episodeId,
    lang,
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
    onResolvedLang,
  }: Props = $props();

  let video = $state<HTMLVideoElement | null>(null);
  let hls: Hls | null = null;
  let error = $state("");
  let last = "";
  /** `${episodeId}:${lang}` currently being resolved; a late answer for an
   *  older key is dropped rather than attached over the newer one. */
  let requestedKey = "";
  /** A source is attached and sync() may act on the element. */
  let ready = false;
  /** Where the element should be as soon as it can seek at all. */
  let pendingSeek: number | null = null;
  let disposed = false;
  let needsResumeClick = $state(false);
  let reportedOnce = false;
  const autoplayResume = createAutoplayResumeController({
    isPlaying: () => playing,
    volume: () => volume,
    setNeedsClick: (value) => (needsResumeClick = value),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer),
  });

  /**
   * Local-only alignment seek (watch-sync drift correction). Deliberately
   * NOT a shared action and deliberately not run through sync(): the props
   * tuple stays untouched, so the next prop-driven sync neither repeats nor
   * fights this.
   */
  export function seekLocal(target: number): void {
    if (!video || !ready) return;
    const at = Math.max(0, target);
    // A freshly attached element has no media source to seek IN yet, and
    // the assignment either throws or is silently dropped. The party's
    // position would then be lost for good, because the props tuple has
    // already been recorded as applied - so park it for loadedmetadata.
    if (video.readyState === 0) {
      pendingSeek = at;
      return;
    }
    try {
      video.currentTime = at;
      pendingSeek = null;
    } catch {
      pendingSeek = at;
    }
  }

  /** The media element, for the host's picture-in-picture surfaces. */
  export function element(): HTMLVideoElement | null {
    return video;
  }

  export function currentTime(): number {
    const current = video?.currentTime;
    return typeof current === "number" && Number.isFinite(current)
      ? current
      : position;
  }

  /**
   * The rate lane of the watch library's control law, which waffle-party
   * could not use: the YouTube iframe rounds fractional rates to its own
   * discrete steps, a media element honours them exactly. A 5% nudge closes
   * a second of drift without the jump a seek costs.
   */
  export function setRate(rate: number): void {
    if (!video || !Number.isFinite(rate) || rate <= 0) return;
    if (video.playbackRate !== rate) video.playbackRate = rate;
  }

  function fail(key: string, message: string): void {
    if (disposed || key !== requestedKey) return;
    error = message;
    onError?.(message);
  }

  function teardown(): void {
    hls?.destroy();
    hls = null;
    ready = false;
    last = "";
    pendingSeek = null;
    if (!video) return;
    video.removeAttribute("src");
    // Without the reload the element keeps the old buffer (and keeps
    // decoding it) after the episode changed.
    video.load();
  }

  /** anidb.app itself is not answering; say so rather than "could not load". */
  function downMessage(status: number): string {
    return `anidb.app is probably down${status ? ` (it answered ${status})` : ""}. Nothing here is broken; try again in a few minutes.`;
  }

  async function load(key: string, id: number | null, want: Lang) {
    teardown();
    requestedKey = key;
    error = "";
    if (id === null) return;
    let resolved: Awaited<ReturnType<typeof masterUrl>>;
    try {
      resolved = await masterUrl(id, want);
    } catch (err) {
      fail(
        key,
        err instanceof UpstreamDownError
          ? downMessage(err.status)
          : "Could not load the stream."
      );
      return;
    }
    if (disposed || key !== requestedKey) return;
    if (!resolved) {
      fail(key, "No stream found for this episode.");
      return;
    }
    onResolvedLang?.(resolved.lang);
    attach(key, resolved.url);
  }

  function attach(key: string, master: string): void {
    if (!video) return;
    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        // Start at the lowest quality: anidb.app throttles a cache-cold
        // segment to ~5 KB/s, so the smallest segments are the only ones
        // that arrive fast enough to begin. ABR climbs on its own once the
        // segments are warm (Cloudflare caches them after the first pull).
        startLevel: 0,
        // Buffering is capped well under the stock 60 MB: the relay proxies
        // every segment and rate-limits per client, and with the defaults
        // hls.js pulled 94 segments in 25 seconds filling that buffer as
        // fast as the link allowed, which brushes the ceiling.
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 20 * 1000 * 1000,
        backBufferLength: 30,
        // The relay is the only way these bytes reach the page. hls.js opens
        // the request itself ONLY when xhrSetup did not (see its XhrLoader),
        // so opening it here redirects the master, every variant playlist
        // and every segment. The provider's playlists carry absolute urls,
        // so hls.js never resolves a segment against the proxied url.
        xhrSetup(xhr: XMLHttpRequest, url: string) {
          xhr.open("GET", proxiedLoaderUrl(url), true);
        },
      });
      // A fatal error is not the end: a cache-cold segment on anidb.app's
      // ~5 KB/s origin times out or arrives truncated, hls.js escalates it,
      // and simply telling the party "could not load" was the "died out of
      // nowhere" report. Retry instead - reload for a network error, recover
      // the decoder for a media error - and only give up after a run of them
      // with no progress between. FRAG_LOADED resets the counter, so a stream
      // that is merely slow recovers forever while a genuinely dead one still
      // stops. Non-fatal errors stay hls.js's own business (gap jumps, a 503
      // from the relay's concurrency ceiling, a single stalled segment).
      let fatalStreak = 0;
      // The stream proxy relays anidb.app's own 5xx; a few of those in a row
      // is the site being down, not a bad segment worth eight retries.
      let downStreak = 0;
      hls.on(Hls.Events.FRAG_LOADED, () => {
        fatalStreak = 0;
        downStreak = 0;
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        // Every error, fatal or not: a stalled party used to leave nothing
        // in the console but the network tab's own "canceled" rows.
        console.warn("[anime-party] hls error", {
          type: data.type,
          details: data.details,
          fatal: data.fatal,
          status: (data.response as { code?: number } | undefined)?.code,
          url: data.frag?.url ?? (data as { url?: string }).url,
        });
        const status = (data.response as { code?: number } | undefined)?.code;
        if (status === 502 || status === 503) {
          if (++downStreak >= 3) {
            fail(key, downMessage(status));
            return;
          }
        }
        if (!data.fatal || !hls) return;
        if (++fatalStreak > 8) {
          fail(key, "Could not load the stream.");
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else hls.startLoad();
      });
      hls.attachMedia(video);
      hls.loadSource(master);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari plays HLS natively, and a media element load is not subject
      // to CORS, so this is the one path that needs no relay at all.
      video.src = master;
    } else {
      fail(key, "This browser cannot play HLS.");
      return;
    }
    ready = true;
    console.info("[anime-party] player ready", { key, position, playing });
    onReady?.();
    sync();
  }

  function sync(): void {
    if (!video || !ready) return;
    video.volume = elementVolume(volume);
    const next = `${episodeId}:${playing}:${position}`;
    if (next !== last) {
      last = next;
      // Only a real disagreement moves the playhead: assigning currentTime
      // what it already holds still fires a seek and stutters the picture.
      if (Math.abs(video.currentTime - position) > 0.5) seekLocal(position);
    }
    // Playback state is asserted every time, changed tuple or not: a freshly
    // attached source starts paused even when the party never stopped.
    if (playing) void autoplayResume.attempt(video);
    else video.pause();
  }

  /**
   * The browser paused on its own: an unmute after a muted autoplay, a
   * decoder hiccup, a renderer handoff. The party state is authoritative,
   * so ask once for playback back and let the watchdog raise the overlay if
   * the answer is no. One attempt per pause event, so a refusal cannot loop.
   */
  function reassertPlayback(): void {
    if (!video) return;
    const el = video;
    window.setTimeout(() => {
      if (disposed || !playing || !el.paused) return;
      void el.play().catch(() => {});
    }, 0);
    autoplayResume.schedule(el);
  }

  function resumePlayback(): void {
    if (video) autoplayResume.resume(video);
  }

  /**
   * The element learned how long the media is. The 1s reporter is not enough
   * on its own: it goes quiet after one report while the party is paused, so
   * somebody joining a paused party mid-load would never hear a duration and
   * whatever waits on it - the card and tile handoff - would never release.
   * Only a real number travels; a 0 or a NaN says nothing.
   */
  function reportDuration(): void {
    const d = video?.duration;
    if (typeof d === "number" && Number.isFinite(d) && d > 0) onDuration?.(d);
  }

  // Source lifecycle. Reads episodeId and lang ONLY - a re-resolve on every
  // play, pause or seek would tear the stream down mid-episode.
  $effect(() => {
    const key = `${episodeId}:${lang}`;
    if (key === requestedKey) return;
    void load(key, episodeId, lang);
  });

  $effect(() => {
    episodeId;
    playing;
    position;
    volume;
    sync();
    if (!playing) {
      autoplayResume.pause();
    } else if (ready && video && !autoplayResume.playerIsPlaying(video)) {
      autoplayResume.schedule(video);
    }
  });

  onMount(() => {
    const reporter = window.setInterval(() => {
      // A paused party does not move, so after one report there is nothing
      // to say until it plays again.
      if (!playing && reportedOnce) return;
      reportedOnce = true;
      onPosition?.(currentTime());
      const d = video?.duration;
      onDuration?.(typeof d === "number" && Number.isFinite(d) ? d : 0);
    }, 1_000);
    return () => {
      // The handoff between the card and the call tile is where playback
      // has been reported to die; say which player left and where it was.
      console.info("[anime-party] player unmounting", {
        key: requestedKey,
        position: currentTime(),
        paused: video?.paused ?? null,
      });
      disposed = true;
      autoplayResume.dispose();
      window.clearInterval(reporter);
      teardown();
    };
  });
</script>

<div
  class:fixed={hidden}
  class:pointer-events-none={hidden}
  class:opacity-0={hidden}
  class:-z-50={hidden}
  class="relative space-y-2"
>
  <!-- No native controls: every transport control on this surface is a
       SYNCED one, and the browser's would move only this viewer. No pointer
       shield either - unlike an iframe there is nothing underneath to
       click. -->
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    bind:this={video}
    playsinline
    class="min-h-[200px] w-full min-w-[200px] overflow-hidden rounded-md border border-border bg-black"
    onloadedmetadata={() => {
      reportDuration();
      // The element can finally seek: land the position sync could not.
      if (pendingSeek === null) return;
      const target = pendingSeek;
      pendingSeek = null;
      seekLocal(target);
    }}
    ondurationchange={() => reportDuration()}
    onplaying={() => {
      onPlayable?.();
      if (playing && video) autoplayResume.onPlaying(video);
    }}
    oncanplay={() => onPlayable?.()}
    onpause={() => {
      // Browsers fire pause right before ended; asking for playback back
      // there would restart the episode from zero while the party is
      // folding the skip to the next one.
      if (!disposed && playing && !video?.ended) reassertPlayback();
    }}
    onended={() => onEnded?.()}
    onerror={() => {
      // Emptying the element on an episode change fires this too; only a
      // live source failing is worth telling the party about.
      if (ready) fail(requestedKey, "Could not load the stream.");
    }}
  ></video>
  {#if needsResumeClick}
    <ResumeOverlay onclick={resumePlayback} />
  {/if}
  {#if error}
    <!-- Centred on the picture, on both surfaces this player renders in: a
         small line under the video was easy to miss in a call tile, and it
         read as the player being broken rather than the source. -->
    <div
      class="pointer-events-none absolute inset-0 z-30 grid place-items-center bg-black/60 p-4 text-center"
      role="alert"
    >
      <p class="max-w-xs rounded-md bg-black/80 px-3 py-2 font-mono text-xs leading-relaxed text-white">
        {error}
      </p>
    </div>
  {/if}
</div>
