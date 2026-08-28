<script lang="ts">
  import { onMount } from "svelte";
  import {
    Ban,
    CircleOff,
    List,
    ListMusic,
    LogIn,
    LogOut,
    Pause,
    Play,
    Plus,
    Repeat1,
    SkipBack,
    SkipForward,
    Trash2,
  } from "@lucide/svelte";
  import type { HostApi } from "$lib/plugins/api";
  import type { Message } from "$lib/transport/transport.svelte";
  import WafflePlayer from "./WafflePlayer.svelte";
  import {
    playlistIdFromUrl,
    videoIdFromUrl,
    type MusicState,
  } from "./logic";
  import {
    tilePresence,
    registerPositionSource,
    livePosition,
    liveDurationState,
    parkHandoff,
    takeHandoff,
    handoffIsReadyToRelease,
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
  let player: WafflePlayer | null = null;
  let localPosition = $state(music.position);
  let transition = $state<RendererHandoff | null>(null);
  let transitionNow = $state(Date.now());
  let activeResyncId = $state<string | null>(null);
  let duration = $state(0);
  let seekValue = $state(music.position);
  let seeking = $state(false);
  let syncedJoinCount = 0;
  let syncedRequestId = "";
  let titles = $state<Record<string, string>>({});
  const volume = $derived(audioVolume.value);
  let pending = $state<string | null>(null);
  let playerLoading = $state(true);
  let selfDid = $state(host.selfDid());
  const mountedAt = Date.now();
  let departureSent = false;
  let canRecreate = $state(false);
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
    Array.from(music.members.entries()).map(([did, name]) =>
      did === music.ownerDid ? card.senderName : name
    )
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
  $effect(() => {
    if (tilePresence.count > 0 || !joined || !current || music.closed) return;
    const h = takeHandoff(current);
    if (h) {
      // This is a fresh iframe even when the track did not change. Do not let
      // the previous card player's ready state release the handoff early.
      playerLoading = true;
      transition = h;
      transitionNow = Date.now();
      localPosition = h.position;
      // Suppress the join-sync effect that fires next: the handoff already
      // covers the auto-join activity the tile just created.
      syncedJoinCount = music.activitySeq;
      if (selfDid === music.ownerDid && Math.abs(h.position - music.position) > 2)
        void send({ action: "seek", position: Math.floor(h.position) });
      else if (selfDid !== music.ownerDid) {
        const requestId = crypto.randomUUID();
        activeResyncId = requestId;
        void send({
          action: "resync",
          requestId,
          requesterDid: selfDid,
        });
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
      { action: music.playing ? "pause" : "play", position },
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
  function commitSeek() {
    seeking = false;
    transition = null;
    void send({ action: "seek", position: seekValue });
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
    const joinedNeedsSync =
      latest?.action === "joined" && music.activitySeq !== syncedJoinCount;
    const requestNeedsSync = !!request && request.id !== syncedRequestId;
    if (
      // The tile is the renderer: it owns the join-sync too, and this
      // card's player is not even mounted to read a position from.
      tilePresence.count > 0 ||
      selfDid !== music.ownerDid ||
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
  onMount(() => {
    void initializeAudioVolume(host.storage);
    let refreshInFlight = false;
    let refreshQueued = false;
    let wasClosed = music.closed;
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
    </p>{#if canRecreate}<button
        type="button"
        class="mx-auto block rounded bg-muted/70 px-3 py-2 text-xs text-foreground hover:bg-muted"
        onclick={recreate}
        aria-label="Recruwuate party :3"
        title="Recruwuate party :3"
      >Recruwuate party :3</button
    >{/if}{:else if joined && (current || pendingPlaylist)}<div class="space-y-1">
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
      <WafflePlayer
        bind:this={player}
        videoId={current}
        playlistId={current ? null : pendingPlaylist}
        playing={current ? music.playing : false}
        position={transition?.position ?? music.position}
        {volume}
        onPosition={(value) => {
          localPosition = value;
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
        onPlaylist={selfDid === music.ownerDid ? resolvePlaylist : undefined}
      />{#if playerLoading}<p class="text-center text-xs text-muted-foreground">
          Loading player…
        </p>{/if}
      {/if}
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
  {#if !music.closed && joined}<div class="space-y-1">
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
      <div class="space-y-2 text-xs">
        <div class="flex items-center gap-2">
          <div class="flex gap-2">
          <button
            class="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-60"
            disabled={pending !== null}
            onclick={togglePlayback} aria-label={music.playing ? "Pause" : "Play"} title={music.playing ? "Pause" : "Play"}>{#if music.playing}<Pause class="size-4" />{:else}<Play class="size-4" />{/if}</button
          >
          <button
            class="rounded border border-border px-3 py-2 disabled:opacity-60"
            disabled={pending !== null}
            onclick={previous}
            aria-label="Previous track" title="Previous track"><SkipBack class="size-4" /></button
          >
          <button
            class="rounded border border-border px-3 py-2 disabled:opacity-60"
            disabled={pending !== null}
            onclick={() => send({ action: "skip" }, "Skipping…")} aria-label="Skip" title="Skip"><SkipForward class="size-4" /></button
          >
          <button
            class="rounded border border-border px-3 py-2 {queueOpen
              ? 'border-primary bg-primary text-primary-foreground'
              : ''}"
            onclick={() => (queueOpen = !queueOpen)}
            aria-label={queueOpen ? "Hide queue" : "Show queue"} title={queueOpen ? "Hide queue" : "Show queue"}><List class="size-4" /></button
          >
          <button
            class="flex items-center gap-1 rounded border border-border px-3 py-2 disabled:opacity-60"
            disabled={pending !== null}
            onclick={cycleLoop}
            aria-label={`Loop mode: ${music.loop}`}
            title={`Loop mode: ${music.loop}. Click to change.`}
          >{#if music.loop === "off"}<Ban class="size-4" />{:else if music.loop === "track"}<Repeat1 class="size-4" />{:else}<ListMusic class="size-4" />{/if}</button>
          </div>
          <div class="ml-auto flex gap-2">
          {#if selfDid === music.ownerDid}<button
              class="rounded border border-destructive px-3 py-2 text-destructive disabled:opacity-60"
              disabled={pending !== null}
              onclick={() => send({ action: "close" }, "Disbanding party…")}
              aria-label="Disband party"
              title="Disband party"
              ><CircleOff class="size-4" /></button
            >{:else}<button
              class="rounded border border-border px-3 py-2 disabled:opacity-60"
              disabled={pending !== null}
              onclick={() => send({ action: "leave" }, "Leaving party…")}
              aria-label="Leave party"
              title="Leave party"
              ><LogOut class="size-4" /></button
            >{/if}
          </div>
        </div>
        <label class="flex items-center gap-2"
          >Vol <input
            class="w-1/4 max-w-24"
            type="range"
            min="0"
            max="100"
            value={volume}
            onchange={(event) => setVolume(Number(event.currentTarget.value))}
          /></label
        >
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
          /><button
            class="rounded border border-border px-2 text-xs disabled:opacity-60"
            disabled={pending !== null}
            onclick={add}
            aria-label="Add to queue"
            title="Add to queue"><Plus class="size-4" /></button
          >
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
              ><button
                class="shrink-0 text-destructive disabled:opacity-60"
                disabled={pending !== null}
                onclick={() =>
                  send({ action: "remove", index }, "Removing track…")}
                aria-label="Remove track" title="Remove track"><Trash2 class="size-4" /></button
              >
            </div>{/each}
        </div>
      </div>
    {/if}{/if}{#if !music.closed && !joined}<button
      class="rounded bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-60"
      disabled={pending !== null}
      onclick={join}
      aria-label="Join party"
      title="Join party"
      ><LogIn class="size-4" /></button
    >{/if}
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
        {#each listeners as listener (listener)}<div class="truncate">
            {listener}
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
