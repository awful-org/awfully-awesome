<script lang="ts">
  import { untrack } from "svelte";
  import { LogIn } from "@lucide/svelte";
  import type { HostApi } from "$lib/plugins/api";
  import type { Message } from "$lib/transport/transport.svelte";
  import { watchKeyIntent, type Correction } from "$lib/plugins/watch";
  import { Tip } from "$lib/plugins/ui";
  import AnimePlayer from "./AnimePlayer.svelte";
  import AnimeSyncedControls from "./AnimeSyncedControls.svelte";
  import {
    initialState,
    seekTarget,
    stateTick,
    syncResponder,
    syncResponderFor,
    type AnimeState,
  } from "./logic";
  import { episodes as fetchEpisodes, type Episode, type Lang } from "./anilist";
  import { episodeLabel } from "./titles";
  import { driftCorrection, projectedTickPosition } from "./watch-drift";
  import { clockEstimateFor, ensureClock } from "./clock";
  import {
    tilePresence,
    publishLiveDuration,
    publishLivePosition,
    registerPositionSource,
    parkHandoff,
    handoffIsReadyToRelease,
    takeLiveRendererControl,
  } from "./tile-presence.svelte";

  interface Props {
    card: Message;
    cardState: unknown;
    host: HostApi;
    /** The host mirrors the call chrome: controls show while the mouse
     *  moves over the call section and hide with the call's own controls. */
    chromeVisible?: boolean;
  }
  let { card, cardState, host, chromeVisible = true }: Props = $props();
  // cardState can transiently be undefined (a mid-build state read); an
  // empty party renders inert instead of throwing on every field access.
  const anime = $derived(
    (cardState as AnimeState | undefined) ?? initialState(null)
  );

  const selfDid = untrack(() => host.selfDid());
  const joined = $derived(anime.members.has(selfDid));
  const current = $derived(
    anime.currentIndex === null ? null : anime.queue[anime.currentIndex]
  );
  /** The renderer-handoff key for the playing episode. */
  const currentKey = $derived(current ? String(current.number) : null);

  // The show's full episode list, so Next and Previous walk the SHOW, not
  // just the queue. Same cached, deduped episodes() call the card uses.
  let episodeList = $state<Episode[]>([]);
  let episodesLoadedFor: number | null = null;
  $effect(() => {
    const showId = anime.show?.id;
    if (!joined || !showId || showId === episodesLoadedFor) return;
    episodesLoadedFor = showId;
    episodeList = [];
    void fetchEpisodes(showId)
      .then((list) => {
        episodeList = list;
      })
      .catch(() => {
        // Navigation still works off whatever is queued; the list is a
        // best-effort enrichment, not a hard dependency.
      });
  });
  /** The next episode in the show's full list - the smallest number strictly
   *  above the one playing - or null when already on the latest. */
  function nextEpisode(): Episode | null {
    if (!current) return null;
    let best: Episode | null = null;
    for (const ep of episodeList) {
      if (ep.number > current.number && (best === null || ep.number < best.number))
        best = ep;
    }
    return best;
  }
  /** The previous episode - the largest number strictly below the one
   *  playing - or null. */
  function prevEpisode(): Episode | null {
    if (!current) return null;
    let best: Episode | null = null;
    for (const ep of episodeList) {
      if (ep.number < current.number && (best === null || ep.number > best.number))
        best = ep;
    }
    return best;
  }
  const atLatest = $derived(
    current != null &&
      episodeList.length > 0 &&
      current.number >= Math.max(...episodeList.map((e) => e.number))
  );

  let player = $state<AnimePlayer | null>(null);

  // This tile content only mounts after the user CLICKED the grid tile to
  // join it (click-to-join like screen shares) - that click is the intent,
  // so join the party too instead of showing a second Join button.
  let autoJoined = false;
  $effect(() => {
    if (autoJoined || joined || !currentKey || anime.closed) return;
    autoJoined = true;
    void send({ action: "join" });
  });
  // Sub or dub, this device's own: read from plugin storage, toggled from
  // the chrome, never sent to the room.
  let lang = $state<Lang>("jpn");
  let localPosition = $state(0);
  let duration = $state(0);
  let lastDriftSeekAt = 0;
  // Keep a fresh clock offset to whoever wrote the current tick, so its
  // position projects onto this machine's clock.
  $effect(() => {
    if (anime.tickBy && anime.tickBy !== selfDid) ensureClock(host, anime.tickBy);
  });
  // Where the party is RIGHT NOW per the tick, not where it was when the
  // tick was written. Recomputed ONLY when the tick itself changes, never on
  // unrelated state folds: anime is a fresh object per fold, and a $derived
  // reading Date.now() would mint a new projected value on every join or
  // activity line - each one a changed position prop, each one a seek.
  // svelte-ignore state_referenced_locally -- seeded once; the effect below
  // takes over. Seeding matters: effects run after mount, and the player is
  // constructed with this prop's mount-time value.
  let syncPosition = $state(untrack(() => anime.position));
  let lastTickKey = "";
  $effect(() => {
    const key = `${anime.tickAtMs}|${anime.tickBy}|${anime.position}|${anime.playing}|${anime.currentIndex}`;
    if (key === lastTickKey) return;
    lastTickKey = key;
    syncPosition =
      projectedTickPosition(
        stateTick(anime),
        clockEstimateFor(anime.tickBy),
        anime.tickBy === selfDid,
        Date.now()
      ) ?? anime.position;
  });
  let playerLoading = $state(true);
  let activeResyncId = $state<string | null>(null);
  // Consume a parked card position only once when this renderer takes over.
  // Keeping peekHandoff() in the player prop would pin the element to the
  // parked timestamp and prevent later shared seek actions from reaching it.
  let handoffPosition = $state<number | null>(null);
  let handoffConsumed = $state(false);
  // Seeded from the current episode; the effect below keeps it in step, so
  // this initial read is deliberately untracked.
  let handoffEpisode = $state<string | null>(untrack(() => currentKey));
  $effect(() => {
    if (currentKey === handoffEpisode) return;
    handoffEpisode = currentKey;
    handoffPosition = null;
    playerLoading = true;
    activeResyncId = null;
  });
  $effect(() => {
    if (!joined || !currentKey) {
      handoffConsumed = false;
      return;
    }
    if (handoffConsumed) return;
    handoffConsumed = true;
    // Capture the card's live source BEFORE this tile increments presence and
    // makes the card stand down. Waiting even one microtask can miss that
    // source on the second chat -> tile transition.
    const requestId = selfDid === anime.ownerDid ? "" : crypto.randomUUID();
    const takeover = takeLiveRendererControl(
      currentKey,
      anime.position,
      selfDid,
      anime.ownerDid,
      requestId
    );
    playerLoading = true;
    handoffPosition = takeover.position;
    // Every renderer switch gets an authoritative network position too. The
    // owner publishes its captured time; listeners ask the owner to answer.
    if (takeover.update.action === "resync") activeResyncId = requestId;
    void send(takeover.update);
    syncedJoinCount = anime.activitySeq;
  });
  $effect(() => {
    const response = anime.syncResponse;
    if (
      !response ||
      response.targetDid !== selfDid ||
      response.id !== activeResyncId
    )
      return;
    activeResyncId = null;
    handoffPosition = anime.position;
    if (response.duration > 0) {
      duration = response.duration;
      publishLiveDuration(response.duration);
    }
  });
  $effect(() => {
    void host.storage
      .get("lang")
      .then((stored) => {
        if (stored === "jpn" || stored === "eng") lang = stored;
      })
      .catch(() => {
        // Storage is unreadable; subbed is the default either way.
      });
  });
  // Keyboard shortcuts, scoped to the call tile and only while it is focused
  // (the listener is on the tile root, so it fires only when the tile or one
  // of its controls has focus, never while a chat or search field does). The
  // arrows mirror the on-screen controls: left/right are the same synced
  // -10s / +10s the seek buttons send. Up and down are left alone: they are
  // a volume shortcut elsewhere, and the embed takes no volume command.
  function onTileKeydown(event: KeyboardEvent) {
    if (!joined || !current) return;
    const intent = watchKeyIntent(event.key);
    if (!intent || intent === "volume-up" || intent === "volume-down") return;
    event.preventDefault();
    switch (intent) {
      case "toggle-play":
        void togglePlayback();
        break;
      case "seek-back":
        void seekBy(-10);
        break;
      case "seek-forward":
        void seekBy(10);
        break;
    }
  }

  // Attached imperatively (a Svelte action) rather than as an onkeydown
  // attribute: the tile root is a non-interactive container, and wiring the
  // listener in markup trips the a11y rule for no real benefit. The action
  // makes the root focusable and listens only there, so the shortcuts stay
  // scoped to a focused tile.
  function tileKeys(node: HTMLElement) {
    node.tabIndex = 0;
    node.addEventListener("keydown", onTileKeydown);
    return {
      destroy() {
        node.removeEventListener("keydown", onTileKeydown);
      },
    };
  }
  async function toggleLang() {
    lang = lang === "jpn" ? "eng" : "jpn";
    try {
      await host.storage.set("lang", lang);
    } catch {
      // The choice just does not survive a reload.
    }
  }

  /** The seek lane of the control law only: the embed takes no playback
   *  rate, so "rate" is as good as none here (see watch-drift.ts). */
  function applyCorrection(correction: Correction | null) {
    if (!correction || !player || correction.action !== "seek") return;
    // Seeks stay rate-limited: a correction storm is worse than drift.
    if (Date.now() - lastDriftSeekAt <= 5_000) return;
    lastDriftSeekAt = Date.now();
    player.seekLocal(correction.targetPosition);
  }

  // While this tile exists, it IS the party's renderer: the chat card
  // mounts no player, shows "Rendering in the call", and skips its
  // lifecycle side effects (its unmount closing the party as the owner is
  // what froze everything the moment the owner joined a call).
  $effect(() => {
    if (!joined || !currentKey) return;
    const key = currentKey;
    // untrack: `count += 1` READS the state it writes, which makes this
    // effect depend on itself - increment, re-run, decrement, forever. That
    // loop pegged the main thread and ate every click.
    untrack(() => (tilePresence.count += 1));
    const unregister = registerPositionSource(() =>
      player ? player.currentTime() : localPosition
    );
    return () => {
      // Leaving the call: hand the live position to whichever surface
      // renders next, or the party restarts from the stale synced state.
      parkHandoff(
        key,
        player ? player.currentTime() : localPosition,
        duration,
        untrack(() => anime.playing)
      );
      unregister();
      untrack(() => (tilePresence.count -= 1));
    };
  });

  // Lock screen / media keys: the RENDERER owns the OS media surface, and
  // the handlers fire SYNCED actions - a headset pause pauses the party
  // for everyone, exactly like the in-tile controls.
  $effect(() => {
    if (!joined || !currentKey) {
      host.setNowPlaying(null);
      return;
    }
    host.setNowPlaying({
      title: episodeLabel(anime.show, untrack(() => current)),
      artist: anime.show?.title ?? "Anime Party",
      artworkUrl: anime.show?.image ?? undefined,
      playing: anime.playing,
      onPlay: () => void togglePlayback(),
      onPause: () => void togglePlayback(),
      onNext: () => void skip(),
      onPrevious: () => void previous(),
    });
    return () => host.setNowPlaying(null);
  });

  // Owner duty the card normally performs, mirrored here because the card
  // stands down while the tile renders: when someone joins, ship them the
  // authoritative position.
  let syncedJoinCount = 0;
  let syncedRequestId = "";
  $effect(() => {
    const latest = anime.activity.at(-1);
    const request = anime.syncRequest;
    // Same per-case responder rule as the card: see AnimeCard's twin effect.
    const joinedNeedsSync =
      latest?.action === "joined" &&
      anime.activitySeq !== syncedJoinCount &&
      selfDid === syncResponder(anime);
    const requestNeedsSync =
      !!request &&
      request.id !== syncedRequestId &&
      selfDid === syncResponderFor(anime, request.requesterDid);
    if (
      (!joinedNeedsSync && !requestNeedsSync) ||
      anime.currentIndex === null
    )
      return;
    syncedJoinCount = anime.activitySeq;
    if (request) syncedRequestId = request.id;
    void send({
      action: "sync",
      index: anime.currentIndex,
      position: player?.currentTime() ?? localPosition,
      playing: anime.playing,
      duration,
      atMs: Date.now(),
      ...(request
        ? { requestId: request.id, targetDid: request.requesterDid }
        : {}),
    });
  });

  async function send(data: unknown) {
    try {
      await host.sendUpdate(card.id, data);
    } catch (err) {
      console.error("[anime-party] tile update failed:", err);
    }
  }

  async function togglePlayback() {
    const position = player?.currentTime() ?? localPosition;
    await send({
      action: anime.playing ? "pause" : "play",
      position,
      atMs: Date.now(),
    });
  }

  async function skip() {
    const n = nextEpisode();
    // No next episode: the "latest episode" note is already showing, so the
    // press is a deliberate no-op rather than a stale skip action.
    if (n)
      await send({ action: "step", episode: { number: n.number }, at: "end" });
  }

  async function previous() {
    const p = prevEpisode();
    if (p)
      await send({
        action: "step",
        episode: { number: p.number },
        at: "start",
      });
  }

  async function seekTo(position: number) {
    await send({ action: "seek", position, atMs: Date.now() });
  }

  async function seekBy(delta: number) {
    const at = player?.currentTime() ?? localPosition;
    await seekTo(seekTarget(at, delta, duration));
  }

  async function ended() {
    if (anime.currentIndex === null) return;
    const n = nextEpisode();
    if (n) {
      await send({ action: "step", episode: { number: n.number }, at: "end" });
    } else {
      // The last episode finished: stop the party where it ended instead of
      // trying to keep a finished video "playing". Pause needs a finite
      // position >= 0.
      const at = player?.currentTime() ?? duration;
      await send({
        action: "pause",
        position: Number.isFinite(at) && at >= 0 ? at : 0,
        atMs: Date.now(),
      });
    }
  }
