<script lang="ts">
  import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Rewind,
    FastForward,
    Volume2,
    Subtitles,
  } from "@lucide/svelte";
  import { Tip } from "$lib/plugins/ui";

  interface Props {
    playing: boolean;
    /** Live playback position; the slider follows it unless dragging. */
    position: number;
    duration: number;
    volume: number;
    captions: boolean;
    /** Chrome visibility - the tile mirrors the call's chrome, the card its
     *  own hover. Hidden chrome is also pointer-inert, so the surface
     *  underneath keeps its own click behavior. */
    visible: boolean;
    /** "3/12" queue readout; empty hides it. */
    queueLabel?: string;
    onTogglePlay: () => void;
    onPrevious: () => void;
    onSkip: () => void;
    onSeek: (position: number) => void;
    /** Relative nudge; the parent clamps via seekTarget. */
    onSeekBy: (delta: number) => void;
    onVolume: (value: number) => void;
    onToggleCaptions: () => void;
  }
  let {
    playing,
    position,
    duration,
    volume,
    captions,
    visible,
    queueLabel = "",
    onTogglePlay,
    onPrevious,
    onSkip,
    onSeek,
    onSeekBy,
    onVolume,
    onToggleCaptions,
  }: Props = $props();

  let seeking = $state(false);
  let seekValue = $state(0);
  $effect(() => {
    if (!seeking) seekValue = position;
  });

  function fmt(s: number): string {
    if (!Number.isFinite(s) || s < 0) return "0:00";
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${r.toString().padStart(2, "0")}`;
  }
</script>

<!-- The synced control chrome both waffle surfaces share: a vignette that
     mutes YouTube's own branding so this UI reads as the player, a center
     play/pause (the most common action deserves the biggest target), and
     the bottom transport bar. The root is pointer-inert; only the controls
     opt back in, so the surface underneath keeps its click behavior. -->
<div class="pointer-events-none absolute inset-0 z-20">
  <!-- Edge darkening: always on, a touch stronger while the chrome shows. -->
  <div
    class="absolute inset-0 transition-opacity duration-300 {visible
      ? 'opacity-100'
      : 'opacity-60'}"
    style="box-shadow: inset 0 0 48px 12px rgba(0,0,0,0.55)"
    aria-hidden="true"
  ></div>

  <button
    type="button"
    onclick={(e) => {
      e.stopPropagation();
      onTogglePlay();
    }}
    aria-label={playing ? "Pause for everyone" : "Play for everyone"}
    class="absolute left-1/2 top-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-black/60 text-white opacity-0 transition hover:scale-105 hover:bg-black/75 focus-visible:opacity-100 {visible
      ? 'pointer-events-auto hover:opacity-100'
      : 'pointer-events-none'}"
  >
    {#if playing}<Pause class="size-6" />{:else}<Play class="size-6" />{/if}
  </button>

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    onclick={(e) => e.stopPropagation()}
    class="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-8 transition-opacity focus-within:opacity-100 {visible
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
        onSeek(seekValue);
      }}
      aria-label="Seek (for everyone)"
      class="h-1 w-full cursor-pointer accent-white"
    />
    <div class="flex items-center gap-1.5">
      <Tip text="Previous track">
        {#snippet children(props)}
          <button
            type="button"
            {...props}
            onclick={onPrevious}
            aria-label="Previous track"
            class="cursor-pointer rounded bg-white/10 p-1.5 text-white transition hover:bg-white/25"
          >
            <SkipBack class="size-3.5" />
          </button>
        {/snippet}
      </Tip>
      <Tip text="Back 10s (for everyone)">
        {#snippet children(props)}
          <button
            type="button"
            {...props}
            onclick={() => onSeekBy(-10)}
            aria-label="Back 10 seconds (for everyone)"
            class="cursor-pointer rounded bg-white/10 p-1.5 text-white transition hover:bg-white/25"
          >
            <Rewind class="size-3.5" />
          </button>
        {/snippet}
      </Tip>
      <Tip text={playing ? "Pause for everyone" : "Play for everyone"}>
        {#snippet children(props)}
          <button
            type="button"
            {...props}
            onclick={onTogglePlay}
            aria-label={playing ? "Pause for everyone" : "Play for everyone"}
            class="cursor-pointer rounded bg-white/15 p-1.5 text-white transition hover:bg-white/30"
          >
            {#if playing}<Pause class="size-3.5" />{:else}<Play
                class="size-3.5"
              />{/if}
          </button>
        {/snippet}
      </Tip>
      <Tip text="Forward 10s (for everyone)">
        {#snippet children(props)}
          <button
            type="button"
            {...props}
            onclick={() => onSeekBy(10)}
            aria-label="Forward 10 seconds (for everyone)"
            class="cursor-pointer rounded bg-white/10 p-1.5 text-white transition hover:bg-white/25"
          >
            <FastForward class="size-3.5" />
          </button>
        {/snippet}
      </Tip>
      <Tip text="Next track">
        {#snippet children(props)}
          <button
            type="button"
            {...props}
            onclick={onSkip}
            aria-label="Next track"
            class="cursor-pointer rounded bg-white/10 p-1.5 text-white transition hover:bg-white/25"
          >
            <SkipForward class="size-3.5" />
          </button>
        {/snippet}
      </Tip>
      <span class="font-mono text-[10px] text-white/70">
        {fmt(seekValue)} / {fmt(duration)}
      </span>
      <span class="ml-auto flex items-center gap-1.5">
        <Tip text={captions ? "Hide subtitles (only you)" : "Subtitles (only you)"}>
          {#snippet children(props)}
            <button
              type="button"
              {...props}
              onclick={onToggleCaptions}
              aria-label={captions
                ? "Hide subtitles (only you)"
                : "Show subtitles (only you)"}
              aria-pressed={captions}
              class="cursor-pointer rounded p-1.5 transition {captions
                ? 'bg-white/25 text-white'
                : 'bg-white/10 text-white/70 hover:bg-white/20 hover:text-white'}"
            >
              <Subtitles class="size-3.5" />
            </button>
          {/snippet}
        </Tip>
        <Volume2 class="size-3.5 text-white/70" />
        <input
          type="range"
          min="0"
          max="100"
          value={volume}
          oninput={(event) => onVolume(Number(event.currentTarget.value))}
          aria-label="Volume (only you)"
          class="h-1 w-20 cursor-pointer accent-white"
        />
      </span>
      {#if queueLabel}
        <span class="font-mono text-[10px] text-white/70">{queueLabel}</span>
      {/if}
    </div>
  </div>
</div>
