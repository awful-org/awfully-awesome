import { definePlugin } from "$lib/plugins/api";
import { manifest } from "./manifest";
import SoundboardCard from "./SoundboardCard.svelte";
import SoundboardWidget from "./SoundboardWidget.svelte";

export default definePlugin({
  manifest,
  localCard: SoundboardCard,
  // Pinnable without any card: the host mounts card-less widgets for
  // plugins that have no card surface.
  widget: SoundboardWidget,
  commands: {
    soundboard: (_args, host) => {
      host.showLocalCard();
    },
  },
});
