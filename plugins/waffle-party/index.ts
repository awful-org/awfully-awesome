import { definePlugin, type HostApi } from "$lib/plugins/api";
import { manifest } from "./manifest";
import MusicCard from "./MusicCard.svelte";
import { initialState, playlistIdFromUrl, reduce, videoIdFromUrl } from "./logic";

export default definePlugin({
  manifest,
  card: MusicCard,
  initialState,
  reduce,
  commands: {
    play: async (args: string, host: HostApi) => {
      const playlistId = playlistIdFromUrl(args.trim());
      const videoId = playlistId ? null : videoIdFromUrl(args.trim());
      if (!videoId && !playlistId) {
        console.warn("[waffle-party] format: /play YouTube video or playlist URL");
        return;
      }
      const cards = await host.cards();
      await Promise.all(
        cards
          .filter((card) => card.senderDid === host.selfDid())
          .map((card) => host.sendUpdate(card.id, { action: "close" }))
      );
      await host.sendCard({ videoId, playlistId, ownerDid: host.selfDid() });
    },
  },
});
