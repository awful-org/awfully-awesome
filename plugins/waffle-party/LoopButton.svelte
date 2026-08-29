<script module lang="ts">
  export type LoopMode = "off" | "track" | "queue";

  export function loopLabelFor(mode: LoopMode): string {
    return mode === "off"
      ? "Loop Off"
      : mode === "track"
        ? "Loop Track"
        : "Loop Queue";
  }

  export function loopButtonClass(mode: LoopMode): string {
    return mode === "off"
      ? "border-border hover:bg-muted"
      : "border-green-500/50 text-green-500 hover:bg-green-500/10";
  }

  export function queueButtonClass(open: boolean): string {
    return open
      ? "border-green-500/50 bg-green-500/10 text-green-500 hover:bg-green-500/20"
      : "border-border hover:bg-muted";
  }
</script>

<script lang="ts">
  import { Ban, ListMusic, Repeat1 } from "@lucide/svelte";

  interface Props {
    mode: LoopMode;
    disabled?: boolean;
    onclick: () => void;
  }

  let { mode, disabled = false, onclick }: Props = $props();
  const label = $derived(loopLabelFor(mode));
</script>

<button
  class="flex items-center gap-1 rounded border px-3 py-2 transition-colors disabled:opacity-60 {loopButtonClass(mode)}"
  {disabled}
  {onclick}
  aria-label={label}
  title={label}
>
  {#if mode === "off"}<Ban class="size-4" />{:else if mode === "track"}<Repeat1
      class="size-4"
    />{:else}<ListMusic class="size-4" />{/if}
</button>
