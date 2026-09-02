<script lang="ts">
  import { tick } from "svelte";
  import { Play, Pause, SkipBack, SkipForward } from "@lucide/svelte";
  import type { HostApi } from "$lib/plugins/api";
  import type { Message } from "$lib/transport/transport.svelte";
  import { initialState, type AnimeState } from "./logic";
  import { Tip } from "$lib/plugins/ui";
  import { livePosition } from "./tile-presence.svelte";
  import { episodeLabel } from "./titles";
  import { episodes as fetchEpisodes, type Episode } from "./anidb";

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
  const current = $derived(
    anime.currentIndex === null ? null : anime.queue[anime.currentIndex]
  );
  // Nothing to fetch and nothing to cache: the name of a track is the show
  // and the episode number, both already folded into the state.
  const title = $derived(current ? episodeLabel(anime.show, current) : "");

  // The show's full episode list, so Next and Previous walk the SHOW, not
  // just the queue. Same cached, deduped episodes() call the card uses; the
  // strip only mounts it while a show is actually playing.
  let episodeList = $state<Episode[]>([]);
  let episodesLoadedFor = "";
  $effect(() => {
    const showId = anime.show?.id;
    if (!showId || !current || showId === episodesLoadedFor) return;
    episodesLoadedFor = showId;
    episodeList = [];
    void fetchEpisodes(showId)
      .then((list) => {
        episodeList = list;
      })
      .catch(() => {
        // Best-effort enrichment; navigation still no-ops safely without it.
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

  async function send(data: unknown) {
    try {
      await host.sendUpdate(card.id, data);
    } catch (err) {
      console.error("[anime-party] widget update failed:", err);
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

  /** Next and Previous walk the SHOW's full episode list, the same as the
   *  card and the call tile: resolve the adjacent episode and send it as a
   *  concrete step, or no-op at the ends. */
  async function goNext() {
    const n = nextEpisode();
    if (n)
      await send({
        action: "step",
        episode: { id: n.id, number: n.number },
        at: "end",
      });
  }
  async function previous() {
    const p = prevEpisode();
    if (p)
      await send({
        action: "step",
        episode: { id: p.id, number: p.number },
        at: "start",
      });
  }
</script>

<!-- One row of simple controls: the widget surface is a strip, not a card. -->
<div class="flex w-full items-center gap-1.5">
  {#if anime.closed}
    <span class="truncate text-xs text-muted-foreground">Party over</span>
  {:else if current}
    <Tip text="Previous episode">
      {#snippet children(props)}
        <button
          type="button"
          {...props}
          onclick={previous}
          aria-label="Previous episode"
          class="shrink-0 cursor-pointer rounded bg-primary/15 p-1 text-primary hover:bg-primary/25"
        >
          <SkipBack class="size-3" />
        </button>
      {/snippet}
    </Tip>
    <Tip text={anime.playing ? "Pause" : "Play"}>
      {#snippet children(props)}
        <button
          type="button"
          {...props}
          onclick={() =>
            send({
              action: anime.playing ? "pause" : "play",
              atMs: Date.now(),
              // The live player's position when one renders in this tab; the
              // stale synced one rewound the whole party on pause otherwise.
              position: livePosition(anime.position),
            })}
          aria-label={anime.playing ? "Pause" : "Play"}
          class="shrink-0 cursor-pointer rounded bg-primary/15 p-1 text-primary hover:bg-primary/25"
        >
          {#if anime.playing}<Pause class="size-3" />{:else}<Play
              class="size-3"
            />{/if}
        </button>
      {/snippet}
    </Tip>
    <Tip text="Next episode">
      {#snippet children(props)}
        <button
          type="button"
          {...props}
          onclick={goNext}
          aria-label="Next episode"
          class="shrink-0 cursor-pointer rounded bg-primary/15 p-1 text-primary hover:bg-primary/25"
        >
          <SkipForward class="size-3" />
        </button>
      {/snippet}
    </Tip>
    <!-- The label stays put; only the NAME rides the marquee. -->
    <span
      class="flex min-w-0 flex-1 items-baseline gap-1 font-mono text-[11px] text-muted-foreground"
    >
      <span class="shrink-0">Playing:</span>
      <span
        bind:this={titleWrap}
        class="anime-marquee-wrap min-w-0 flex-1 overflow-hidden whitespace-nowrap"
        title={title}
      >
        <span
          bind:this={titleInner}
          class="inline-block {scrolling ? 'anime-marquee' : ''}"
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
  .anime-marquee {
    animation: anime-crawl linear infinite;
  }
  /* Pause on hover so the title can be read or selected. */
  .anime-marquee-wrap:hover .anime-marquee {
    animation-play-state: paused;
  }
  @keyframes anime-crawl {
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
