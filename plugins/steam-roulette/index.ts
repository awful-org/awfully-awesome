import { definePlugin } from "$lib/plugins/api";
import { manifest } from "./manifest";
import SteamRouletteCard from "./SteamRouletteCard.svelte";
import { initialState, reduce } from "./logic";
import type { HostApi } from "$lib/plugins/api";

export default definePlugin({
  manifest,
  card: SteamRouletteCard,
  initialState,
  reduce,
  commands: {
    steam: async (_args: string, host: HostApi) => {
      await host.sendCard({});
    },
  },
});
