import { definePlugin } from "$lib/plugins/api";
import { manifest } from "./manifest";
import SoundboardCard from "./SoundboardCard.svelte";

export default definePlugin({
  manifest,
  localCard: SoundboardCard,
  commands: {
    soundboard: (_args, host) => {
      host.showLocalCard();
    },
  },
});
