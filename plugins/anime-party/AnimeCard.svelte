<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    ArrowLeft,
    CircleOff,
    List,
    ListPlus,
    LogIn,
    LogOut,
    Pause,
    Play,
    Search,
    SkipBack,
    SkipForward,
    Trash2,
  } from "@lucide/svelte";
  import type { HostApi } from "$lib/plugins/api";
  import type { Message } from "$lib/transport/transport.svelte";
  import type { Correction } from "$lib/plugins/watch";
  import { Tip } from "$lib/plugins/ui";
  import AnimePlayer from "./AnimePlayer.svelte";
  import AnimeSyncedControls from "./AnimeSyncedControls.svelte";
  import { queueButtonClass } from "./LoopButton.svelte";
  import {
    episodes as fetchEpisodes,
    search as searchShows,
    NotConfiguredError,
    type Episode,
    type Lang,
    type Show,
  } from "./anidb";
  import {
    ADD_BATCH,
    QUEUE_CAP,
    initialState,
    seekTarget,
    stateTick,
    syncResponder,
    syncResponderFor,
    type AnimeState,
  } from "./logic";
  import { episodeLabel } from "./titles";
  import { driftCorrection, projectedTickPosition } from "./watch-drift";
  import { clockEstimateFor, ensureClock } from "./clock";
  import {
    tilePresence,
    registerPositionSource,
    livePosition,
    liveDurationState,
    parkHandoff,
    handoffIsReadyToRelease,
    takeParkedRendererControl,
    rendererSyncUpdate,
    type RendererHandoff,
  } from "./tile-presence.svelte";
  import {
    audioVolume,
    initializeAudioVolume,
    setAudioVolume,
  } from "./audio-volume.svelte";
  import { createHostDepartureGrace } from "./host-departure";

  /** The one sentence an unconfigured instance gets to say. Not an error to
   *  retry: the operator has to allowlist the hosts. */
  const NOT_CONFIGURED =
    "This instance is not configured for anime-party " +
    "(PLUGIN_PROXY_HOSTS needs anidb.app and hls.anidb.app).";

let cardsSnapshot:
  | Promise<Array<{ id: string; senderDid: string; state?: unknown }>>
  | null = null;
let cardsSnapshotValue: Array<{
  id: string;
  senderDid: string;
  state?: unknown;
}> = [];
let cardsSnapshotAt = 0;

