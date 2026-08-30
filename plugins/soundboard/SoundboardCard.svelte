<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { HostApi } from "$lib/plugins/api";
  import { validateMp3File } from "./import";
  import SoundCropEditor from "./SoundCropEditor.svelte";
  import { deleteSound, listSounds, onLibraryChange, type SoundRecord } from "./storage";

  let { host }: { host: HostApi } = $props();
  // svelte-ignore state_referenced_locally -- one host is fixed for this mount
  const ownerDid = host.selfDid();
  let sounds = $state<SoundRecord[]>([]);
  let loading = $state(true);
  let error = $state("");
  let targetSlot = $state<number | null>(null);
  let cropSource = $state<AudioBuffer | null>(null);
  let cropName = $state("");
  let fileInput = $state<HTMLInputElement | null>(null);
  let activeSlot = $state<number | null>(null);
  let activePlayback = $state<string | null>(null);
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe = () => {};

  const bySlot = $derived(new Map(sounds.map((sound) => [sound.slot, sound])));
  const blocked = $derived(host.callAudio.blockedReason());

  async function reload() {
    if (!ownerDid) {
      loading = false;
      error = "Unlock an identity to use the soundboard.";
      return;
    }
    try {
      sounds = await listSounds(ownerDid);
      error = "";
    } catch {
      error = "Local sound storage is unavailable in this browser.";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void reload();
    unsubscribe = onLibraryChange(() => void reload());
  });
  onDestroy(() => {
    unsubscribe();
    if (activeTimer) clearTimeout(activeTimer);
    host.callAudio.stop(activePlayback ?? undefined);
  });

  function choose(slot: number) {
    if (sounds.length >= 9 || !ownerDid) return;
    targetSlot = slot;
    fileInput?.click();
  }

  async function selected(file: File | undefined) {
    if (!file || targetSlot === null) return;
    error = "";
    const context = new AudioContext();
    try {
      const result = await validateMp3File(file, (bytes) => context.decodeAudioData(bytes));
      cropSource = result.buffer;
      cropName = file.name;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The MP3 could not be opened";
      targetSlot = null;
    } finally {
      await context.close().catch(() => {});
      if (fileInput) fileInput.value = "";
    }
  }

  async function play(sound: SoundRecord) {
    error = "";
    if (blocked) return;
    try {
      if (activeTimer) clearTimeout(activeTimer);
      host.callAudio.stop(activePlayback ?? undefined);
      const playback = await host.callAudio.play(sound.blob);
      activeSlot = sound.slot;
      activePlayback = playback.id;
      activeTimer = setTimeout(() => {
        if (activePlayback !== playback.id) return;
        activeSlot = null;
        activePlayback = null;
      }, playback.durationMs + 100);
    } catch (cause) {
      activeSlot = null;
      activePlayback = null;
      error = cause instanceof Error ? cause.message : "The sound could not be played";
    }
  }

  async function remove(sound: SoundRecord) {
    if (!confirm(`Delete “${sound.name}” from this device?`)) return;
    try {
      if (activeSlot === sound.slot) host.callAudio.stop(activePlayback ?? undefined);
      await deleteSound(ownerDid, sound.slot);
    } catch {
      error = "The sound could not be deleted from local storage.";
    }
  }
</script>

<input class="hidden" bind:this={fileInput} type="file" accept=".mp3,audio/mpeg,audio/mp3" onchange={(e) => void selected(e.currentTarget.files?.[0])} />

{#if cropSource && targetSlot !== null}
  <SoundCropEditor
    source={cropSource}
    sourceName={cropName}
    {ownerDid}
    slot={targetSlot}
    onSaved={() => { cropSource = null; targetSlot = null; void reload(); }}
    onCancel={() => { cropSource = null; targetSlot = null; }}
  />
{:else}
  <div class="space-y-3">
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="text-sm font-semibold">Your sounds</p>
        <p class="text-[11px] text-muted-foreground">Private to this identity and device. MP3, 8 MiB, 5-second crop.</p>
      </div>
      <span class="font-mono text-xs text-muted-foreground">{sounds.length}/9</span>
    </div>

    {#if blocked === "not-in-call"}<p class="text-xs text-muted-foreground">Join the call to play. You can still manage sounds.</p>{/if}
    {#if blocked === "deafened"}<p class="text-xs text-muted-foreground">Undeafen to play.</p>{/if}
    {#if error}<p class="text-xs text-destructive" role="alert">{error}</p>{/if}

    <div class="grid grid-cols-3 gap-2" aria-label="Personal soundboard">
      {#each Array.from({ length: 9 }, (_, i) => i + 1) as slot (slot)}
        {@const sound = bySlot.get(slot)}
        {#if sound}
          <div class="group relative min-w-0">
            <button
              type="button"
              class="flex h-20 w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-md border px-2 text-center transition {activeSlot === slot ? 'border-primary bg-primary/20' : 'border-border bg-muted/25 hover:bg-muted/60'} disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!!blocked}
              aria-label={`Play ${sound.name}`}
              onclick={() => void play(sound)}
            >
              <span class="w-full truncate text-xs font-semibold">{sound.name}</span>
              <span class="font-mono text-[10px] text-muted-foreground">{(sound.durationMs / 1000).toFixed(2)}s</span>
            </button>
            <button type="button" class="absolute right-1 top-1 cursor-pointer rounded bg-background/80 px-1 text-[10px] text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 focus:opacity-100" aria-label={`Delete ${sound.name}`} onclick={() => void remove(sound)}>×</button>
          </div>
        {:else}
          <button
            type="button"
            class="h-20 min-w-0 cursor-pointer rounded-md border border-dashed border-border text-xl text-muted-foreground hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            disabled={loading || sounds.length >= 9 || !ownerDid}
            aria-label={`Add sound to slot ${slot}`}
            onclick={() => choose(slot)}
          >+</button>
        {/if}
      {/each}
    </div>
    {#if sounds.length >= 9}<p class="text-center text-xs text-muted-foreground">Delete one sound before adding another.</p>{/if}
  </div>
{/if}
