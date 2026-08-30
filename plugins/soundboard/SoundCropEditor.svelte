<script lang="ts">
  import { onDestroy } from "svelte";
  import { buildWaveform, clampSelection, cropToMonoPcm, encodePcm16Wav } from "./crop";
  import { CropPreviewPlayer, type PreviewState } from "./preview";
  import { putSound, type SoundRecord } from "./storage";

  interface Props {
    source: AudioBuffer;
    sourceName: string;
    ownerDid: string;
    slot: number;
    onSaved: (sound: SoundRecord) => void;
    onCancel: () => void;
  }

  let { source, sourceName, ownerDid, slot, onSaved, onCancel }: Props = $props();
  let start = $state(0);
  // svelte-ignore state_referenced_locally -- a new import remounts the editor
  let end = $state(Math.min(5, source.duration));
  // svelte-ignore state_referenced_locally -- initial filename is copied into editable state
  let name = $state(sourceName.replace(/\.mp3$/i, "").slice(0, 32));
  let error = $state("");
  let saving = $state(false);
  let previewState = $state<PreviewState>("idle");
  const preview = new CropPreviewPlayer(undefined, (state) => { previewState = state; });
  // svelte-ignore state_referenced_locally -- source is immutable for this editor mount
  const waveform = buildWaveform(source, 80);
  const duration = $derived(end - start);
  const validName = $derived([...name.trim()].length >= 1 && [...name.trim()].length <= 32);

  function stopPreview() {
    preview.stop();
  }

  onDestroy(() => {
    preview.dispose();
  });

  function setStart(value: number) {
    stopPreview();
    const next = clampSelection({ startSeconds: value, endSeconds: Math.min(end, value + 5) }, source.duration);
    start = next.startSeconds;
    end = next.endSeconds;
  }

  function setEnd(value: number) {
    stopPreview();
    const next = clampSelection({ startSeconds: Math.max(start, value - 5), endSeconds: value }, source.duration);
    start = next.startSeconds;
    end = next.endSeconds;
  }

  async function playPreview() {
    error = "";
    if (previewState !== "idle") {
      stopPreview();
      return;
    }
    try {
      await preview.play(source, start, duration);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Preview playback was blocked";
    }
  }

  async function save() {
    if (!validName || saving) return;
    saving = true;
    error = "";
    try {
      const pcm = cropToMonoPcm(source, { startSeconds: start, endSeconds: end });
      const blob = encodePcm16Wav(pcm);
      const sound: SoundRecord = {
        ownerDid,
        slot,
        id: crypto.randomUUID(),
        name: name.trim(),
        blob,
        durationMs: Math.round(duration * 1000),
        createdAt: Date.now(),
        schemaVersion: 1,
      };
      await putSound(sound);
      stopPreview();
      onSaved(sound);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The sound could not be saved";
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-3 rounded-md border border-border bg-background/60 p-3">
  <div class="flex items-center justify-between gap-2">
    <div>
      <p class="text-sm font-semibold">Crop sound</p>
      <p class="text-[11px] text-muted-foreground">Choose between 0.25 and 5 seconds.</p>
    </div>
    <span class="font-mono text-xs">{duration.toFixed(2)}s</span>
  </div>

  <div class="relative flex h-20 items-end gap-px overflow-hidden rounded bg-muted/30 px-1" aria-label="Audio waveform">
    {#each [...waveform] as peak, i (i)}
      {@const time = (i / waveform.length) * source.duration}
      <div
        class="min-w-0 flex-1 rounded-t {time >= start && time <= end ? 'bg-primary' : 'bg-muted-foreground/35'}"
        style={`height: ${Math.max(4, peak * 100)}%`}
      ></div>
    {/each}
  </div>

  <label class="block space-y-1 text-xs">
    <span>Start: {start.toFixed(2)}s</span>
    <input class="w-full" type="range" min="0" max={Math.max(0, source.duration - 0.25)} step="0.01" value={start} oninput={(e) => setStart(+e.currentTarget.value)} />
  </label>
  <label class="block space-y-1 text-xs">
    <span>End: {end.toFixed(2)}s</span>
    <input class="w-full" type="range" min="0.25" max={source.duration} step="0.01" value={end} oninput={(e) => setEnd(+e.currentTarget.value)} />
  </label>

  <label class="block space-y-1 text-xs">
    <span>Name</span>
    <input class="w-full rounded-md border border-input bg-background px-2 py-1.5" maxlength="32" bind:value={name} aria-invalid={!validName} />
  </label>
  {#if !validName}<p class="text-xs text-destructive">Use a name from 1 to 32 characters.</p>{/if}
  {#if error}<p class="text-xs text-destructive" role="alert">{error}</p>{/if}

  <div class="flex flex-wrap justify-end gap-2">
    <button type="button" class="cursor-pointer rounded-md border px-3 py-1.5 text-xs" onclick={onCancel}>Cancel</button>
    <button type="button" class="cursor-pointer rounded-md border px-3 py-1.5 text-xs" onclick={playPreview}>
      {previewState === "idle" ? "Preview" : previewState === "starting" ? "Cancel preview" : "Stop preview"}
    </button>
    <button type="button" class="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50" disabled={!validName || saving} onclick={save}>
      {saving ? "Saving..." : "Save sound"}
    </button>
  </div>
</div>
