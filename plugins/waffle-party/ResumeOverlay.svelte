<script lang="ts">
  import { Play } from "@lucide/svelte";
  import { Tip } from "$lib/plugins/ui";

  interface Props {
    onclick: () => void;
  }

  let { onclick }: Props = $props();
</script>

<Tip text="Resume playback">
  {#snippet children(props)}
    <button
      type="button"
      class="pointer-events-auto absolute inset-0 z-20 grid cursor-pointer place-items-center bg-black/20 text-white"
      {...props}
      {onclick}
      aria-label="Resume playback"
    >
      <span class="grid size-14 place-items-center rounded-full bg-black/70 shadow-lg">
        <Play class="size-7 fill-current" />
      </span>
    </button>
  {/snippet}
</Tip>
