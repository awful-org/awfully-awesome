<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    CircleOff,
    List,
    LogIn,
    LogOut,
    Pause,
    Play,
    Plus,
    SkipBack,
    SkipForward,
    Shuffle,
    Trash2,
    Music,
  } from "@lucide/svelte";
  import type { HostApi } from "$lib/plugins/api";
  import type { Message } from "$lib/transport/transport.svelte";
  import { Tip } from "$lib/plugins/ui";
  import WafflePlayer from "./WafflePlayer.svelte";
  import WaffleSyncedControls from "./WaffleSyncedControls.svelte";
  import LoopButton, { queueButtonClass } from "./LoopButton.svelte";
  import {
    playlistIdFromUrl,
    seekTarget,
    stateTick,
    syncResponder,
    syncResponderFor,
    videoIdFromUrl,
    type MusicState,
  } from "./logic";
  import { driftSeekTarget, projectedTickPosition } from "./watch-drift";
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
  import { cachedTitle, fetchTitle } from "./titles";
  import {
    audioVolume,
    initializeAudioVolume,
    setAudioVolume,
  } from "./audio-volume.svelte";
import { createHostDepartureGrace } from "./host-departure";

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
  const music = $derived(cardState as MusicState);
  let queueOpen = $state(false);
  let url = $state("");
  let error = $state("");
  let player = $state<WafflePlayer | null>(null);
  let playerHover = $state(false);
  let captions = $state(false);
  // Music-only: thumbnail instead of video, controls docked below - a view
  // preference of THIS device, never synced to the party.
  const MUSIC_ONLY_KEY = "waffle:music-only:v1";
  let musicOnly = $state(
    (() => {
      try {
        return localStorage.getItem(MUSIC_ONLY_KEY) === "1";
      } catch {
        return false;
      }
    })()
  );
  function toggleMusicOnly() {
    musicOnly = !musicOnly;
    try {
      localStorage.setItem(MUSIC_ONLY_KEY, musicOnly ? "1" : "0");
    } catch {
      // The choice just does not survive a reload.
    }
  }
  // The classic below-player controls only serve the surfaces that mount no
  // local player (the call tile is rendering); when the card IS the
  // renderer, the overlay chrome on the player owns transport, seek and
  // volume - the same chrome the call tile has.
  const overlayControls = $derived(tilePresence.count === 0);
  // Seeded from the shared position, then owned locally (the scrubber and
  // the renderer handoff both write it), so this must NOT track music.
  let localPosition = $state(untrack(() => music.position));
  let transition = $state<RendererHandoff | null>(null);
  let transitionNow = $state(Date.now());
  let activeResyncId = $state<string | null>(null);
  let duration = $state(0);
  // Seeded once; the slider owns it from then on.
  let seekValue = $state(untrack(() => music.position));
  let seeking = $state(false);
  let syncedJoinCount = 0;
  let syncedRequestId = "";
  let titles = $state<Record<string, string>>({});
  const volume = $derived(audioVolume.value);
  let pending = $state<string | null>(null);
  let playerLoading = $state(true);
  // Re-read on reconnect below, so it stays $state - it just must not
  // capture host reactively here.
  let selfDid = $state(untrack(() => host.selfDid()));
  let lastDriftSeekAt = 0;
  // Fresh clock offset to the current tick's author, for projection.
  $effect(() => {
    if (music.tickBy && music.tickBy !== selfDid) ensureClock(host, music.tickBy);
  });
  // Recomputed ONLY when the tick itself changes, never on unrelated state
  // folds: music is a fresh object per fold, and a $derived reading
  // Date.now() would mint a new projected value on every join or activity
  // line - each one a changed position prop, each one a player seek.
  // svelte-ignore state_referenced_locally -- seeded once; the effect below
  // takes over. Seeding matters: effects run after mount, and the player is
  // constructed with this prop's mount-time value.
  let syncPosition = $state(untrack(() => music.position));
  let lastTickKey = "";
  $effect(() => {
    const key = `${music.tickAtMs}|${music.tickBy}|${music.position}|${music.playing}|${music.currentIndex}`;
    if (key === lastTickKey) return;
    lastTickKey = key;
    syncPosition =
      projectedTickPosition(
        stateTick(music),
        clockEstimateFor(music.tickBy),
        music.tickBy === selfDid,
        Date.now()
      ) ?? music.position;
  });
  const mountedAt = Date.now();
  let departureSent = false;
  let canRecreate = $state(false);
  let refreshInFlight = false;
  let refreshQueued = false;
  let wasClosed = false;
  let hasRefreshed = false;
  const refreshRecreate = () => {
    if (!music.closed) {
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
          const state = item.state as MusicState | undefined;
          return (
            item.id !== card.id &&
            !!state &&
            !state.closed &&
            state.members.has(selfDid)
          );
        });
        canRecreate =
          music.closed &&
          music.queue.length > 0 &&
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
    music.currentIndex === null ? null : music.queue[music.currentIndex]
  );
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
      ? livePosition(music.position)
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
  const joined = $derived(music.members.has(selfDid));
  const pendingPlaylist = $derived(music.playlistRequests[0] ?? null);
  const listeners = $derived(
    Array.from(music.members.entries()).map(([did, name]) => ({
      did,
      name: did === music.ownerDid ? card.senderName : name,
    }))
  );

  $effect(() => {
    if (!transition?.playing) return;
    const timer = window.setInterval(() => (transitionNow = Date.now()), 250);
    return () => window.clearInterval(timer);
  });

  $effect(() => {
    const response = music.syncResponse;
    if (
      !response ||
      response.targetDid !== selfDid ||
      response.id !== activeResyncId
    )
      return;
    activeResyncId = null;
    transition = {
      token: transition?.token ?? 0,
      position: music.position,
      duration: response.duration || transition?.duration || duration,
      playing: music.playing,
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
      parkHandoff(
        current,
        player?.currentTime() ?? localPosition,
        duration,
        music.playing
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
    if (!joined || !current || music.closed) return;
    const requestId = selfDid === music.ownerDid ? "" : crypto.randomUUID();
    const takeover = takeParkedRendererControl(
      current,
      selfDid,
      music.ownerDid,
      requestId
    );
    if (takeover) {
      tileWasRendering = false;
      const h = takeover.handoff;
      // This is a fresh iframe even when the track did not change. Do not let
      // the previous card player's ready state release the handoff early.
      playerLoading = true;
      transition = h;
      transitionNow = Date.now();
      localPosition = h.position;
      // Suppress the join-sync effect that fires next: the handoff already
      // covers the auto-join activity the tile just created.
      syncedJoinCount = music.activitySeq;
      if (takeover.update.action === "resync") activeResyncId = requestId;
      void send(takeover.update);
    } else if (tileWasRendering) {
      // The tile stood down but nothing was parked - a teardown-order race
      // (the player unmounting before the cleanup read it), an expired
      // handoff, anything. Its last PUBLISHED position is still the best
      // truth held anywhere; without this the fresh card player fell back
      // to the stale synced position, usually second 0 of the video.
      tileWasRendering = false;
      const live = livePosition(music.position);
      if (live > music.position + 3) {
        playerLoading = true;
        transition = {
          token: 0,
          position: live,
          duration: liveDurationState.duration || duration || 0,
          playing: music.playing,
          at: Date.now(),
        };
        transitionNow = Date.now();
        localPosition = live;
        syncedJoinCount = music.activitySeq;
        const update = rendererSyncUpdate(
          selfDid,
          music.ownerDid,
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
    if (tilePresence.count > 0 || !joined || !current || music.closed) {
      host.setNowPlaying(null);
      return;
    }
    host.setNowPlaying({
      title: titles[current] ?? current,
      artist: "Waffle Party",
      artworkUrl: `https://i.ytimg.com/vi/${current}/hqdefault.jpg`,
      playing: music.playing,
      onPlay: () => void togglePlayback(),
      onPause: () => void togglePlayback(),
      onNext: () => void send({ action: "skip" }, "Skipping…"),
    });
    return () => host.setNowPlaying(null);
  });

  function departureAction(): { action: "close" | "leave" } | null {
    // The call tile is rendering the party: this card unmounting (scrolled
    // away, view switched) is NOT the user leaving. Closing here is what
    // froze the party the moment the owner joined a call.
    if (tilePresence.count > 0) return null;
    if (departureSent || music.closed || !joined) return null;
    departureSent = true;
    // Other members observe the host disconnect and apply the shared
    // reconnect grace; sending close here would bypass that protection.
    return selfDid === music.ownerDid ? null : { action: "leave" };
  }
  async function togglePlayback() {
    const position =
      player?.currentTime() ??
      (tilePresence.count > 0 ? livePosition(music.position) : rendererPosition);
    await send(
      { action: music.playing ? "pause" : "play", position, atMs: Date.now() },
      music.playing ? "Pausing…" : "Starting…"
    );
  }
  async function previous() {
    await send({ action: "previous" }, "Going to previous track…");
  }
  async function cycleLoop() {
    const mode =
      music.loop === "off" ? "track" : music.loop === "track" ? "queue" : "off";
    await send({ action: "loop", mode });
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
    if (music.currentIndex !== null)
      await send({ action: "ended", index: music.currentIndex });
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
          .filter(
            (item) => {
              const state = item.state as MusicState | undefined;
              return (
                item.id !== card.id &&
                !!state &&
                !state.closed &&
                state.members.has(selfDid)
              );
            }
          )
          .map((item) => host.sendUpdate(item.id, { action: "leave" }))
      );
    } catch (err) {
      console.warn("[waffle-party] joined party; old-party cleanup failed:", err);
    } finally {
      pending = null;
    }
  }
  function setVolume(value: number) {
    setAudioVolume(host.storage, value);
  }
  async function recreate() {
    if (!canRecreate || !music.queue.length) return;
    await host.sendCard({
      queue: music.queue,
      currentIndex: music.currentIndex ?? 0,
      ownerDid: selfDid,
    });
  }
  $effect(() => {
    const latest = music.activity.at(-1);
    const request = music.syncRequest;
    // Who answers is per-CASE: a join-sync falls to the standing responder,
    // a targeted request to anyone but its requester (owner preferred) - so
    // the party answers a refreshed HOST too, instead of owner-only
    // answering that left everyone stuck whenever the owner was the one
    // who went stale.
    const joinedNeedsSync =
      latest?.action === "joined" &&
      music.activitySeq !== syncedJoinCount &&
      selfDid === syncResponder(music);
    const requestNeedsSync =
      !!request &&
      request.id !== syncedRequestId &&
      selfDid === syncResponderFor(music, request.requesterDid);
    if (
      // The tile is the renderer: it owns the join-sync too, and this
      // card's player is not even mounted to read a position from.
      tilePresence.count > 0 ||
      (!joinedNeedsSync && !requestNeedsSync) ||
      music.currentIndex === null
    )
      return;
    syncedJoinCount = music.activitySeq;
    if (request) syncedRequestId = request.id;
    void send({
      action: "sync",
      index: music.currentIndex,
      position:
        player?.currentTime() ??
        (tilePresence.count > 0 ? livePosition(music.position) : rendererPosition),
      playing: music.playing,
      duration,
      atMs: Date.now(),
      ...(request
        ? { requestId: request.id, targetDid: request.requesterDid }
        : {}),
    });
  });
  async function add() {
    const playlistId = playlistIdFromUrl(url.trim());
    if (playlistId) {
      error = "";
      url = "";
      await send({ action: "add-playlist", playlistId }, "Adding playlist…");
      return;
    }
    const videoId = videoIdFromUrl(url.trim());
    if (!videoId) {
      error = "Paste a supported YouTube video or playlist URL.";
      return;
    }
    error = "";
    url = "";
    await send({ action: "add", videoId }, "Adding track…");
  }
  const link = (id: string) => `https://www.youtube.com/watch?v=${id}`;
  // Through the SHARED session cache (titles.ts), not a per-card fetch:
  // every rendered card refetching every queue entry meant a refresh with a
  // few parties in history fired the whole backlog of oEmbed calls at once.
  async function resolveTitle(videoId: string) {
    if (titles[videoId]) return;
    titles[videoId] = cachedTitle(videoId) ?? "Loading title…";
    titles[videoId] = await fetchTitle(videoId);
  }
  $effect(() => {
    // A closed party is a tombstone in history: never fetch for it, only
    // show what the session cache already knows.
    if (music.closed) {
      for (const videoId of music.queue) {
        if (!titles[videoId]) titles[videoId] = cachedTitle(videoId) ?? videoId;
      }
      return;
    }
    for (const videoId of music.queue) void resolveTitle(videoId);
  });
  $effect(() => {
    current;
    playerLoading = true;
  });
  async function resolvePlaylist(videoIds: string[]) {
    if (!pendingPlaylist || selfDid !== music.ownerDid) return;
    const batches = Array.from(
      { length: Math.ceil(videoIds.length / 2) },
      (_, index) => videoIds.slice(index * 2, index * 2 + 2)
    );
    for (const [index, batch] of batches.entries()) {
      await send(
        {
          action: "resolve-playlist",
          playlistId: pendingPlaylist,
          videoIds: batch,
          done: index === batches.length - 1,
        },
        `Adding playlist tracks (${Math.min((index + 1) * 2, videoIds.length)}/${videoIds.length})…`
      );
    }
  }
  $effect(() => {
    if (music.closed) refreshRecreate();
  });
  // A fresh mount of a PLAYING party (an F5, a room reopen) starts from the
  // folded position, which is only as fresh as the last action - ask a
  // member where the party actually is. The owner asks too: their own
  // folded state is exactly what went stale.
  let requestedMountResync = false;
  $effect(() => {
    if (
      requestedMountResync ||
      music.closed ||
      !joined ||
      !music.playing ||
      music.currentIndex === null ||
      music.members.size < 2 ||
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
    refreshRecreate();
    const unsubscribeCardStates = host.onCardStateChange(refreshRecreate);
    const identityTimer = window.setInterval(() => {
      selfDid = host.selfDid();
    }, 250);
    const hostDeparture = createHostDepartureGrace(
      music.ownerDid,
      () => host.peers(),
      () => void send({ action: "host-left" })
    );
    const unsubscribe = host.onPeerDisconnect((peer) => {
      // A card observes transport events before its join update is folded.
      // Do not let a pre-join relay flap declare the party host gone.
      if (
        music.closed ||
        !music.members.has(selfDid) ||
        !music.members.has(peer.did)
      )
        return;
      if (peer.did === music.ownerDid) hostDeparture.observeDisconnect(peer.did);
      else if (selfDid === music.ownerDid)
        void send({ action: "prune", did: peer.did });
    });
    const unsubscribeBeforeDisconnect = host.onBeforeDisconnect(() => {
      const action = departureAction();
      if (action) host.sendUpdateImmediately(card.id, action);
    });
    const pruneTimer = window.setInterval(() => {
      // Every member observes peer snapshots so a host reconnect cancels
      // its locally pending close, not only the party owner’s copy.
      hostDeparture.observePeers();
      if (
        Date.now() - mountedAt < 15_000 ||
        music.closed ||
        selfDid !== music.ownerDid
      )
        return;
      const connected = new Set([
        selfDid,
        ...host.peers().map((peer) => peer.did),
      ]);
      for (const did of music.members.keys()) {
        if (did !== music.ownerDid && !connected.has(did))
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
    <strong class="font-mono text-sm">Waffle Party</strong
    >{#if !music.closed}<span class="text-xs text-muted-foreground"
        >{music.members.size} listening</span
      >{/if}
  </div>
  {#if music.closed}<p class="py-8 text-center text-sm text-muted-foreground">
      The party is over.. heh..~
    </p>{#if canRecreate}<Tip text="Start a new party with the same queue">
      {#snippet children(props)}
        <button
          type="button"
          {...props}
          class="mx-auto block rounded bg-muted/70 px-3 py-2 text-xs text-foreground hover:bg-muted"
          onclick={recreate}
          aria-label="Start a new party with the same queue"
        >Start again</button>
      {/snippet}
    </Tip>{/if}{:else if joined && (current || pendingPlaylist)}<div class="space-y-1">
      {#if tilePresence.count > 0}
        <!-- ONE renderer at a time: while the call tile plays the party,
             this card is just a pointer to it. No second player, no muted
             shadow instance, no split lifecycle. -->
        <p
          class="rounded bg-primary/10 px-2 py-2 text-center font-mono text-xs text-primary"
        >
          ▶ Rendering in the call
        </p>
      {:else if current}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="relative"
        onpointerenter={() => (playerHover = true)}
        onpointerleave={() => (playerHover = false)}
      >
      <WafflePlayer
        bind:this={player}
        videoId={current}
        playing={music.playing}
        position={transition?.position ?? syncPosition}
        {volume}
        controls={false}
        {captions}
        cover={musicOnly && current
          ? `https://i.ytimg.com/vi/${current}/hqdefault.jpg`
          : null}
        onPosition={(value) => {
          localPosition = value;
          // Same drift correction as the call tile: local seek only, never
          // mid-handoff, never into a loading iframe. See watch-drift.ts.
          if (!playerLoading && !transition) {
            const target = driftSeekTarget(
              stateTick(music),
              clockEstimateFor(music.tickBy),
              music.tickBy === selfDid,
              { position: value, paused: !music.playing },
              Date.now()
            );
            if (target !== null && Date.now() - lastDriftSeekAt > 5000) {
              lastDriftSeekAt = Date.now();
              player?.seekLocal(target);
            }
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
      />
      {#if current}
        <!-- The same synced chrome the call tile renders: center
             play/pause, transport bar, vignette - revealed on hover. -->
        <WaffleSyncedControls
          playing={music.playing}
          position={localPosition}
          duration={rendererDuration}
          {volume}
          {captions}
          visible={playerHover}
          vignetteBoost
          docked={musicOnly}
          queueLabel={music.currentIndex !== null
            ? `${music.currentIndex + 1}/${music.queue.length}`
            : ""}
          onTogglePlay={() => void togglePlayback()}
          onPrevious={() => void previous()}
          onSkip={() => void send({ action: "skip" }, "Skipping…")}
          onSeek={(p) =>
            void send({ action: "seek", position: p, atMs: Date.now() })}
          onSeekBy={(d) => void seekBy(d)}
          onVolume={setVolume}
          onToggleCaptions={() => (captions = !captions)}
        />
      {/if}
      </div>
      {#if playerLoading}<p class="text-center text-xs text-muted-foreground">
          Loading player…
        </p>{/if}
      {:else}<p class="py-8 text-center text-sm text-muted-foreground">
        Loading playlist…
      </p>{/if}
    </div>{:else if !joined}<p
      class="py-5 text-center text-sm text-muted-foreground"
    >
      Join this party to listen together :3
    </p>{:else if joined && pendingPlaylist}<p
      class="text-sm text-muted-foreground"
    >
      Loading playlist…
    </p>{:else}<p class="text-sm text-muted-foreground">
      The queue is empty.
    </p>{/if}
  {#if pending}<p
      class="rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
      role="status"
    >
      {pending}
    </p>{/if}
  {#if pendingPlaylist && !pending}<p
      class="rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
      role="status"
    >
      Reading playlist…
    </p>{/if}
  {#if !music.closed && selfDid === music.ownerDid && pendingPlaylist}
    <!-- The owner's playlist resolver: a hidden cue-only player that exists
         to read the playlist's video ids and feed resolve-playlist batches.
         The VISIBLE player used to double as this, but only when nothing
         was playing - add a playlist mid-track (or while the call tile
         rendered) and the request sat unresolved forever. Keyed so each
         queued playlist gets a fresh iframe (the cue happens in onReady). -->
    {#key pendingPlaylist}
      <WafflePlayer
        videoId={null}
        playlistId={pendingPlaylist}
        playing={false}
        position={0}
        volume={0}
        controls={false}
        hidden
        onPlaylist={resolvePlaylist}
      />
    {/key}
  {/if}
  {#if !music.closed && joined}<div class="space-y-1">
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
        aria-label="Seek video"
      />
      <div class="-mt-2 pb-1 text-right font-mono text-[11px] text-muted-foreground">
        {formatTime(displayedPosition)} / {formatTime(rendererDuration)}
      </div>
      {/if}
      <div class="space-y-2 text-xs">
        <div class="flex items-center gap-2">
          <div class="flex gap-2">
          {#if !overlayControls}
          <Tip text="Previous track">
            {#snippet children(props)}
              <button
                {...props}
                class="rounded border border-border px-3 py-2 disabled:opacity-60"
                disabled={pending !== null}
                onclick={previous}
                aria-label="Previous track"><SkipBack class="size-4" /></button
              >
            {/snippet}
          </Tip>
          <Tip text={music.playing ? "Pause" : "Play"}>
            {#snippet children(props)}
              <button
                {...props}
                class="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-60"
                disabled={pending !== null}
                onclick={togglePlayback} aria-label={music.playing ? "Pause" : "Play"}>{#if music.playing}<Pause class="size-4" />{:else}<Play class="size-4" />{/if}</button
              >
            {/snippet}
          </Tip>
          <Tip text="Skip">
            {#snippet children(props)}
              <button
                {...props}
                class="rounded border border-border px-3 py-2 disabled:opacity-60"
                disabled={pending !== null}
                onclick={() => send({ action: "skip" }, "Skipping…")} aria-label="Skip"><SkipForward class="size-4" /></button
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
          <LoopButton
            mode={music.loop}
            disabled={pending !== null}
            onclick={cycleLoop}
          />
          {#if music.queue.length > 1}
            <Tip text="Shuffle queue (for everyone)">
              {#snippet children(props)}
                <button
                  {...props}
                  class="rounded border border-border px-3 py-2 hover:bg-muted disabled:opacity-60"
                  disabled={pending !== null}
                  onclick={() => send({ action: "shuffle" }, "Shuffling…")}
                  aria-label="Shuffle queue (for everyone)"
                  ><Shuffle class="size-4" /></button
                >
              {/snippet}
            </Tip>
          {/if}
          <Tip text={musicOnly ? "Show the video (only you)" : "Music only (only you)"}>
            {#snippet children(props)}
              <button
                {...props}
                class="rounded border px-3 py-2 transition-colors {queueButtonClass(
                  musicOnly
                )}"
                onclick={toggleMusicOnly}
                aria-label={musicOnly
                  ? "Show the video (only you)"
                  : "Music only (only you)"}
                aria-pressed={musicOnly}
                ><Music class="size-4" /></button
              >
            {/snippet}
          </Tip>
          </div>
          <div class="ml-auto flex gap-2">
          {#if selfDid === music.ownerDid}<Tip text="Disband party">
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
             reason. The readout is here because a bare track with no number
             gives no way to tell where you are or where you were. -->
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
               on every pixel of the drag. Same label as the call tile's, so
               the two surfaces describe the same control the same way. -->
          <span
            aria-hidden="true"
            class="w-8 shrink-0 text-right tabular-nums">{volume}%</span
          ></label
        >
        {/if}
      </div>
    </div>
    {#if queueOpen}
      <div class="space-y-2">
        <div class="flex gap-2">
          <input
            class="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-xs"
            disabled={pending !== null}
            bind:value={url}
            placeholder="YouTube video or playlist URL"
          /><Tip text="Add to queue">
            {#snippet children(props)}
              <button
                {...props}
                class="rounded border border-border px-2 text-xs disabled:opacity-60"
                disabled={pending !== null}
                onclick={add}
                aria-label="Add to queue"><Plus class="size-4" /></button
              >
            {/snippet}
          </Tip>
        </div>
        {#if error}<p class="text-xs text-destructive">{error}</p>{/if}
        <div
          class="queue-list max-h-52 space-y-1 overflow-y-scroll pr-1"
          style="max-height: 13rem; overflow-y: scroll; scrollbar-gutter: stable;"
        >
          {#each music.queue as videoId, index (index)}<div
              class="flex items-center justify-between gap-2 text-xs"
            >
              <button
                class="min-w-0 flex-1 truncate text-left text-primary underline disabled:opacity-60"
                disabled={pending !== null}
                onclick={() =>
                  send({ action: "select", index }, "Changing track…")}
                >#{index + 1} {titles[videoId] ?? "Loading title…"}</button
              ><Tip text="Remove track">
                {#snippet children(props)}
                  <button
                    {...props}
                    class="shrink-0 text-destructive disabled:opacity-60"
                    disabled={pending !== null}
                    onclick={() =>
                      send({ action: "remove", index }, "Removing track…")}
                    aria-label="Remove track"><Trash2 class="size-4" /></button
                  >
                {/snippet}
              </Tip>
            </div>{/each}
        </div>
      </div>
    {/if}{/if}{#if !music.closed && !joined}<Tip text="Join party">
      {#snippet children(props)}
        <button
          {...props}
          class="rounded bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-60"
          disabled={pending !== null}
          onclick={join}
          aria-label="Join party"
          ><LogIn class="size-4" /></button
        >
      {/snippet}
    </Tip>{/if}
  <div
    class="grid {music.closed
      ? 'grid-cols-1'
      : 'grid-cols-2'} gap-3 border-t border-border pt-2 text-xs text-muted-foreground"
  >
    <div>
      <div class="mb-1 font-medium text-card-foreground">Activity</div>
      {#each music.activity.slice(-4) as event, index (`${event.senderName}-${index}`)}<div
        >
          {event.senderName}
          {event.action}{#if event.videoId}&nbsp;<a
              class="text-primary underline"
              href={link(event.videoId)}
              target="_blank"
              rel="noreferrer">{titles[event.videoId] ?? "Loading title…"}</a
            >{/if}
        </div>{/each}
    </div>
    {#if !music.closed}<div>
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
