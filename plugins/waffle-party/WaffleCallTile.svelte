<script lang="ts">
  import { untrack } from "svelte";
  import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    LogIn,
    Volume2,
  } from "@lucide/svelte";
  import type { HostApi } from "$lib/plugins/api";
  import type { Message } from "$lib/transport/transport.svelte";
  import WafflePlayer from "./WafflePlayer.svelte";
  import { syncResponder, type MusicState } from "./logic";
  import {
    tilePresence,
    publishLiveDuration,
    publishLivePosition,
    registerPositionSource,
    parkHandoff,
  } from "./tile-presence.svelte";
  import { readAudioPrefs, writeAudioPrefs } from "./audio-prefs";
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

  const selfDid = host.selfDid();
  const joined = $derived(music.members.has(selfDid));
  const current = $derived(
    music.currentIndex === null ? null : music.queue[music.currentIndex]
  );

  let player: WafflePlayer | null = null;

  // This tile content only mounts after the user CLICKED the grid tile to
  // join it (click-to-join like screen shares) - that click is the intent,
  // so join the party too instead of showing a second Join button.
  let autoJoined = false;
  $effect(() => {
    if (autoJoined || joined || !current || music.closed) return;
    autoJoined = true;
    void send({ action: "join" });
  });
  let volume = $state(100);
  let localPosition = $state(0);
  let duration = $state(0);
  let seeking = $state(false);
  let seekValue = $state(0);
  // Consume a parked card position only once when this renderer takes over.
  // Keeping peekHandoff() in the player prop would pin the iframe to the
  // parked timestamp and prevent later shared seek actions from reaching it.
  let handoffPosition = $state<number | null>(null);
  let handoffConsumed = $state(false);
  let handoffVideo = $state<string | null>(current);
  $effect(() => {
    if (current === handoffVideo) return;
    handoffVideo = current;
    handoffPosition = null;
  });
  $effect(() => {
    if (!joined || !current) {
      handoffConsumed = false;
      return;
    }
    if (handoffConsumed) return;
    handoffConsumed = true;
    // The card parks its position as tilePresence changes. Defer one microtask
    // so that parked handoff is available when this tile takes over.
    queueMicrotask(() => {
      const handoff = takeHandoff();
      if (handoff) handoffPosition = handoff.position;
    });
  });
  $effect(() => {
    void readAudioPrefs(host.storage).then((value) => (volume = value));
  });
  function setVolume(value: number) {
    volume = value;
    void writeAudioPrefs(host.storage, value);
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
        player ? player.currentTime() : localPosition,
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
  $effect(() => {
    const latest = music.activity.at(-1);
    if (
      selfDid !== syncResponder(music) ||
      latest?.action !== "joined" ||
      music.activitySeq === syncedJoinCount ||
      music.currentIndex === null
    )
      return;
    syncedJoinCount = music.activitySeq;
    void send({
      action: "sync",
      index: music.currentIndex,
      position: player?.currentTime() ?? localPosition,
      playing: music.playing,
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
    await send({ action: music.playing ? "pause" : "play", position });
  }

  async function skip() {
    await send({ action: "skip" });
  }

  async function previous() {
    await send({ action: "previous" });
  }

  async function seekTo(position: number) {
    await send({ action: "seek", position });
  }

  async function ended() {
    if (music.currentIndex !== null)
      await send({ action: "ended", index: music.currentIndex });
  }

  function fmt(s: number): string {
    if (!Number.isFinite(s) || s < 0) return "0:00";
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${r.toString().padStart(2, "0")}`;
  }
</script>

<div class="group/tile relative flex h-full w-full flex-col bg-black">
  {#if !joined}
    <div class="grid h-full w-full place-items-center">
      <button
        type="button"
        onclick={(e) => {
          e.stopPropagation();
          void send({ action: "join" });
        }}
        aria-label="Join party"
        title="Join party"
        class="pointer-events-auto cursor-pointer rounded-full border border-border bg-background/95 p-2 text-foreground shadow-sm hover:border-primary/60"
      >
        <LogIn class="size-4" />
      </button>
    </div>
  {:else if current}
    <div class="waffle-tile-player absolute inset-0">
      <WafflePlayer
        bind:this={player}
        videoId={current}
        playing={music.playing}
        position={handoffPosition ?? music.position}
        {volume}
        controls={false}
        onPosition={(p) => {
          localPosition = p;
          publishLivePosition(p, music.playing);
          if (!seeking) seekValue = p;
        }}
        onDuration={(d) => {
          duration = d;
          publishLiveDuration(d);
        }}
        onEnded={ended}
      />
    </div>
    <!-- No shield needed: the host renders this tile in a pointer-events-
         none layer, so YouTube's own (unsyncable) UI is unreachable by
         construction - only elements that re-enable pointer events act. -->

    <!-- Center play/pause: THE most common action deserves the biggest
         target. It reveals itself when the cursor reaches the center; the
         rest of the tile stays pass-through, so clicking anywhere else
         still focuses the tile like every other stream. -->
    <button
      type="button"
      onclick={(e) => {
        e.stopPropagation();
        void togglePlayback();
      }}
      aria-label={music.playing ? "Pause for everyone" : "Play for everyone"}
      title={music.playing ? "Pause for everyone" : "Play for everyone"}
      class="pointer-events-auto absolute left-1/2 top-1/2 z-20 grid size-14 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
    >
      {#if music.playing}<Pause class="size-6" />{:else}<Play
          class="size-6"
        />{/if}
    </button>


    <!-- Synced controls: the only controls that exist. pointer-events-auto
         opts them back in from the host's pass-through layer; the
         stopPropagation keeps a control click from doubling as the
         placeholder's click-to-primary. -->
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      class="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-8 transition-opacity focus-within:opacity-100 {chromeVisible
        ? 'pointer-events-auto opacity-100'
        : 'pointer-events-none opacity-0'}"
    >
      <input
        type="range"
        min="0"
        max={Math.max(duration, 1)}
        step="1"
        bind:value={seekValue}
        oninput={() => (seeking = true)}
        onchange={() => {
          seeking = false;
          void seekTo(seekValue);
        }}
        aria-label="Seek (for everyone)"
        class="h-1 w-full cursor-pointer accent-white"
      />
      <div class="flex items-center gap-1.5">
        <button
          type="button"
          onclick={previous}
          aria-label="Previous track"
          title="Previous track"
          class="cursor-pointer rounded bg-white/10 p-1.5 text-white hover:bg-white/20"
        >
          <SkipBack class="size-3.5" />
        </button>
        <button
          type="button"
          onclick={togglePlayback}
          aria-label={music.playing ? "Pause for everyone" : "Play for everyone"}
          title={music.playing ? "Pause for everyone" : "Play for everyone"}
          class="cursor-pointer rounded bg-white/15 p-1.5 text-white hover:bg-white/25"
        >
          {#if music.playing}<Pause class="size-3.5" />{:else}<Play
              class="size-3.5"
            />{/if}
        </button>
        <button
          type="button"
          onclick={skip}
          aria-label="Next track"
          title="Next track"
          class="cursor-pointer rounded bg-white/10 p-1.5 text-white hover:bg-white/20"
        >
          <SkipForward class="size-3.5" />
        </button>
        <span class="font-mono text-[10px] text-white/70">
          {fmt(seekValue)} / {fmt(duration)}
        </span>
        <span class="ml-auto flex items-center gap-1">
          <Volume2 class="size-3.5 text-white/70" />
          <input
            type="range"
            min="0"
            max="100"
            bind:value={volume}
            oninput={(event) => setVolume(Number(event.currentTarget.value))}
            aria-label="Volume (only you)"
            class="h-1 w-20 cursor-pointer accent-white"
          />
        </span>
        <span class="font-mono text-[10px] text-white/70">
          {#if music.currentIndex !== null}{music.currentIndex + 1}/{music.queue
              .length}{/if}
        </span>
      </div>
    </div>
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
