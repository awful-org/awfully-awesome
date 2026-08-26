<script module lang="ts">
  // Titles survive widget remounts (room switches re-render the sidebar).
  const titleCache = new Map<string, string>();
</script>

<script lang="ts">
  import { tick } from "svelte";
  import { Play, Pause, SkipBack, SkipForward } from "@lucide/svelte";
  import type { HostApi } from "$lib/plugins/api";
  import type { Message } from "$lib/transport/transport.svelte";
  import type { MusicState } from "./logic";
  import { livePosition } from "./tile-presence.svelte";

  interface Props {
    card: Message;
    cardState: unknown;
    host: HostApi;
  }
  let { card, cardState, host }: Props = $props();
  const music = $derived(cardState as MusicState);
  const current = $derived(
    music.currentIndex === null ? null : music.queue[music.currentIndex]
  );

  let title = $state("");
  $effect(() => {
    const id = current;
    if (!id) {
      title = "";
      return;
    }
    const cached = titleCache.get(id);
    if (cached) {
      title = cached;
      return;
    }
    title = "…";
    void (async () => {
      try {
        const res = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(
            `https://www.youtube.com/watch?v=${id}`
          )}&format=json`
        );
        const data = (await res.json()) as { title?: unknown };
        const t = typeof data.title === "string" ? data.title : id;
        titleCache.set(id, t);
        if (current === id) title = t;
      } catch {
        if (current === id) title = id;
      }
    })();
  });

  async function send(data: unknown) {
    try {
      await host.sendUpdate(card.id, data);
    } catch (err) {
      console.error("[waffle-party] widget update failed:", err);
    }
  }

  // Long titles marquee-scroll so the whole name is readable in the strip;
  // hovering pauses the crawl to read or select. Short titles sit still -
  // the animation only arms when the text actually overflows.
  let titleWrap = $state<HTMLElement | null>(null);
  let titleInner = $state<HTMLElement | null>(null);
  let scrolling = $state(false);
  $effect(() => {
    void title;
    scrolling = false;
    void tick().then(() => {
      if (titleWrap && titleInner) {
        scrolling = titleInner.scrollWidth > titleWrap.clientWidth;
      }
    });
  });

  /** No live player here: early tracks restart, otherwise previous. */
  async function previous() {
    if (music.currentIndex !== null && music.currentIndex > 0) {
      await send({ action: "select", index: music.currentIndex - 1 });
    } else {
      await send({ action: "seek", position: 0 });
    }
  }
</script>

<!-- One row of simple controls: the widget surface is a strip, not a card. -->
<div class="flex w-full items-center gap-1.5">
  {#if music.closed}
    <span class="truncate text-xs text-muted-foreground">Party over</span>
  {:else if current}
    <button
      type="button"
      onclick={previous}
      aria-label="Previous track"
      class="shrink-0 cursor-pointer rounded bg-primary/15 p-1 text-primary hover:bg-primary/25"
    >
      <SkipBack class="size-3" />
    </button>
    <button
      type="button"
      onclick={() =>
        send({
          action: music.playing ? "pause" : "play",
          // The live player's position when one renders in this tab; the
          // stale synced one rewound the whole party on pause otherwise.
          position: livePosition(music.position),
        })}
      aria-label={music.playing ? "Pause" : "Play"}
      class="shrink-0 cursor-pointer rounded bg-primary/15 p-1 text-primary hover:bg-primary/25"
    >
      {#if music.playing}<Pause class="size-3" />{:else}<Play
          class="size-3"
        />{/if}
    </button>
    <button
      type="button"
      onclick={() => send({ action: "skip" })}
      aria-label="Next track"
      class="shrink-0 cursor-pointer rounded bg-primary/15 p-1 text-primary hover:bg-primary/25"
    >
      <SkipForward class="size-3" />
    </button>
    <!-- The label stays put; only the NAME rides the marquee. -->
    <span
      class="flex min-w-0 flex-1 items-baseline gap-1 font-mono text-[11px] text-muted-foreground"
    >
      <span class="shrink-0">Playing:</span>
      <span
        bind:this={titleWrap}
        class="waffle-marquee-wrap min-w-0 flex-1 overflow-hidden whitespace-nowrap"
        title={title}
      >
        <span
          bind:this={titleInner}
          class="inline-block {scrolling ? 'waffle-marquee' : ''}"
          style={scrolling ? `animation-duration: ${title.length * 0.35}s` : ""}
        >
          {title}{#if scrolling}<span class="inline-block w-10"
            ></span>{title}{/if}
        </span>
      </span>
    </span>
  {:else}
    <span class="truncate font-mono text-[11px] text-muted-foreground"
      >Queue empty</span
    >
  {/if}
</div>

<style>
  .waffle-marquee {
    animation: waffle-crawl linear infinite;
  }
  /* Pause on hover so the title can be read or selected. */
  .waffle-marquee-wrap:hover .waffle-marquee {
    animation-play-state: paused;
  }
  @keyframes waffle-crawl {
    from {
      transform: translateX(0);
    }
    to {
      /* The inner holds two copies plus the gap; -50% lands exactly on the
         second copy, so the loop restart is invisible. */
      transform: translateX(-50%);
    }
  }
</style>