</script>

<!-- use:tileKeys makes the tile focusable and owns the arrow-key shortcuts;
     they fire only when this tile has focus (the host focuses a tile on
     click, and its controls are focusable too). -->
<div
  class="group/tile relative flex h-full w-full flex-col bg-black focus:outline-none"
  aria-label="Anime party player. Space plays or pauses, left and right seek ten seconds."
  use:tileKeys
>
  {#if !joined}
    <div class="grid h-full w-full place-items-center">
      <Tip text="Join party">
        {#snippet children(props)}
          <button
            type="button"
            {...props}
            onclick={(e) => {
              e.stopPropagation();
              void send({ action: "join" });
            }}
            aria-label="Join party"
            class="pointer-events-auto cursor-pointer rounded-full border border-border bg-background/95 p-2 text-foreground shadow-sm hover:border-primary/60"
          >
            <LogIn class="size-4" />
          </button>
        {/snippet}
      </Tip>
    </div>
  {:else if current}
    <div class="anime-tile-player absolute inset-0">
      <AnimePlayer
        bind:this={player}
        showId={anime.show?.id ?? null}
        episode={current.number}
        {lang}
        playing={anime.playing}
        position={handoffPosition ?? syncPosition}
        onPosition={(p) => {
          localPosition = p;
          publishLivePosition(p, anime.playing);
          // Drift correction, once a second on the reporter's beat. Never
          // mid-handoff, never into a loading player.
          if (!playerLoading && handoffPosition === null) {
            applyCorrection(
              driftCorrection(
                stateTick(anime),
                clockEstimateFor(anime.tickBy),
                anime.tickBy === selfDid,
                { position: p, paused: !anime.playing },
                Date.now()
              )
            );
          }
          if (
            handoffPosition !== null &&
            handoffIsReadyToRelease(playerLoading, p, handoffPosition, duration)
          )
            handoffPosition = null;
        }}
        onDuration={(d) => {
          // The player reports 0 for "no metadata yet", the same way the
          // card treats it: taking that as the length would tell the handoff
          // check the episode is zero seconds long.
          if (d <= 0) return;
          duration = d;
          publishLiveDuration(d);
        }}
        onReady={() => (playerLoading = false)}
        onPlayable={() => (playerLoading = false)}
        onError={() => (playerLoading = false)}
        onEnded={ended}
      />
    </div>
    <!-- The host renders this tile in a pointer-events-none layer, so the
         embed's own controls are out of reach here anyway; only elements
         that re-enable pointer events act. -->

    <!-- The shared synced chrome: center play/pause, transport bar,
         vignette. pointer-events discipline lives inside the component -
         hidden chrome stays pass-through so clicking the tile still
         focuses it like every other stream. -->
    <AnimeSyncedControls
      playing={anime.playing}
      position={localPosition}
      {duration}
      {lang}
      visible={chromeVisible}
      queueLabel={anime.currentIndex !== null
        ? `${anime.currentIndex + 1}/${anime.queue.length}`
        : ""}
      onTogglePlay={() => void togglePlayback()}
      onPrevious={() => void previous()}
      onSkip={() => void skip()}
      onSeek={(p) => void seekTo(p)}
      onSeekBy={(d) => void seekBy(d)}
      onToggleLang={() => void toggleLang()}
    />
    {#if atLatest}
      <p
        class="pointer-events-none absolute inset-x-0 top-3 z-30 mx-auto w-fit max-w-[90%] rounded bg-black/70 px-2 py-1 text-center font-mono text-[10px] text-white/80"
      >You're on the latest episode. More may appear here if the show is still airing.</p>
    {/if}
  {:else}
    <div
      class="grid h-full w-full place-items-center font-mono text-xs text-muted-foreground"
    >
      Queue is empty - /anime something
    </div>
  {/if}
</div>

<style>
  .anime-tile-player :global(> div) {
    height: 100%;
    min-height: 0;
    border: none;
    border-radius: 0;
  }
  .anime-tile-player :global(iframe) {
    width: 100%;
    height: 100%;
    min-height: 0;
    aspect-ratio: auto;
    border: none;
    border-radius: 0;
  }
</style>
