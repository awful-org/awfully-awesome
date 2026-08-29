<script lang="ts">
  import { Play } from "@lucide/svelte";

  interface Props {
    onclick: () => void;
  }

  let { onclick }: Props = $props();
</script>

<button
  type="button"
  class="pointer-events-auto absolute inset-0 z-20 grid cursor-pointer place-items-center bg-black/20 text-white"
  {onclick}
  aria-label="Resume playback"
  title="Resume playback"
>
  <span class="grid size-14 place-items-center rounded-full bg-black/70 shadow-lg">
    <Play class="size-7 fill-current" />
  </span>
</button>
