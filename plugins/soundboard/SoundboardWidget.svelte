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
  <div class="flex items-center gap-0.5" aria-label="Soundboard">
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