function sharedCardsSnapshot(host: HostApi, force = false) {
  if (!force && Date.now() - cardsSnapshotAt < 1_000)
    return Promise.resolve(cardsSnapshotValue);
  if (cardsSnapshot) return cardsSnapshot;
  cardsSnapshot = host.cards().then((cards) => {
    cardsSnapshotValue = cards;
    cardsSnapshotAt = Date.now();
    return cards;
  }).finally(() => {
    cardsSnapshot = null;
  });
  return cardsSnapshot;
}

  interface Props {
    card: Message;
    cardState: unknown;
    host: HostApi;
  }
  let { card, cardState, host }: Props = $props();
  // cardState can transiently be undefined (a mid-build state read); an
  // empty party renders inert instead of throwing on every field access.
  const anime = $derived(
    (cardState as AnimeState | undefined) ?? initialState(null)
  );
  let queueOpen = $state(false);
  let addOpen = $state(false);
  let error = $state("");
  let player = $state<AnimePlayer | null>(null);
  let playerHover = $state(false);
  // Sub or dub: this DEVICE's preference, read from plugin storage and
  // never sent to the room. Two members can watch the same second of the
  // same episode in different audio languages.
  let lang = $state<Lang>("jpn");
  /** What actually played, when the episode had no track in `lang`. */
  let resolvedLang = $state<Lang | null>(null);
  // Search / pick-a-show, all local: the results that everyone sees travel
  // as one "search" update, not as a fetch per member.
  let query = $state("");
  let searching = $state(false);
  let changingShow = $state(false);
  // The show's episode list, fetched directly (open CORS) by whoever opens
  // the picker, and never synced: only the chosen episodes are.
  let episodeList = $state<Episode[]>([]);
  let episodesLoading = $state(false);
  let episodesError = $state("");
  let episodesLoadedFor = "";
  // The classic below-player controls only serve the surfaces that mount no
  // local player (the call tile is rendering); when the card IS the
  // renderer, the overlay chrome on the player owns transport, seek and
  // volume - the same chrome the call tile has.
  const overlayControls = $derived(tilePresence.count === 0);
  // Seeded from the shared position, then owned locally (the scrubber and
  // the renderer handoff both write it), so this must NOT track anime.
  let localPosition = $state(untrack(() => anime.position));
  let transition = $state<RendererHandoff | null>(null);
  let transitionNow = $state(Date.now());
  let activeResyncId = $state<string | null>(null);
  let duration = $state(0);
  // Seeded once; the slider owns it from then on.
  let seekValue = $state(untrack(() => anime.position));
  let seeking = $state(false);
  let syncedJoinCount = 0;
  let syncedRequestId = "";
  const volume = $derived(audioVolume.value);
  let pending = $state<string | null>(null);
  let playerLoading = $state(true);
  // Re-read on reconnect below, so it stays $state - it just must not
  // capture host reactively here.
  let selfDid = $state(untrack(() => host.selfDid()));
  let lastDriftSeekAt = 0;
  /** The playback rate the drift loop last asked for, so "none" knows
   *  whether there is a nudge to undo. */
  let localRate = 1;
  // Fresh clock offset to the current tick's author, for projection.
  $effect(() => {
    if (anime.tickBy && anime.tickBy !== selfDid) ensureClock(host, anime.tickBy);
  });
  // Recomputed ONLY when the tick itself changes, never on unrelated state
  // folds: anime is a fresh object per fold, and a $derived reading
  // Date.now() would mint a new projected value on every join or activity
  // line - each one a changed position prop, each one a player seek.
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
  const mountedAt = Date.now();
  let departureSent = false;
  let canRecreate = $state(false);
  let refreshInFlight = false;
  let refreshQueued = false;
  let wasClosed = false;
  let hasRefreshed = false;
  const refreshRecreate = () => {
    if (!anime.closed) {
      canRecreate = false;
      return;
    }
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    const force = !hasRefreshed || !wasClosed;
    hasRefreshed = true;
    wasClosed = true;
    void sharedCardsSnapshot(host, force)
      .then((cards) => {
        const mine = cards.filter((item) => item.senderDid === selfDid);
        const hasActiveParty = cards.some((item) => {
          const state = item.state as AnimeState | undefined;
          return (
            item.id !== card.id &&
            !!state &&
            !state.closed &&
            state.members.has(selfDid)
          );
        });
        canRecreate =
          anime.closed &&
          anime.queue.length > 0 &&
          mine.at(-1)?.id === card.id &&
          !hasActiveParty;
      })
      .finally(() => {
        refreshInFlight = false;
        if (refreshQueued) {
          refreshQueued = false;
          refreshRecreate();
        }
      });
  };
  const current = $derived(
    anime.currentIndex === null ? null : anime.queue[anime.currentIndex]
  );
  /** The renderer-handoff key for the playing episode. */
  const currentKey = $derived(current ? String(current.id) : null);
  const currentLabel = $derived(episodeLabel(anime.show, current));
  const transitionPosition = $derived.by(() => {
    if (!transition) return localPosition;
    const elapsed = transition.playing
      ? Math.max(0, transitionNow - transition.at) / 1_000
      : 0;
    return Math.min(
      transition.duration || Number.POSITIVE_INFINITY,
      transition.position + elapsed
    );
  });
  const rendererPosition = $derived.by(() => {
    return tilePresence.count > 0
      ? livePosition(anime.position)
      : transition
        ? transitionPosition
        : localPosition;
  });
  const rendererDuration = $derived(
    tilePresence.count > 0
      ? liveDurationState.duration
      : transition?.duration || duration
  );
  const displayedPosition = $derived(seeking ? seekValue : rendererPosition);
  const joined = $derived(anime.members.has(selfDid));
  const listeners = $derived(
    Array.from(anime.members.entries()).map(([did, name]) => ({
      did,
      name: did === anime.ownerDid ? card.senderName : name,
    }))
  );
  /** Which episodes are already in the room's queue, for the add panel. */
  const queuedIds = $derived(new Set(anime.queue.map((ep) => ep.id)));
  const unqueued = $derived(
    episodeList.filter((ep) => !queuedIds.has(ep.id))
  );
  /** On the latest episode the show's list currently knows about. Open-ended
   *  on purpose: the show may still be airing, so this is not "the show
   *  ended", only "nothing newer is fetched yet". */
  const atLatest = $derived(
    current != null &&
      episodeList.length > 0 &&
      current.number >= Math.max(...episodeList.map((e) => e.number))
  );
  /** The one-line note for an episode that had no track in `lang`. */
  const langNote = $derived(
    resolvedLang && resolvedLang !== lang
      ? `Only ${resolvedLang === "eng" ? "Dub" : "Sub"} is available for this episode`
      : ""
  );

  $effect(() => {
    if (!transition?.playing) return;
    const timer = window.setInterval(() => (transitionNow = Date.now()), 250);
    return () => window.clearInterval(timer);
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
    transition = {
      token: transition?.token ?? 0,
      position: anime.position,
      duration: response.duration || transition?.duration || duration,
      playing: anime.playing,
      at: Date.now(),
    };
    transitionNow = Date.now();
  });

  async function send(data: unknown, label?: string) {
    if (label) pending = label;
    try {
      await host.sendUpdate(card.id, data);
    } finally {
      if (label && pending === label) pending = null;
    }
  }
  // While THIS card renders the player, it is the live position source for
  // playerless surfaces (the sidebar widget).
  $effect(() => {
    if (tilePresence.count > 0 || !joined) return;
    const unregister = registerPositionSource(
      () => player?.currentTime() ?? localPosition
    );
    return () => {
      if (currentKey)
        parkHandoff(
          currentKey,
          player?.currentTime() ?? localPosition,
          duration,
          anime.playing
        );
      unregister();
    };
  });

  // Becoming the renderer after the call tile (leaving a call): the synced
  // state.position is stale by however long the tile played, so the tile
  // parked its live position - re-sync the party to it. Everyone else's
  // player is already ~there, so the seek is imperceptible to them and
  // saves US from restarting at the stale point.
  let tileWasRendering = false;
  $effect(() => {
    if (tilePresence.count > 0) {
      tileWasRendering = true;
      return;
    }
    if (!joined || !currentKey || anime.closed) return;
    const requestId = selfDid === anime.ownerDid ? "" : crypto.randomUUID();
    const takeover = takeParkedRendererControl(
      currentKey,
      selfDid,
      anime.ownerDid,
      requestId
    );
    if (takeover) {
      tileWasRendering = false;
      const h = takeover.handoff;
      // This is a fresh media element even when the episode did not change.
      // Do not let the previous player's ready state release the handoff.
      playerLoading = true;
      transition = h;
      transitionNow = Date.now();
      localPosition = h.position;
      // Suppress the join-sync effect that fires next: the handoff already
      // covers the auto-join activity the tile just created.
      syncedJoinCount = anime.activitySeq;
      if (takeover.update.action === "resync") activeResyncId = requestId;
      void send(takeover.update);
    } else if (tileWasRendering) {
      // The tile stood down but nothing was parked - a teardown-order race
      // (the player unmounting before the cleanup read it), an expired
      // handoff, anything. Its last PUBLISHED position is still the best
      // truth held anywhere; without this the fresh card player fell back
      // to the stale synced position, usually second 0 of the episode.
      tileWasRendering = false;
      const live = livePosition(anime.position);
      if (live > anime.position + 3) {
        playerLoading = true;
        transition = {
          token: 0,
          position: live,
          duration: liveDurationState.duration || duration || 0,
          playing: anime.playing,
          at: Date.now(),
        };
        transitionNow = Date.now();
        localPosition = live;
        syncedJoinCount = anime.activitySeq;
        const update = rendererSyncUpdate(
          selfDid,
          anime.ownerDid,
          live,
          requestId
        );
        if (update.action === "resync") activeResyncId = requestId;
        void send(update);
      }
    }
  });

  // ...and the lock-screen owner, with SYNCED handlers - same rule as the
  // call tile, whichever surface renders holds the OS media surface.
  $effect(() => {
    if (tilePresence.count > 0 || !joined || !currentKey || anime.closed) {
      host.setNowPlaying(null);
      return;
    }
    host.setNowPlaying({
      title: currentLabel,
      artist: anime.show?.title ?? "Anime Party",
      artworkUrl: anime.show?.image ?? undefined,
      playing: anime.playing,
      onPlay: () => void togglePlayback(),
      onPause: () => void togglePlayback(),
      onNext: () => void goNext(),
      onPrevious: () => void previous(),
    });
    return () => host.setNowPlaying(null);
  });

  function departureAction(): { action: "close" | "leave" } | null {
    // The call tile is rendering the party: this card unmounting (scrolled
    // away, view switched) is NOT the user leaving. Closing here is what
    // froze the party the moment the owner joined a call.
    if (tilePresence.count > 0) return null;
    if (departureSent || anime.closed || !joined) return null;
    departureSent = true;
    // Other members observe the host disconnect and apply the shared
    // reconnect grace; sending close here would bypass that protection.
    return selfDid === anime.ownerDid ? null : { action: "leave" };
  }
  async function togglePlayback() {
    const position =
      player?.currentTime() ??
      (tilePresence.count > 0 ? livePosition(anime.position) : rendererPosition);
    await send(
      { action: anime.playing ? "pause" : "play", position, atMs: Date.now() },
      anime.playing ? "Pausing…" : "Starting…"
    );
  }
  /** The next episode in the SHOW's full list - the smallest number
   *  strictly above the one playing - or null when we are already on the
   *  latest fetched episode. Next walks the show, not just the queue. */
  function nextEpisode(): Episode | null {
    if (!current) return null;
    let best: Episode | null = null;
    for (const ep of episodeList) {
      if (ep.number > current.number && (best === null || ep.number < best.number))
        best = ep;
    }
    return best;
  }
  /** The previous episode in the show's full list - the largest number
   *  strictly below the one playing - or null. */
  function prevEpisode(): Episode | null {
    if (!current) return null;
    let best: Episode | null = null;
    for (const ep of episodeList) {
      if (ep.number < current.number && (best === null || ep.number > best.number))
        best = ep;
    }
    return best;
  }
  async function goNext() {
    const n = nextEpisode();
    // No next episode: the "latest episode" note is already on screen, so the
    // press is a deliberate no-op rather than a stale skip action.
    if (n)
      await send(
        { action: "step", episode: { id: n.id, number: n.number }, at: "end" },
        "Next episode…"
      );
  }
  async function previous() {
    const p = prevEpisode();
    if (p)
      await send(
        { action: "step", episode: { id: p.id, number: p.number }, at: "start" },
        "Previous episode…"
      );
  }
  async function seekBy(delta: number) {
    const at = player?.currentTime() ?? rendererPosition;
    await send({
      action: "seek",
      position: seekTarget(at, delta, rendererDuration),
      atMs: Date.now(),
    });
  }
  function commitSeek() {
    seeking = false;
    transition = null;
    void send({ action: "seek", position: seekValue, atMs: Date.now() });
  }
  function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${minutes}:${remainder.toString().padStart(2, "0")}`;
  }
  async function ended() {
    if (anime.currentIndex === null) return;
    const n = nextEpisode();
    if (n) {
      await send({
        action: "step",
        episode: { id: n.id, number: n.number },
        at: "end",
      });
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
  async function join() {
    pending = "Joining party…";
    try {
      // Publish membership first. Scanning and hydrating every plugin card can
      // be slow while the relay is recovering, and must not delay this party's
      // join handshake.
      await host.sendUpdate(card.id, { action: "join" });
      const cards = await host.cards();
      await Promise.all(
        cards
          .filter((item) => {
            const state = item.state as AnimeState | undefined;
            return (
              item.id !== card.id &&
              !!state &&
              !state.closed &&
              state.members.has(selfDid)
            );
          })
          .map((item) => host.sendUpdate(item.id, { action: "leave" }))
      );
    } catch (err) {
      console.warn("[anime-party] joined party; old-party cleanup failed:", err);
    } finally {
      pending = null;
    }
  }
  function setVolume(value: number) {
    setAudioVolume(host.storage, value);
  }
  async function toggleLang() {
    lang = lang === "jpn" ? "eng" : "jpn";
    // The note belongs to the episode AND the preference; a fresh choice
    // deserves a fresh answer from the resolver.
    resolvedLang = null;
    // Sub and dub are two different files upstream, so the player tears the
    // element down and calls load(), which puts playbackRate back to 1. The
    // episode did not change, so nothing else clears this - and a stale
    // localRate makes the drift law skip the nudge it needs to re-apply.
    localRate = 1;
    try {
      await host.storage.set("lang", lang);
    } catch {
      // The choice just does not survive a reload.
    }
  }
  async function recreate() {
    if (!canRecreate || !anime.show || !anime.queue.length) return;
    // A card payload carries the show, not the queue (initialState reads no
    // episodes on purpose - a queue arrives through updates, where the
    // reducer bounds it). So re-add it the way anybody else would.
    const id = await host.sendCard({ show: anime.show, ownerDid: selfDid });
    for (let i = 0; i < anime.queue.length; i += ADD_BATCH) {
      await host.sendUpdate(id, {
        action: "add",
        episodes: anime.queue.slice(i, i + ADD_BATCH),
      });
    }
  }
  $effect(() => {
    const latest = anime.activity.at(-1);
    const request = anime.syncRequest;
    // Who answers is per-CASE: a join-sync falls to the standing responder,
    // a targeted request to anyone but its requester (owner preferred) - so
    // the party answers a refreshed HOST too, instead of owner-only
    // answering that left everyone stuck whenever the owner was the one
    // who went stale.
    const joinedNeedsSync =
      latest?.action === "joined" &&
      anime.activitySeq !== syncedJoinCount &&
      selfDid === syncResponder(anime);
    const requestNeedsSync =
      !!request &&
      request.id !== syncedRequestId &&
      selfDid === syncResponderFor(anime, request.requesterDid);
    if (
      // The tile is the renderer: it owns the join-sync too, and this
      // card's player is not even mounted to read a position from.
      tilePresence.count > 0 ||
      (!joinedNeedsSync && !requestNeedsSync) ||
      anime.currentIndex === null
    )
      return;
    syncedJoinCount = anime.activitySeq;
    if (request) syncedRequestId = request.id;
    void send({
      action: "sync",
      index: anime.currentIndex,
      position:
        player?.currentTime() ??
        (tilePresence.count > 0
          ? livePosition(anime.position)
          : rendererPosition),
      playing: anime.playing,
      duration,
      atMs: Date.now(),
      ...(request
        ? { requestId: request.id, targetDid: request.requesterDid }
        : {}),
    });
  });

  async function runSearch() {
    const q = query.trim().slice(0, 100);
    if (!q || searching) return;
    searching = true;
    error = "";
    try {
      const results = await searchShows(q);
      await send({ action: "search", query: q, results }, "Searching…");
    } catch (err) {
      error =
        err instanceof NotConfiguredError
          ? NOT_CONFIGURED
          : "The search could not be read. anidb.app may have changed.";
    } finally {
      searching = false;
    }
  }

  async function pickShow(show: Show) {
    changingShow = false;
    await send({ action: "pick-show", show }, "Picking the show…");
  }

  async function loadEpisodes(showId: string) {
    episodesLoading = true;
    episodesError = "";
    try {
      episodeList = await fetchEpisodes(showId);
      if (!episodeList.length)
        episodesError = "anidb.app lists no episodes for this show.";
    } catch {
      episodesError = "The episode list could not be read.";
    } finally {
      episodesLoading = false;
    }
  }
  // Fetched once per show for any joined viewer, not only when the add panel
  // is open: Next and Previous walk the show's full list, so the list has to
  // be present wherever navigation can happen. Same cached episodes() call,
  // a direct request from every member's own browser, so it costs nothing
  // extra.
  $effect(() => {
    const showId = anime.show?.id;
    if (!joined || !showId || showId === episodesLoadedFor) return;
    episodesLoadedFor = showId;
    episodeList = [];
    void loadEpisodes(showId);
  });

  /** Queue episodes in reducer-sized batches, sequentially: one update
   *  carries ADD_BATCH at most, and a season is several updates. */
  async function addEpisodes(list: Episode[]) {
    const room = QUEUE_CAP - anime.queue.length;
    const fresh = list
      .filter((ep) => !queuedIds.has(ep.id))
      .slice(0, Math.max(0, room));
    if (!fresh.length) return;
    for (let i = 0; i < fresh.length; i += ADD_BATCH) {
      const batch = fresh.slice(i, i + ADD_BATCH);
      await send(
        { action: "add", episodes: batch },
        `Adding episodes (${Math.min(i + batch.length, fresh.length)}/${fresh.length})…`
      );
    }
  }

  /** seek, rate, or undo a nudge - the whole control law, which a native
   *  video can honour (see watch-drift.ts). */
  function applyCorrection(correction: Correction | null) {
    if (!correction || !player) return;
    if (correction.action === "seek") {
      // Seeks stay rate-limited: a correction storm is worse than drift.
      if (Date.now() - lastDriftSeekAt <= 5_000) return;
      lastDriftSeekAt = Date.now();
      if (localRate !== 1) {
        localRate = 1;
        player.setRate(1);
      }
      player.seekLocal(correction.targetPosition);
    } else if (correction.action === "rate") {
      if (localRate === correction.rate) return;
      localRate = correction.rate;
      player.setRate(correction.rate);
    } else if (localRate !== 1) {
      localRate = 1;
      player.setRate(1);
    }
  }

  $effect(() => {
    if (anime.closed) refreshRecreate();
  });
  // Keyed on the ID, not the episode object: the host hands cardState
  // through a state proxy, so `current` is a fresh object on EVERY fold and
  // an effect reading it re-ran on each play and pause, flagging the player
  // as loading again and flickering the card.
  $effect(() => {
    currentKey;
    playerLoading = true;
    localRate = 1;
    resolvedLang = null;
  });
  // A fresh mount of a PLAYING party (an F5, a room reopen) starts from the
  // folded position, which is only as fresh as the last action - ask a
  // member where the party actually is. The owner asks too: their own
  // folded state is exactly what went stale.
  let requestedMountResync = false;
  $effect(() => {
    if (
      requestedMountResync ||
      anime.closed ||
      !joined ||
      !anime.playing ||
      anime.currentIndex === null ||
      anime.members.size < 2 ||
      tilePresence.count > 0
    )
      return;
    requestedMountResync = true;
    const requestId = crypto.randomUUID();
    activeResyncId = requestId;
    void send({ action: "resync", requestId, requesterDid: selfDid });
  });
  onMount(() => {
    void initializeAudioVolume(host.storage);
    void host.storage
      .get("lang")
      .then((stored) => {
        if (stored === "jpn" || stored === "eng") lang = stored;
      })
      .catch(() => {
        // Storage is unreadable; subbed is the default either way.
      });
    refreshRecreate();
    const unsubscribeCardStates = host.onCardStateChange(refreshRecreate);
    const identityTimer = window.setInterval(() => {
      selfDid = host.selfDid();
    }, 250);
    const hostDeparture = createHostDepartureGrace(
      anime.ownerDid,
      () => host.peers(),
      () => void send({ action: "host-left" })
    );
    const unsubscribe = host.onPeerDisconnect((peer) => {
      // A card observes transport events before its join update is folded.
      // Do not let a pre-join relay flap declare the party host gone.
      if (
        anime.closed ||
        !anime.members.has(selfDid) ||
        !anime.members.has(peer.did)
      )
        return;
      if (peer.did === anime.ownerDid) hostDeparture.observeDisconnect(peer.did);
      else if (selfDid === anime.ownerDid)
        void send({ action: "prune", did: peer.did });
    });
    const unsubscribeBeforeDisconnect = host.onBeforeDisconnect(() => {
      const action = departureAction();
      if (action) host.sendUpdateImmediately(card.id, action);
    });
    const pruneTimer = window.setInterval(() => {
      // Every member observes peer snapshots so a host reconnect cancels
      // its locally pending close, not only the party owner's copy.
      hostDeparture.observePeers();
      if (
        Date.now() - mountedAt < 15_000 ||
        anime.closed ||
        selfDid !== anime.ownerDid
      )
        return;
      const connected = new Set([
        selfDid,
        ...host.peers().map((peer) => peer.did),
      ]);
      for (const did of anime.members.keys()) {
        if (did !== anime.ownerDid && !connected.has(did))
          void send({ action: "prune", did });
      }
    }, 5_000);
    return () => {
      window.clearInterval(identityTimer);
      window.clearInterval(pruneTimer);
      hostDeparture.dispose();
      unsubscribe();
      unsubscribeBeforeDisconnect();
      unsubscribeCardStates();
      const action = departureAction();
      if (action) void send(action);
    };
  });
</script>

<div
  class="max-w-md space-y-3 rounded-lg border border-border bg-card p-3 text-card-foreground"
>
  <div class="flex items-center justify-between">
    <strong class="font-mono text-sm">Anime Party</strong
    >{#if !anime.closed}<span class="text-xs text-muted-foreground"
        >{anime.members.size} watching</span
      >{/if}
  </div>

  {#if anime.notConfigured}
    <!-- Nothing else to show: without the two allowlisted hosts there is no
         search, no stream, and no amount of clicking changes that. -->
    <p class="py-6 text-center text-sm text-muted-foreground">
      {NOT_CONFIGURED}
    </p>
    {#if selfDid === anime.ownerDid && !anime.closed}
      <Tip text="Disband party">
        {#snippet children(props)}
          <button
            {...props}
            class="mx-auto block rounded border border-destructive px-3 py-2 text-destructive disabled:opacity-60"
            disabled={pending !== null}
            onclick={() => send({ action: "close" }, "Disbanding party…")}
            aria-label="Disband party"><CircleOff class="size-4" /></button
          >
        {/snippet}
      </Tip>
    {/if}
  {:else if anime.closed}
    <p class="py-8 text-center text-sm text-muted-foreground">
      The party is over.. heh..~
    </p>
    {#if canRecreate}<Tip text="Start a new party with the same queue">
        {#snippet children(props)}
          <button
            type="button"
            {...props}
            class="mx-auto block rounded bg-muted/70 px-3 py-2 text-xs text-foreground hover:bg-muted"
            onclick={recreate}
            aria-label="Start a new party with the same queue">Start again</button
          >
        {/snippet}
      </Tip>{/if}
  {:else if anime.show === null || changingShow}
    <!-- Pick a show. Members search for everyone (the results ride one
         update), so somebody who has not joined sees Join first. -->
    <div class="space-y-2">
      {#if anime.show && changingShow}
        <button
          type="button"
          class="flex items-center gap-1 text-xs text-muted-foreground underline"
          onclick={() => (changingShow = false)}
          >
          <ArrowLeft class="size-3" /> Back to {anime.show.title}
        </button>
      {/if}
      {#if joined}
        <div class="flex gap-2">
          <input
            class="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-xs"
            disabled={searching || pending !== null}
            bind:value={query}
            onkeydown={(event) => {
              if (event.key === "Enter") void runSearch();
            }}
            placeholder="Search anidb.app"
            aria-label="Search anidb.app"
          /><Tip text="Search">
            {#snippet children(props)}
              <button
                {...props}
                class="rounded border border-border px-2 text-xs disabled:opacity-60"
                disabled={searching || pending !== null}
                onclick={runSearch}
                aria-label="Search"><Search class="size-4" /></button
              >
            {/snippet}
          </Tip>
        </div>
      {/if}
      {#if error}<p class="text-xs text-destructive">{error}</p>{/if}
      <!-- The candidates are the party's, not the members': everyone sees
           what is being picked, only members get to pick. -->
      {#if anime.results.length}
          <div class="grid grid-cols-2 gap-2">
            {#each anime.results as show (show.id)}
              <button
                type="button"
                class="flex items-center gap-2 rounded border border-border p-1 text-left text-xs hover:bg-muted disabled:opacity-60"
                disabled={pending !== null || !joined}
                onclick={() => pickShow(show)}
              >
                {#if show.image}
                  <img
                    src={show.image}
                    alt=""
                    class="size-10 shrink-0 rounded object-cover"
                  />
                {/if}
                <span class="min-w-0 flex-1 truncate">{show.title}</span>
              </button>
            {/each}
          </div>
      {:else if anime.query && !searching}
        <p class="text-xs text-muted-foreground">Nothing found.</p>
      {/if}
      {#if !joined}
        <p class="py-3 text-center text-sm text-muted-foreground">
          Join this party to pick a show together :3
        </p>
      {/if}
    </div>
  {:else if joined && current}
    <!-- Watching. -->
    <div class="space-y-1">
      {#if tilePresence.count > 0}
        <!-- ONE renderer at a time: while the call tile plays the party,
             this card is just a pointer to it. No second player, no muted
             shadow instance, no split lifecycle. -->
        <p
          class="rounded bg-primary/10 px-2 py-2 text-center font-mono text-xs text-primary"
        >
          ▶ Rendering in the call
        </p>
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="relative"
          onpointerenter={() => (playerHover = true)}
          onpointerleave={() => (playerHover = false)}
        >
          <AnimePlayer
            bind:this={player}
            episodeId={current.id}
            {lang}
            playing={anime.playing}
            position={transition?.position ?? syncPosition}
            {volume}
            onPosition={(value) => {
              localPosition = value;
              // Same drift correction as the call tile: local only, never
              // mid-handoff, never into a loading element. watch-drift.ts.
              if (!playerLoading && !transition) {
                applyCorrection(
                  driftCorrection(
                    stateTick(anime),
                    clockEstimateFor(anime.tickBy),
                    anime.tickBy === selfDid,
                    {
                      position: value,
                      paused: !anime.playing,
                      rate: localRate,
                    },
                    Date.now()
                  )
                );
              }
              if (
                transition &&
                handoffIsReadyToRelease(
                  playerLoading,
                  value,
                  transitionPosition,
                  duration
                )
              )
                transition = null;
            }}
            onDuration={(value) => {
              if (value > 0) duration = value;
            }}
            onEnded={ended}
            onReady={() => (playerLoading = false)}
            onPlayable={() => (playerLoading = false)}
            onError={() => (playerLoading = false)}
            onResolvedLang={(value) => (resolvedLang = value)}
          />
          <!-- The same synced chrome the call tile renders: center
               play/pause, transport bar, vignette - revealed on hover. -->
          <AnimeSyncedControls
            playing={anime.playing}
            position={localPosition}
            duration={rendererDuration}
            {volume}
            {lang}
            visible={playerHover}
            vignetteBoost
            queueLabel={anime.currentIndex !== null
              ? `${anime.currentIndex + 1}/${anime.queue.length}`
              : ""}
            onTogglePlay={() => void togglePlayback()}
            onPrevious={() => void previous()}
            onSkip={() => void goNext()}
            onSeek={(p) =>
              void send({ action: "seek", position: p, atMs: Date.now() })}
            onSeekBy={(d) => void seekBy(d)}
            onVolume={setVolume}
            onToggleLang={() => void toggleLang()}
          />
        </div>
        {#if playerLoading}<p class="text-center text-xs text-muted-foreground">
            Loading player…
          </p>{/if}
      {/if}
      <p class="truncate font-mono text-[11px] text-muted-foreground">
        {currentLabel}
      </p>
      {#if langNote}<p class="text-[11px] text-muted-foreground">
          {langNote}
        </p>{/if}
    </div>
  {:else if !joined}
    <p class="py-5 text-center text-sm text-muted-foreground">
      Join this party to watch together :3
    </p>
  {:else}
    <div class="space-y-1">
      <p class="text-sm text-muted-foreground">The queue is empty.</p>
    </div>
  {/if}

  {#if !anime.closed && !anime.notConfigured && anime.show && !changingShow}
    <!-- The show header. "Change show" only while nothing is queued: the
         reducer refuses pick-show past that, and offering a button that
         cannot work is worse than not offering it. -->
    <div class="flex items-center gap-2 border-t border-border pt-2">
      {#if anime.show.image}
        <img
          src={anime.show.image}
          alt=""
          class="size-8 shrink-0 rounded object-cover"
        />
      {/if}
      <span class="min-w-0 flex-1 truncate text-xs font-medium"
        >{anime.show.title}</span
      >
      {#if joined && anime.queue.length === 0}
        <button
          type="button"
          class="shrink-0 text-xs text-muted-foreground underline"
          onclick={() => (changingShow = true)}>Change show</button
        >
      {/if}
    </div>
  {/if}

  {#if pending}<p
      class="rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
      role="status"
    >
      {pending}
    </p>{/if}

  {#if !anime.closed && !anime.notConfigured && joined && anime.show && !changingShow}<div
      class="space-y-1"
    >
      {#if !overlayControls}
        <input
          class="w-full"
          type="range"
          min="0"
          max={rendererDuration || 0}
          step="1"
          value={displayedPosition}
          disabled={rendererDuration <= 0}
          onchange={commitSeek}
          oninput={(event) => {
            seekValue = Number(event.currentTarget.value);
            seeking = true;
          }}
          aria-label="Seek episode"
        />
        <div
          class="-mt-2 pb-1 text-right font-mono text-[11px] text-muted-foreground"
        >
          {formatTime(displayedPosition)} / {formatTime(rendererDuration)}
        </div>
      {/if}
      <div class="space-y-2 text-xs">
        <div class="flex items-center gap-2">
          <div class="flex gap-2">
            {#if !overlayControls}
              <Tip text="Previous episode">
                {#snippet children(props)}
                  <button
                    {...props}
                    class="rounded border border-border px-3 py-2 disabled:opacity-60"
                    disabled={pending !== null}
                    onclick={previous}
                    aria-label="Previous episode"
                    ><SkipBack class="size-4" /></button
                  >
                {/snippet}
              </Tip>
              <Tip text={anime.playing ? "Pause" : "Play"}>
                {#snippet children(props)}
                  <button
                    {...props}
                    class="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-60"
                    disabled={pending !== null}
                    onclick={togglePlayback}
                    aria-label={anime.playing ? "Pause" : "Play"}
                    >{#if anime.playing}<Pause class="size-4" />{:else}<Play
                        class="size-4"
                      />{/if}</button
                  >
                {/snippet}
              </Tip>
              <Tip text="Skip">
                {#snippet children(props)}
                  <button
                    {...props}
                    class="rounded border border-border px-3 py-2 disabled:opacity-60"
                    disabled={pending !== null}
                    onclick={goNext}
                    aria-label="Skip"><SkipForward class="size-4" /></button
                  >
                {/snippet}
              </Tip>
            {/if}
            <Tip text={queueOpen ? "Hide queue" : "Show queue"}>
              {#snippet children(props)}
                <button
                  {...props}
                  class="rounded border px-3 py-2 transition-colors {queueButtonClass(
                    queueOpen
                  )}"
                  onclick={() => (queueOpen = !queueOpen)}
                  aria-label={queueOpen ? "Hide queue" : "Show queue"}
                  ><List class="size-4" /></button
                >
              {/snippet}
            </Tip>
            <Tip text={addOpen ? "Hide episodes" : "Add episodes"}>
              {#snippet children(props)}
                <button
                  {...props}
                  class="rounded border px-3 py-2 transition-colors {queueButtonClass(
                    addOpen
                  )}"
                  onclick={() => (addOpen = !addOpen)}
                  aria-label={addOpen ? "Hide episodes" : "Add episodes"}
                  ><ListPlus class="size-4" /></button
                >
              {/snippet}
            </Tip>
          </div>
          <div class="ml-auto flex gap-2">
            {#if selfDid === anime.ownerDid}<Tip text="Disband party">
                {#snippet children(props)}
                  <button
                    {...props}
                    class="rounded border border-destructive px-3 py-2 text-destructive disabled:opacity-60"
                    disabled={pending !== null}
                    onclick={() => send({ action: "close" }, "Disbanding party…")}
                    aria-label="Disband party"
                    ><CircleOff class="size-4" /></button
                  >
                {/snippet}
              </Tip>{:else}<Tip text="Leave party">
                {#snippet children(props)}
                  <button
                    {...props}
                    class="rounded border border-border px-3 py-2 disabled:opacity-60"
                    disabled={pending !== null}
                    onclick={() => send({ action: "leave" }, "Leaving party…")}
                    aria-label="Leave party"
                    ><LogOut class="size-4" /></button
                  >
                {/snippet}
              </Tip>{/if}
          </div>
        </div>
        <!-- oninput, not onchange: change fires on RELEASE, so the volume
             jumped only once the drag ended and there was no way to find a
             level by ear. The seek slider above keeps the split because
             scrubbing on every pixel is expensive; volume has no such
             reason. -->
        {#if !overlayControls}
          <label class="flex items-center gap-2"
            >Vol <input
              class="w-1/4 max-w-24"
              type="range"
              min="0"
              max="100"
              value={volume}
              oninput={(event) => setVolume(Number(event.currentTarget.value))}
              aria-label="Volume (only you)"
            /><!-- aria-hidden: a range input already announces its value, and
               without this the accessible NAME became "Vol 74%" and changed
               on every pixel of the drag. -->
            <span aria-hidden="true" class="w-8 shrink-0 text-right tabular-nums"
              >{volume}%</span
            ></label
          >
        {/if}
      </div>
      {#if atLatest}
        <p class="text-[11px] text-muted-foreground">You're on the latest episode. More may appear here if the show is still airing.</p>
      {/if}
    </div>
    {#if queueOpen}
      <div
        class="queue-list max-h-52 space-y-1 overflow-y-scroll pr-1"
        style="max-height: 13rem; overflow-y: scroll; scrollbar-gutter: stable;"
      >
        {#if !anime.queue.length}
          <p class="text-xs text-muted-foreground">Nothing queued yet.</p>
        {/if}
        {#each anime.queue as episode, index (episode.id)}<div
            class="flex items-center justify-between gap-2 text-xs"
          >
            <button
              class="min-w-0 flex-1 truncate text-left text-primary underline disabled:opacity-60"
              disabled={pending !== null}
              onclick={() =>
                send({ action: "select", index }, "Changing episode…")}
              >#{index + 1} Episode {episode.number}</button
            ><Tip text="Remove episode">
              {#snippet children(props)}
                <button
                  {...props}
                  class="shrink-0 text-destructive disabled:opacity-60"
                  disabled={pending !== null}
                  onclick={() =>
                    send({ action: "remove", index }, "Removing episode…")}
                  aria-label="Remove episode"><Trash2 class="size-4" /></button
                >
              {/snippet}
            </Tip>
          </div>{/each}
      </div>
    {/if}
    {#if addOpen}
      <div class="space-y-2">
        {#if episodesLoading}
          <p class="text-xs text-muted-foreground">Reading the episode list…</p>
        {/if}
        {#if episodesError}
          <p class="text-xs text-destructive">{episodesError}</p>
        {/if}
        {#if unqueued.length}
          <button
            type="button"
            class="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-60"
            disabled={pending !== null}
            onclick={() => addEpisodes(episodeList)}
            >{anime.queue.length ? "Add the rest" : "Add all"} ({unqueued.length})</button
          >
        {/if}
        <div
          class="queue-list max-h-52 space-y-1 overflow-y-scroll pr-1"
          style="max-height: 13rem; overflow-y: scroll; scrollbar-gutter: stable;"
        >
          {#each episodeList as episode (episode.id)}<div
              class="flex items-center justify-between gap-2 text-xs"
            >
              <span class="min-w-0 flex-1 truncate"
                >Episode {episode.number}</span
              >
              {#if queuedIds.has(episode.id)}
                <span class="shrink-0 text-muted-foreground">Queued</span>
              {:else}
                <Tip text="Add episode {episode.number}">
                  {#snippet children(props)}
                    <button
                      {...props}
                      class="shrink-0 text-primary disabled:opacity-60"
                      disabled={pending !== null}
                      onclick={() => addEpisodes([episode])}
                      aria-label="Add episode {episode.number}"
                      ><ListPlus class="size-4" /></button
                    >
                  {/snippet}
                </Tip>
              {/if}
            </div>{/each}
        </div>
      </div>
    {/if}{/if}{#if !anime.closed && !joined}<Tip text="Join party">
      {#snippet children(props)}
        <button
          {...props}
          class="rounded bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-60"
          disabled={pending !== null}
          onclick={join}
          aria-label="Join party"><LogIn class="size-4" /></button
        >
      {/snippet}
    </Tip>{/if}
  <div
    class="grid {anime.closed
      ? 'grid-cols-1'
      : 'grid-cols-2'} gap-3 border-t border-border pt-2 text-xs text-muted-foreground"
  >
    <div>
      <div class="mb-1 font-medium text-card-foreground">Activity</div>
      {#each anime.activity.slice(-4) as event, index (`${event.senderName}-${index}`)}<div
        >
          {event.senderName}
          {event.action}{#if event.episode !== null}&nbsp;episode {event.episode}{/if}
        </div>{/each}
    </div>
    {#if !anime.closed}<div>
        <div class="mb-1 font-medium text-card-foreground">Party members</div>
        {#each listeners as listener (listener.did)}<div class="truncate">
            {listener.name}
          </div>{/each}
      </div>{/if}
  </div>
</div>

<style>
  .queue-list {
    scrollbar-color: hsl(var(--muted-foreground) / 0.7) transparent;
    scrollbar-width: thin;
  }

  .queue-list::-webkit-scrollbar {
    width: 8px;
  }

  .queue-list::-webkit-scrollbar-thumb {
    background: hsl(var(--muted-foreground) / 0.7);
    border-radius: 999px;
  }
</style>
