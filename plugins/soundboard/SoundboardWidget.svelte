<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { HostApi } from "$lib/plugins/api";
  import { listSounds, onLibraryChange, type SoundRecord } from "./storage";
  import { soundGlyph } from "./glyph";
  import { Tip } from "$lib/plugins/ui";

  // Card-less widget: the host mounts this with card: null - only the host
  // API matters here.
  let { host }: { card: unknown; cardState: unknown; host: HostApi } = $props();

  // svelte-ignore state_referenced_locally -- one host is fixed for this mount
  const ownerDid = host.selfDid();
  let sounds = $state<SoundRecord[]>([]);
  let activeId = $state<string | null>(null);
  let activeSlot = $state<number | null>(null);
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe = () => {};
  let strip = $state<HTMLDivElement>();
  let moreBefore = $state(false);
  let moreAfter = $state(false);

  function updateOverflow() {
    if (!strip) return;
    moreBefore = strip.scrollLeft > 1;
    moreAfter = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
  }

  $effect(() => {
    if (!strip) return;
    void sounds.length;
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(strip);
    return () => observer.disconnect();
  });

  const blocked = $derived(host.callAudio.blockedReason());

  async function reload() {
    if (!ownerDid) return;
    try {
      sounds = await listSounds(ownerDid);
    } catch {
      // Storage unavailable: the strip just shows nothing to press.
    }
  }

  onMount(() => {
    void reload();
    unsubscribe = onLibraryChange(() => void reload());
  });
  onDestroy(() => {
    unsubscribe();
    if (activeTimer) clearTimeout(activeTimer);
    // Stop this plugin's sounds when the strip unmounts.
    host.callAudio.stop();
  });

  async function play(sound: SoundRecord) {
    if (blocked) return;
    try {
      if (activeTimer) clearTimeout(activeTimer);
      host.callAudio.stop();
      const playback = await host.callAudio.play(sound.blob, {
        volume: sound.volume,
      });
      activeId = playback.id;
      activeSlot = sound.slot;
      activeTimer = setTimeout(() => {
        if (activeId !== playback.id) return;
        activeId = null;
        activeSlot = null;
      }, playback.durationMs + 100);
    } catch {
      activeId = null;
      activeSlot = null;
    }
  }
</script>

{#if sounds.length === 0}
  <span class="truncate font-mono text-[11px] text-muted-foreground">
    /soundboard to add sounds
  </span>
{:else}
  <div
    bind:this={strip}
    class="sound-strip flex min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden"
    class:more-before={moreBefore}
    class:more-after={moreAfter}
    aria-label="Soundboard"
    onscroll={updateOverflow}
  >
    {#each sounds as sound (sound.slot)}
      <!-- The app's Tip, not the browser tooltip - same chrome as every
           other control, and it still shows on a disabled button. -->
      <Tip
        text={blocked === "not-in-call"
          ? "Join the call to play"
          : blocked === "deafened"
            ? "Undeafen to play"
            : sound.name}
      >
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-sm leading-none transition
              {activeSlot === sound.slot ? 'bg-primary/25' : 'hover:bg-muted'}
              disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!!blocked}
            aria-label={`Play ${sound.name}`}
            onclick={() => void play(sound)}
          >
            {soundGlyph(sound)}
          </button>
        {/snippet}
      </Tip>
    {/each}
  </div>
{/if}

<style>
  .sound-strip {
    scrollbar-width: thin;
    scrollbar-color: var(--muted-foreground) transparent;
    --fade-left: 0px;
    --fade-right: 0px;
    mask-image: linear-gradient(to right, transparent, black var(--fade-left), black calc(100% - var(--fade-right)), transparent);
  }
  .more-before { --fade-left: 8px; }
  .more-after { --fade-right: 8px; }
  @supports selector(::-webkit-scrollbar) {
    .sound-strip {
      scrollbar-width: auto;
      scrollbar-color: auto;
    }
  }
  .sound-strip::-webkit-scrollbar { height: 3px; }
  .sound-strip::-webkit-scrollbar-thumb {
    background: var(--muted-foreground);
    border: 0;
    border-radius: 999px;
  }
</style>
