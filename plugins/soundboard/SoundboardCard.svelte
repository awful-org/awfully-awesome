<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { HostApi } from "$lib/plugins/api";
  import { validateMp3File } from "./import";
  import { CropPreviewPlayer, type PreviewState } from "./preview";
  import SoundCropEditor from "./SoundCropEditor.svelte";
  import { deleteSound, listSounds, onLibraryChange, updateSound, type SoundRecord } from "./storage";

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
  let editing = $state<SoundRecord | null>(null);
  let editName = $state("");
  let editVolume = $state(1);
  let editSaving = $state(false);
  let editPreviewState = $state<PreviewState>("idle");
  let deleteTarget = $state<SoundRecord | null>(null);
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe = () => {};

  const bySlot = $derived(new Map(sounds.map((sound) => [sound.slot, sound])));
  const blocked = $derived(host.callAudio.blockedReason());
  const editPreview = new CropPreviewPlayer(undefined, undefined, undefined, (state) => { editPreviewState = state; });

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
    editPreview.dispose();
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
      const playback = await host.callAudio.play(sound.blob, { volume: sound.volume });
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
    deleteTarget = sound;
  }

  async function confirmRemove() {
    if (!deleteTarget) return;
    const sound = deleteTarget;
    deleteTarget = null;
    try {
      if (activeSlot === sound.slot) host.callAudio.stop(activePlayback ?? undefined);
      await deleteSound(ownerDid, sound.slot);
    } catch {
      error = "The sound could not be deleted from local storage.";
    }
  }

  function beginEdit(sound: SoundRecord) {
    editPreview.stop();
    editing = sound;
    editName = sound.name;
    editVolume = sound.volume;
    error = "";
  }

  async function previewEdit() {
    if (!editing) return;
    if (editPreviewState !== "idle") {
      editPreview.stop();
      return;
    }
    error = "";
    try {
      await editPreview.play(editing.blob, editVolume);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Preview playback was blocked";
    }
  }

  async function saveEdit() {
    if (!editing || editSaving) return;
    editSaving = true;
    error = "";
    try {
      await updateSound(ownerDid, editing.slot, { name: editName, volume: editVolume });
      editPreview.stop();
      editing = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The sound could not be updated";
    } finally {
      editSaving = false;
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

    {#if editing}
      <div class="space-y-3 rounded-md border border-border bg-background/60 p-3">
        <p class="text-sm font-semibold">Edit sound</p>
        <label class="block space-y-1 text-xs">
          <span>Name</span>
          <input class="w-full rounded-md border border-input bg-background px-2 py-1.5" maxlength="32" bind:value={editName} />
        </label>
        <label class="block space-y-1 text-xs">
          <span>Volume: {Math.round(editVolume * 100)}%</span>
          <input class="w-full" type="range" min="0" max="1" step="0.01" bind:value={editVolume} oninput={() => editPreview.stop()} />
        </label>
        <div class="flex justify-end gap-2">
          <button type="button" class="cursor-pointer rounded-md border px-3 py-1.5 text-xs" onclick={() => { editPreview.stop(); editing = null; }}>Cancel</button>
          <button type="button" class="cursor-pointer rounded-md border px-3 py-1.5 text-xs" onclick={() => void previewEdit()}>
            {editPreviewState === "idle" ? "Preview" : "Stop preview"}
          </button>
          <button type="button" class="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50" disabled={editSaving || [...editName.trim()].length < 1 || [...editName.trim()].length > 32} onclick={() => void saveEdit()}>
            {editSaving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>
    {:else}
      <div class="grid grid-cols-3 gap-2" aria-label="Personal soundboard">
      {#each Array.from({ length: 9 }, (_, i) => i + 1) as slot (slot)}
        {@const sound = bySlot.get(slot)}
        {#if sound}
          <div class="min-w-0 overflow-hidden rounded-md border border-border bg-muted/25">
            <button
              type="button"
              class="flex h-16 w-full cursor-pointer flex-col items-center justify-center gap-1 px-2 text-center transition {activeSlot === slot ? 'bg-primary/20' : 'hover:bg-muted/60'} disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!!blocked}
              aria-label={`Play ${sound.name}`}
              onclick={() => void play(sound)}
            >
              <span class="w-full truncate text-xs font-semibold">{sound.name}</span>
              <span class="font-mono text-[10px] text-muted-foreground">{(sound.durationMs / 1000).toFixed(2)}s · {Math.round(sound.volume * 100)}%</span>
            </button>
            <div class="flex border-t border-border/70">
              <button type="button" class="flex-1 cursor-pointer px-1 py-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Edit ${sound.name}`} onclick={() => beginEdit(sound)}>Edit</button>
              <button type="button" class="flex-1 cursor-pointer border-l border-border/70 px-1 py-1 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete ${sound.name}`} onclick={() => void remove(sound)}>Delete</button>
            </div>
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
    {/if}

    {#if deleteTarget}
      <div class="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3" role="alertdialog" aria-modal="true" aria-labelledby="soundboard-delete-title">
        <p id="soundboard-delete-title" class="text-sm font-semibold">Delete “{deleteTarget.name}”?</p>
        <p class="text-xs text-muted-foreground">This removes the sound from this device. It cannot be undone.</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="cursor-pointer rounded-md border px-3 py-1.5 text-xs" onclick={() => { deleteTarget = null; }}>Keep sound</button>
          <button type="button" class="cursor-pointer rounded-md bg-destructive px-3 py-1.5 text-xs text-destructive-foreground" onclick={() => void confirmRemove()}>Delete sound</button>
        </div>
      </div>
    {/if}
  </div>
{/if}
