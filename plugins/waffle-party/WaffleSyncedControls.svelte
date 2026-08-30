<script lang="ts">
  import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    RotateCcw,
    RotateCw,
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
    /** Heavier edge darkening - the message card sits inside the chat, so
     *  it needs more contrast to read as "our" player than the call tile. */
    vignetteBoost?: boolean;
    /** Music-only: render the transport bar in NORMAL FLOW below the player
     *  instead of overlay chrome - no vignette, no center button, always
     *  visible. The `visible` prop is ignored. */
    docked?: boolean;
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
    vignetteBoost = false,
    docked = false,
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

  // Hover preview: the timestamp you'd jump to if you clicked here.
  let hoverTime = $state<number | null>(null);
  let hoverX = $state(0);
  function onSeekHover(event: PointerEvent): void {
    const el = event.currentTarget as HTMLInputElement;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width)
    );
    hoverTime = ratio * Math.max(duration, 1);
    hoverX = ratio * rect.width;
  }

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
{#snippet transport()}
    <div class="relative">
      {#if hoverTime !== null}
        <span
          class="pointer-events-none absolute bottom-full mb-1.5 -translate-x-1/2 rounded bg-black/85 px-1.5 py-0.5 font-mono text-[10px] text-white"
          style="left: {hoverX}px"
        >
          {fmt(hoverTime)}
        </span>
      {/if}
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
        onpointermove={onSeekHover}
        onpointerleave={() => (hoverTime = null)}
        aria-label="Seek (for everyone)"
        class="h-1 w-full cursor-pointer accent-white"
      />
    </div>
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
            <RotateCcw class="size-3.5" />
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
            <RotateCw class="size-3.5" />
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
{/snippet}

{#if docked}
  <!-- Music-only: the same bar, standing below the player instead of
       floating over it. Dark panel so the white-on-dark buttons read
       in both themes. -->
  <div class="flex flex-col gap-1 rounded-md border border-border bg-black/90 px-3 py-2">
    {@render transport()}
  </div>
{:else}
<div class="pointer-events-none absolute inset-0 z-20">
  <!-- Edge darkening: faded gradients on every side plus an inset glow,
       always on and stronger while the chrome shows - the point is that
       YouTube's own branding recedes and the party's UI reads as the
       player. -->
  <div
    class="absolute inset-0 transition-opacity duration-300 {visible
      ? 'opacity-100'
      : 'opacity-80'}"
    style={vignetteBoost
      ? `background:
        linear-gradient(to right, rgba(0,0,0,0.85), transparent 20%, transparent 80%, rgba(0,0,0,0.85)),
        linear-gradient(to bottom, rgba(0,0,0,0.8), transparent 25%, transparent 60%, rgba(0,0,0,0.92));
      box-shadow: inset 0 0 110px 40px rgba(0,0,0,0.75)`
      : `background:
        linear-gradient(to right, rgba(0,0,0,0.6), transparent 16%, transparent 84%, rgba(0,0,0,0.6)),
        linear-gradient(to bottom, rgba(0,0,0,0.55), transparent 20%, transparent 65%, rgba(0,0,0,0.8));
      box-shadow: inset 0 0 80px 20px rgba(0,0,0,0.6)`}
    aria-hidden="true"
  ></div>

  <button
    type="button"
    onclick={(e) => {
      e.stopPropagation();
      onTogglePlay();
    }}
    aria-label={playing ? "Pause for everyone" : "Play for everyone"}
    class="absolute left-1/2 top-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-black/60 text-white transition hover:scale-105 hover:bg-black/75 {visible
      ? 'pointer-events-auto opacity-100'
      : 'pointer-events-none opacity-0'}"
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
    {@render transport()}
  </div>
</div>
{/if}
