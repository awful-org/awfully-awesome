<script module lang="ts">
  import { PLAYER_ORIGIN } from "./anilist";

  /** What the embed tells the page, narrowed to the fields the party reads.
   *  See zokoanime.video/docs, "Player Events". */
  export interface PlayerEvent {
    type: string;
    position?: number;
    duration?: number;
    paused?: boolean;
    muted?: boolean;
  }

  function finiteNonNegative(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  }

  /**
   * A postMessage, if it is the embed speaking, else null.
   *
   * The origin is checked as well as the channel: any frame on the page can
   * post `{ channel: "zokoanime" }`, and a forged "ended" would skip the
   * party's episode for everybody. The caller also checks that the message
   * came from its OWN iframe, so the card's and the tile's players never
   * answer each other's events.
   */
  export function readPlayerEvent(event: {
    origin: string;
    data: unknown;
  }): PlayerEvent | null {
    if (event.origin !== PLAYER_ORIGIN) return null;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return null;
    if (data.channel !== "zokoanime" || typeof data.type !== "string")
      return null;
    return {
      type: data.type,
      position: finiteNonNegative(data.position),
      duration: finiteNonNegative(data.duration),
      paused: typeof data.paused === "boolean" ? data.paused : undefined,
      muted: typeof data.muted === "boolean" ? data.muted : undefined,
    };
  }

  /**
   * Where the embed's playhead is now, from its last report. The embed
   * reports a few times a second while playing, but a postMessage reply is
   * never instant, so a reading between reports is projected forward rather
   * than handed out stale - the drift law would otherwise see a few hundred
   * milliseconds of drift that is not there.
   */
  export function projectedReport(
    report: { position: number; at: number; paused: boolean },
    now: number,
    duration: number
  ): number {
    const elapsed = report.paused ? 0 : Math.max(0, now - report.at) / 1_000;
    const at = report.position + elapsed;
    return duration > 0 ? Math.min(at, duration) : at;
  }

  export interface EmbedReport {
    position: number;
    at: number;
    paused: boolean;
    /** The last "time" position since anything else was heard, or null. */
    lastTime: number | null;
  }

  /**
   * What a "time" or "seeked" event says about the embed. A "time" event is
   * NOT proof of playback: the embed sends a few of them around a seek made
   * while paused, all at the seek target, and not always after the
   * "seeked". Taking each one as "playing" made the projected position run
   * on through a pause - the seek bar kept counting, and the next play sent
   * that inflated position to the whole party.
   *
   * So the embed is playing when two "time" reports in a row move forward
   * by a plausible tick, and otherwise is whatever the last play, pause or
   * state said. Any other event breaks the run: a "seeked" moves the
   * playhead without saying anything about playback either way.
   */
  export function nextReport(
    prev: EmbedReport | null,
    type: "time" | "seeked",
    position: number,
    now: number
  ): EmbedReport {
    const was = prev?.paused ?? true;
    if (type === "seeked")
      return { position, at: now, paused: was, lastTime: null };
    const last = prev?.lastTime ?? null;
    const moving = last !== null && position > last && position - last < 2;
    return { position, at: now, paused: moving ? false : was, lastTime: position };
  }

  /** A report from an event that names playback outright (play, pause,
   *  state, ready): it starts a fresh run of "time" reports. */
  export function statedReport(
    position: number,
    paused: boolean,
    now: number
  ): EmbedReport {
    return { position, at: now, paused, lastTime: null };
  }

  interface AutoplayResumeOptions {
    isPlaying: () => boolean;
    setNeedsClick: (value: boolean) => void;
    setTimer: (callback: () => void, delay: number) => number;
    clearTimer: (timer: number) => void;
  }

  /** The slice of the embed the autoplay controller touches. */
  export interface AutoplayResumePlayer {
    isPlaying(): boolean;
    play(): void;
  }

  /**
   * The autoplay policy, handled the way waffle-party handles it, against
   * the embed instead of the YouTube iframe.
   *
   * The embed already does the first half itself: refused an unmuted play,
   * it plays muted and says so in its state. What it cannot do is play at
   * all when even that is refused, and no event fires for "the policy
   * quietly declined" - so a moment after asking for playback, either the
   * embed has reported it is moving or a click target goes up on the
   * picture. That click is a gesture on THIS page, which the iframe's
   * allow="autoplay" lets the embed use for its next play.
   */
  export function createAutoplayResumeController(
    options: AutoplayResumeOptions
  ) {
    let timer: number | null = null;

    function clear() {
      if (timer !== null) options.clearTimer(timer);
      timer = null;
    }

    function schedule(player: AutoplayResumePlayer) {
      clear();
      timer = options.setTimer(() => {
        timer = null;
        if (options.isPlaying() && !player.isPlaying())
          options.setNeedsClick(true);
      }, 2_000);
    }

    return {
      schedule,
      onPlaying() {
        clear();
        options.setNeedsClick(false);
      },
      resume(player: AutoplayResumePlayer) {
        options.setNeedsClick(false);
        player.play();
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
  import { embedUrl, type Lang } from "./anilist";

  interface Props {
    /** The show's MyAnimeList id. */
    showId: number | null;
    episode: number | null;
    /**
     * The audio language THIS viewer asked for. Local: sub and dub are two
     * different embed pages, so changing it reloads only this iframe, and
     * nothing about it reaches the room.
     */
    lang: Lang;
    playing: boolean;
    position: number;
    onPosition?: (position: number) => void;
    onDuration?: (duration: number) => void;
    onEnded?: () => void;
    onReady?: () => void;
    onPlayable?: () => void;
    onError?: (message: string) => void;
  }
  let {
    showId,
    episode,
    lang,
    playing,
    position,
    onPosition,
    onDuration,
    onEnded,
    onReady,
    onPlayable,
    onError,
  }: Props = $props();

  const src = $derived(
    showId !== null && episode !== null ? embedUrl(showId, episode, lang) : ""
  );

  let frame = $state<HTMLIFrameElement | null>(null);
  let error = $state("");
  /** The embed said "ready" for the current src; commands may be sent. */
  let ready = false;
  /** The episode's media is loaded (the embed knows its duration). The page
   *  says "ready" long before that, and a cold episode can take half a
   *  minute more, so this - not "ready" - is what onReady reports. */
  let mediaReady = false;
  let last = "";
  let disposed = false;
  let duration = 0;
  /** The embed's last word on where it is, and when that was true here. */
  let report: EmbedReport | null = null;
  let needsResumeClick = $state(false);
  /** The embed is playing without sound because the browser refused it
   *  any. Only a click INSIDE the iframe can give the sound back, so while
   *  this holds the shield steps aside and the picture takes the click. */
  let needsSound = $state(false);
  let reportedOnce = false;
  /** The playhead to restore after a reload of the SAME episode (a sub/dub
   *  switch): the new page starts at zero, the party did not. */
  let carry: { position: number; at: number } | null = null;
  let loadedSrc = "";
  /** Show and episode of loadedSrc, whatever its language. */
  let loadedEpisode = "";
  let readyTimer: number | null = null;

  const autoplayResume = createAutoplayResumeController({
    isPlaying: () => playing,
    setNeedsClick: (value) => (needsResumeClick = value),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer),
  });
  const embed: AutoplayResumePlayer = {
    isPlaying: () => !!report && !report.paused,
    play: () => command({ type: "play" }),
  };

  function command(message: Record<string, unknown>): void {
    if (!ready) return;
    frame?.contentWindow?.postMessage(
      { channel: "zokoanime", ...message },
      PLAYER_ORIGIN
    );
  }

  /**
   * Local-only alignment seek (watch-sync drift correction). Deliberately
   * NOT a shared action and deliberately not run through sync(): the props
   * tuple stays untouched, so the next prop-driven sync neither repeats nor
   * fights this.
   */
  export function seekLocal(target: number): void {
    if (!ready) return;
    const at = Math.max(0, target);
    command({ type: "seek", time: at });
    // Taken as true straight away: the "seeked" confirmation is a round trip
    // off, and a drift check in between would see the old position and ask
    // for the same seek again.
    report = statedReport(at, report?.paused ?? true, Date.now());
  }

  export function currentTime(): number {
    return report ? projectedReport(report, Date.now(), duration) : position;
  }

  function fail(message: string): void {
    if (disposed) return;
    error = message;
    onError?.(message);
  }

  function clearReadyTimer(): void {
    if (readyTimer !== null) window.clearTimeout(readyTimer);
    readyTimer = null;
  }

  function sync(): void {
    if (!ready) return;
    const next = `${src}:${playing}:${position}`;
    if (next !== last) {
      last = next;
      // Only a real disagreement moves the playhead: a seek to where the
      // embed already is still stalls the picture while it rebuffers.
      if (Math.abs(currentTime() - position) > 0.5) seekLocal(position);
    }
    // Playback state is asserted every time, changed tuple or not: a freshly
    // loaded embed starts paused even when the party never stopped.
    if (playing) {
      command({ type: "play" });
      autoplayResume.schedule(embed);
    } else {
      command({ type: "pause" });
    }
  }

  let lastHoldAt = 0;
  /**
   * The party is paused but the embed's position is moving, with no "play"
   * event to say so. The "play" handler covers the case it reports; this
   * covers the one it does not. Throttled, because "time" arrives several
   * times a second until the pause lands.
   */
  function holdPaused(): void {
    if (playing || !report || report.paused) return;
    if (Date.now() - lastHoldAt < 400) return;
    lastHoldAt = Date.now();
    command({ type: "pause" });
  }

  function noteDuration(value: number | undefined): void {
    if (value === undefined || value <= 0 || value === duration) return;
    duration = value;
    onDuration?.(value);
    if (!mediaReady) {
      mediaReady = true;
      onReady?.();
    }
  }

  function onMessage(event: MessageEvent): void {
    // Only this player's own iframe: the card and the call tile can both be
    // mounted for a moment during a handoff, each with an embed of its own.
    if (!frame || event.source !== frame.contentWindow) return;
    const message = readPlayerEvent(event);
    if (!message) return;
    noteDuration(message.duration);
    if (message.muted !== undefined) needsSound = message.muted && playing;
    switch (message.type) {
      case "ready": {
        clearReadyTimer();
        ready = true;
        error = "";
        report = statedReport(message.position ?? 0, message.paused ?? true, Date.now());
        console.info("[anime-party] player ready", { src, position, playing });
        if (carry) {
          // A sub/dub switch: land where the party is now, not where the
          // last shared tick put it.
          const elapsed = playing ? (Date.now() - carry.at) / 1_000 : 0;
          seekLocal(carry.position + elapsed);
          last = `${src}:${playing}:${position}`;
        }
        carry = null;
        sync();
        break;
      }
      case "time":
      case "seeked":
        if (message.position !== undefined)
          report = nextReport(report, message.type, message.position, Date.now());
        if (message.type === "time" && report && !report.paused) onPlayable?.();
        holdPaused();
        break;
      case "play":
        report = statedReport(currentTime(), false, Date.now());
        onPlayable?.();
        autoplayResume.onPlaying();
        // Started under a paused party: the click that gave the sound back
        // also toggled the embed's own playback. The party wins.
        if (!playing) command({ type: "pause" });
        else command({ type: "state" });
        break;
      case "pause":
        report = statedReport(currentTime(), true, Date.now());
        // The embed paused on its own: a stall, a click inside it, an unmute.
        // The party state is authoritative, so ask once for playback back and
        // let the watchdog raise the overlay if the answer is no. One attempt
        // per pause event, so a refusal cannot loop.
        if (playing) {
          window.setTimeout(() => {
            if (!disposed && playing) command({ type: "play" });
          }, 0);
          autoplayResume.schedule(embed);
        }
        break;
      case "state":
        if (message.position !== undefined && message.paused !== undefined)
          report = statedReport(message.position, message.paused, Date.now());
        break;
      case "ended":
        report = statedReport(duration || currentTime(), true, Date.now());
        onEnded?.();
        break;
      case "error":
        fail("The player could not play this episode.");
        break;
    }
  }

  function load(next: string): void {
    // A reload of the episode already playing is a sub/dub switch; keep
    // its playhead to put back once the new page is up.
    const episodeKey = `${showId}:${episode}`;
    carry =
      ready && episodeKey === loadedEpisode
        ? { position: currentTime(), at: Date.now() }
        : null;
    loadedSrc = next;
    loadedEpisode = episodeKey;
    ready = false;
    mediaReady = false;
    last = "";
    report = null;
    duration = 0;
    error = "";
    needsSound = false;
    autoplayResume.pause();
    clearReadyTimer();
    if (!next) return;
    // A missing episode is a page that never says "ready": the embed serves
    // its own "Not found" card with a 200, and nothing crosses the frame
    // boundary to say so.
    readyTimer = window.setTimeout(() => {
      readyTimer = null;
      if (ready || disposed) return;
      fail(
        lang === "eng"
          ? "This episode did not load. zokoanime may have no Dub for it, so try Sub."
          : "This episode did not load. zokoanime may not have it, or it is not answering."
      );
    }, 20_000);
  }

  // Source lifecycle. Reads src ONLY - a reload on every play, pause or
  // seek would restart the episode.
  $effect(() => {
    if (src !== loadedSrc) load(src);
  });

  $effect(() => {
    src;
    playing;
    position;
    sync();
    if (!playing) {
      autoplayResume.pause();
      needsSound = false;
    }
  });

  // While the sound is off, ask the embed for its state each second: no
  // event fires when a click inside it unmutes, and the shield has to come
  // back the moment it does.
  $effect(() => {
    if (!needsSound) return;
    const poll = window.setInterval(() => command({ type: "state" }), 1_000);
    return () => window.clearInterval(poll);
  });

  function resumePlayback(): void {
    autoplayResume.resume(embed);
  }

  onMount(() => {
    window.addEventListener("message", onMessage);
    const reporter = window.setInterval(() => {
      // A paused party does not move, so after one report there is nothing
      // to say until it plays again.
      if (!playing && reportedOnce) return;
      reportedOnce = true;
      onPosition?.(currentTime());
      onDuration?.(duration);
    }, 1_000);
    return () => {
      // The handoff between the card and the call tile is where playback
      // has been reported to die; say which player left and where it was.
      console.info("[anime-party] player unmounting", {
        src,
        position: currentTime(),
      });
      disposed = true;
      clearReadyTimer();
      autoplayResume.dispose();
      window.removeEventListener("message", onMessage);
      window.clearInterval(reporter);
    };
  });
</script>

<div class="relative">
  {#if src}
    <!-- A fresh element per source rather than a changed src attribute: an
         iframe navigation joins the page's session history (Back would walk
         the player), and a late event from the old page would read as the
         new one's. Never sandboxed: the embed refuses to run in a sandboxed
         frame. allow="autoplay" is what lets an episode change start with
         sound after the page has had a click. -->
    {#key src}
      <iframe
        bind:this={frame}
        {src}
        title="Anime player"
        allow="autoplay; fullscreen"
        class="block aspect-video min-h-[200px] w-full min-w-[200px] overflow-hidden rounded-md border border-border bg-black"
        class:pointer-events-auto={needsSound}
      ></iframe>
    {/key}
  {/if}
  {#if !needsSound}
    <!-- The embed's own controls move only this viewer. This inert shield
         takes the pointer so the party's synced controls, drawn above, are
         the only ones that act. -->
    <div class="absolute inset-0 z-10" aria-hidden="true"></div>
  {:else}
    <p
      class="pointer-events-none absolute left-1/2 top-3 z-30 w-fit max-w-[90%] -translate-x-1/2 rounded bg-black/80 px-2 py-1 text-center font-mono text-[11px] text-white"
      role="status"
    >
      Your browser started this muted. Click the video to turn the sound on.
    </p>
  {/if}
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
