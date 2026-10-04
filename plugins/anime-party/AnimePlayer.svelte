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
  /** How far past the embed's last report the estimate may run. Reports
   *  come several times a second while it really plays. */
  export const PROJECTION_CAP_S = 3;

  export function projectedReport(
    report: { position: number; at: number; paused: boolean },
    now: number,
    duration: number
  ): number {
    // Capped: with no report for a while the embed is stalled or stuck, not
    // playing, and running the estimate on would show progress that is not
    // happening (and hide the drift from the correction loop).
    const elapsed = report.paused
      ? 0
      : Math.min(Math.max(0, now - report.at) / 1_000, PROJECTION_CAP_S);
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

  /**
   * How long to wait for an episode's media before reloading the embed, by
   * how many reloads have already been tried; null once they are used up.
   *
   * The embed's video host can be slow enough on an episode nobody has
   * played lately that its player times out on the playlist and goes idle
   * for good: "ready", no media, every later "play" ignored. A fresh embed
   * usually starts, because the first attempt warmed the host's cache.
   */
  export function stuckRetryDelay(reloads: number): number | null {
    return [20_000, 30_000, 45_000][reloads] ?? null;
  }

  /**
   * Keeps asking the embed to play until it does.
   *
   * One "play" is not enough. Sent the moment the embed says "ready", it can
   * land before the embed's own player can act on it, and the embed then
   * swallows it: the video never loads, the party says playing, and nothing
   * ever asks again. Seen in a real two-member party - one member's embed
   * got a single early "play" and sat at its first frame for good. So while
   * the party is playing and the embed is not moving, ask again on every
   * tick.
   *
   * What it does not do is put up the "Resume playback" overlay just because
   * an episode is slow to start (a cold one can take half a minute). The
   * overlay is for the browser refusing playback, which the embed answers
   * with a "pause" straight after the "play"; two of those in a row with no
   * movement in between, and only a click on this page can help. Until that
   * click, it stops asking, so a refusal cannot become a loop.
   */
  export function createPlayAsserter(options: {
    send: (type: "play" | "state") => void;
    setNeedsClick: (value: boolean) => void;
  }) {
    let refusals = 0;
    let waitingForClick = false;
    function reset() {
      refusals = 0;
      waitingForClick = false;
      options.setNeedsClick(false);
    }
    return {
      /** The party is playing; called on every sync and every tick. */
      assert(moving: boolean) {
        if (moving || waitingForClick) return;
        options.send("play");
        options.send("state");
      },
      /** The embed moved, or started playing: nothing left to ask for. */
      moved: reset,
      /** The embed paused while the party is playing. */
      paused(moving: boolean) {
        if (moving) refusals = 0;
        refusals += 1;
        if (refusals >= 2) {
          waitingForClick = true;
          options.setNeedsClick(true);
        }
      },
      /** The viewer clicked the overlay: a gesture the next play can use. */
      clicked() {
        reset();
        options.send("play");
      },
      reset,
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
  /** The position prop the last seek was judged against, or null for "not
   *  yet on this source". */
  let lastPosition: number | null = null;
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
  /** Bumped to replace the iframe with a fresh one on the same source. */
  let reloadKey = $state(0);
  let reloads = 0;
  let readyAt = 0;
  /** A passing note on the picture (a retry under way), not an error. */
  let notice = $state("");

  const asserter = createPlayAsserter({
    send: (type) => command({ type }),
    setNeedsClick: (value) => (needsResumeClick = value),
  });

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

  /**
   * The embed is actually playing right now: it said so, and its last report
   * is fresh. A drift correction must not seek an embed that is not - a seek
   * into a stuck or stalled player shows one new frame and nothing else,
   * which looked like playback skipping every few seconds.
   */
  export function moving(): boolean {
    return !!report && !report.paused && Date.now() - report.at < 2_500;
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
    // Only a NEW position moves the playhead, never a play/pause flip on its
    // own: the paused state can arrive a moment before the position that
    // goes with it, and seeking to the old one sent a pausing member back to
    // wherever the party's last tick had been - often the episode's start.
    // And only a real disagreement: a seek to where the embed already is
    // still stalls the picture while it rebuffers.
    if (position !== lastPosition) {
      lastPosition = position;
      if (Math.abs(currentTime() - position) > 0.5) seekLocal(position);
    }
    // Playback state is asserted every time, changed tuple or not: a freshly
    // loaded embed starts paused even when the party never stopped.
    if (playing) asserter.assert(moving());
    else command({ type: "pause" });
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
      notice = "";
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
        readyAt = Date.now();
        error = "";
        report = statedReport(message.position ?? 0, message.paused ?? true, Date.now());
        console.info("[anime-party] player ready", { src, position, playing });
        if (carry) {
          // A sub/dub switch: land where the party is now, not where the
          // last shared tick put it.
          const elapsed = playing ? (Date.now() - carry.at) / 1_000 : 0;
          seekLocal(carry.position + elapsed);
          lastPosition = position;
        }
        carry = null;
        sync();
        break;
      }
      case "time":
      case "seeked":
        if (message.position !== undefined)
          report = nextReport(report, message.type, message.position, Date.now());
        if (message.type === "time" && report && !report.paused) {
          onPlayable?.();
          asserter.moved();
        }
        holdPaused();
        break;
      case "play":
        report = statedReport(currentTime(), false, Date.now());
        onPlayable?.();
        asserter.moved();
        // Started under a paused party: the click that gave the sound back
        // also toggled the embed's own playback. The party wins.
        if (!playing) command({ type: "pause" });
        else command({ type: "state" });
        break;
      case "pause":
        // The embed paused on its own: a stall, a click inside it, an unmute,
        // or the browser refusing the play. The party state is
        // authoritative: the asserter asks again on its next tick, or puts
        // up the overlay once it is clear only a click will do.
        if (playing) asserter.paused(moving());
        report = statedReport(currentTime(), true, Date.now());
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
    lastPosition = null;
    report = null;
    duration = 0;
    error = "";
    needsSound = false;
    reloads = 0;
    notice = "";
    asserter.reset();
    clearReadyTimer();
    if (!next) return;
    armReadyTimer();
  }

  /** Replace the embed with a fresh one on the same source: see
   *  stuckRetryDelay. The new page is synced from scratch when it says
   *  "ready", like the first one. */
  function reloadEmbed(): void {
    reloads += 1;
    notice = `The video host is slow to start this episode. Trying again (${reloads}/3)…`;
    console.info("[anime-party] embed had no media, reloading", { src, reloads });
    ready = false;
    mediaReady = false;
    lastPosition = null;
    report = null;
    duration = 0;
    asserter.reset();
    clearReadyTimer();
    armReadyTimer();
    reloadKey += 1;
  }

  /** The party is playing: has the embed been sitting without media for
   *  longer than the current retry allows? */
  function checkStuck(): void {
    if (!ready || mediaReady || disposed || error) return;
    const waited = Date.now() - readyAt;
    const wait = stuckRetryDelay(reloads);
    if (wait !== null) {
      if (waited > wait) reloadEmbed();
    } else if (waited > 45_000) {
      notice = "";
      fail(
        "zokoanime's video host did not start this episode. Try again in a minute, or pick another episode."
      );
    }
  }

  function armReadyTimer(): void {
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
      asserter.reset();
      needsSound = false;
    }
  });

  // The asserter's tick: while the party plays and the embed has not
  // started (or has stopped) moving, ask again every two seconds.
  $effect(() => {
    if (!playing) return;
    const tick = window.setInterval(() => {
      if (ready && !disposed) asserter.assert(moving());
      checkStuck();
    }, 2_000);
    return () => window.clearInterval(tick);
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
    asserter.clicked();
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
      asserter.reset();
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
    {#key `${src}#${reloadKey}`}
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
  {#if notice && !error}
    <p
      class="pointer-events-none absolute bottom-3 left-1/2 z-30 w-fit max-w-[90%] -translate-x-1/2 rounded bg-black/80 px-2 py-1 text-center font-mono text-[11px] text-white"
      role="status"
    >
      {notice}
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
