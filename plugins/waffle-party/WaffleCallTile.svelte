<script lang="ts">
  import { untrack } from "svelte";
  import { LogIn } from "@lucide/svelte";
  import type { HostApi } from "$lib/plugins/api";
  import type { Message } from "$lib/transport/transport.svelte";
  import { Tip } from "$lib/plugins/ui";
  import WafflePlayer from "./WafflePlayer.svelte";
  import WaffleSyncedControls from "./WaffleSyncedControls.svelte";
  import { seekTarget, stateTick, type MusicState } from "./logic";
  import { driftSeekTarget, projectedTickPosition } from "./watch-drift";
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
  import {
    audioVolume,
    initializeAudioVolume,
    setAudioVolume,
  } from "./audio-volume.svelte";
  import { cachedTitle, fetchTitle } from "./titles";

  interface Props {
    card: Message;
    cardState: unknown;
    host: HostApi;
    /** The host mirrors the call chrome: controls show while the mouse
     *  moves over the call section and hide with the call's own controls. */
    chromeVisible?: boolean;
  }
  let { card, cardState, host, chromeVisible = true }: Props = $props();
  const music = $derived(cardState as MusicState);

  const selfDid = untrack(() => host.selfDid());
  const joined = $derived(music.members.has(selfDid));
  const current = $derived(
    music.currentIndex === null ? null : music.queue[music.currentIndex]
  );

  let player = $state<WafflePlayer | null>(null);

  // This tile content only mounts after the user CLICKED the grid tile to
  // join it (click-to-join like screen shares) - that click is the intent,
  // so join the party too instead of showing a second Join button.
  let autoJoined = false;
  $effect(() => {
    if (autoJoined || joined || !current || music.closed) return;
    autoJoined = true;
    void send({ action: "join" });
  });
  const volume = $derived(audioVolume.value);
  let localPosition = $state(0);
  let duration = $state(0);
  let captions = $state(false);
  let lastDriftSeekAt = 0;
  // Keep a fresh clock offset to whoever wrote the current tick, so its
  // position projects onto this machine's clock.
  $effect(() => {
    if (music.tickBy && music.tickBy !== selfDid) ensureClock(host, music.tickBy);
  });
  // Where the party is RIGHT NOW per the tick, not where it was when the
  // tick was written. Recomputes when the state changes; between changes
  // the drift loop below keeps the player honest.
  const syncPosition = $derived(
    projectedTickPosition(
      stateTick(music),
      clockEstimateFor(music.tickBy),
      music.tickBy === selfDid,
      Date.now()
    ) ?? music.position
  );
  let playerLoading = $state(true);
  let activeResyncId = $state<string | null>(null);
  // Consume a parked card position only once when this renderer takes over.
  // Keeping peekHandoff() in the player prop would pin the iframe to the
  // parked timestamp and prevent later shared seek actions from reaching it.
  let handoffPosition = $state<number | null>(null);
  let handoffConsumed = $state(false);
  // Seeded from the current video; the effect below keeps it in step, so
  // this initial read is deliberately untracked.
  let handoffVideo = $state<string | null>(untrack(() => current));
  $effect(() => {
    if (current === handoffVideo) return;
    handoffVideo = current;
    handoffPosition = null;
    playerLoading = true;
    activeResyncId = null;
  });
  $effect(() => {
    if (!joined || !current) {
      handoffConsumed = false;
      return;
    }
    if (handoffConsumed) return;
    handoffConsumed = true;
    // Capture the card's live source BEFORE this tile increments presence and
    // makes the card stand down. Waiting even one microtask can miss that
    // source on the second chat -> tile transition.
    const requestId = selfDid === music.ownerDid ? "" : crypto.randomUUID();
    const takeover = takeLiveRendererControl(
      current,
      music.position,
      selfDid,
      music.ownerDid,
      requestId
    );
    playerLoading = true;
    handoffPosition = takeover.position;
    // Every renderer switch gets an authoritative network position too. The
    // owner publishes its captured time; listeners ask the owner to answer.
    if (takeover.update.action === "resync") activeResyncId = requestId;
    void send(takeover.update);
    syncedJoinCount = music.activitySeq;
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
    handoffPosition = music.position;
    if (response.duration > 0) {
      duration = response.duration;
      publishLiveDuration(response.duration);
    }
  });
  $effect(() => {
    void initializeAudioVolume(host.storage);
  });
  function setVolume(value: number) {
    setAudioVolume(host.storage, value);
  }

  // While this tile exists, it IS the party's renderer: the chat card
  // mounts no player, shows "Rendering in the call", and skips its
  // lifecycle side effects (its unmount closing the party as the owner is
  // what froze everything the moment the owner joined a call).
  $effect(() => {
    if (!joined || !current) return;
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
        current,
        player ? player.currentTime() : localPosition,
        duration,
        untrack(() => music.playing)
      );
      unregister();
      untrack(() => (tilePresence.count -= 1));
    };
  });

  // Lock screen / media keys: the RENDERER owns the OS media surface, and
  // the handlers fire SYNCED actions - a headset pause pauses the party
  // for everyone, exactly like the in-tile controls.
  let npTitle = $state("");
  $effect(() => {
    const id = current;
    if (!id) return;
    npTitle = cachedTitle(id) ?? id;
    void fetchTitle(id).then((t) => {
      if (current === id) npTitle = t;
    });
  });
  $effect(() => {
    if (!joined || !current) {
      host.setNowPlaying(null);
      return;
    }
    host.setNowPlaying({
      title: npTitle,
      artist: "Waffle Party",
      artworkUrl: `https://i.ytimg.com/vi/${current}/hqdefault.jpg`,
      playing: music.playing,
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
    const latest = music.activity.at(-1);
    const request = music.syncRequest;
    const joinedNeedsSync =
      latest?.action === "joined" && music.activitySeq !== syncedJoinCount;
    const requestNeedsSync = !!request && request.id !== syncedRequestId;
    if (
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
      position: player?.currentTime() ?? localPosition,
      playing: music.playing,
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
      console.error("[waffle-party] tile update failed:", err);
    }
  }

  async function togglePlayback() {
    const position = player?.currentTime() ?? localPosition;
    await send({
      action: music.playing ? "pause" : "play",
      position,
      atMs: Date.now(),
    });
  }

  async function skip() {
    await send({ action: "skip" });
  }

  async function previous() {
    await send({ action: "previous" });
  }

  async function seekTo(position: number) {
    await send({ action: "seek", position, atMs: Date.now() });
  }

  async function seekBy(delta: number) {
    const at = player?.currentTime() ?? localPosition;
    await seekTo(seekTarget(at, delta, duration));
  }

  async function ended() {
    if (music.currentIndex !== null)
      await send({ action: "ended", index: music.currentIndex });
  }

</script>

<div class="group/tile relative flex h-full w-full flex-col bg-black">
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
    <div class="waffle-tile-player absolute inset-0">
      <WafflePlayer
        bind:this={player}
        videoId={current}
        playing={music.playing}
        position={handoffPosition ?? syncPosition}
        {volume}
        controls={false}
        {captions}
        onPosition={(p) => {
          localPosition = p;
          publishLivePosition(p, music.playing);
          // Drift correction, once a second on the reporter's beat: seek
          // only when the projected party position and this player disagree
          // past the watch library's threshold. Rate nudges do not exist on
          // YouTube (fractional rates round away), and a correction never
          // fires mid-handoff or into a loading iframe.
          if (!playerLoading && handoffPosition === null) {
            const target = driftSeekTarget(
              stateTick(music),
              clockEstimateFor(music.tickBy),
              music.tickBy === selfDid,
              { position: p, paused: !music.playing },
              Date.now()
            );
            if (target !== null && Date.now() - lastDriftSeekAt > 5000) {
              lastDriftSeekAt = Date.now();
              player?.seekLocal(target);
            }
          }
          if (
            handoffPosition !== null &&
            handoffIsReadyToRelease(
              playerLoading,
              p,
              handoffPosition,
              duration
            )
          )
            handoffPosition = null;
        }}
        onDuration={(d) => {
          duration = d;
          publishLiveDuration(d);
        }}
        onReady={() => (playerLoading = false)}
        onPlayable={() => (playerLoading = false)}
        onError={() => (playerLoading = false)}
        onEnded={ended}
      />
    </div>
    <!-- No shield needed: the host renders this tile in a pointer-events-
         none layer, so YouTube's own (unsyncable) UI is unreachable by
         construction - only elements that re-enable pointer events act. -->

    <!-- The shared synced chrome: center play/pause, transport bar,
         vignette. pointer-events discipline lives inside the component -
         hidden chrome stays pass-through so clicking the tile still
         focuses it like every other stream. -->
    <WaffleSyncedControls
      playing={music.playing}
      position={localPosition}
      {duration}
      {volume}
      {captions}
      visible={chromeVisible}
      queueLabel={music.currentIndex !== null
        ? `${music.currentIndex + 1}/${music.queue.length}`
        : ""}
      onTogglePlay={() => void togglePlayback()}
      onPrevious={() => void previous()}
      onSkip={() => void skip()}
      onSeek={(p) => void seekTo(p)}
      onSeekBy={(d) => void seekBy(d)}
      onVolume={setVolume}
      onToggleCaptions={() => (captions = !captions)}
    />
  {:else}
    <div
      class="grid h-full w-full place-items-center font-mono text-xs text-muted-foreground"
    >
      Queue is empty - /play something
    </div>
  {/if}
</div>

<style>
  .waffle-tile-player :global(> div),
  .waffle-tile-player :global(> div > div) {
    height: 100%;
    min-height: 0;
    border: none;
    border-radius: 0;
  }
  .waffle-tile-player :global(iframe) {
    width: 100%;
    height: 100%;
  }
</style>
