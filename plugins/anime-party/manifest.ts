import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "anime-party",
  name: "Anime Party",
  description: "Watch anime together, synced, through the zokoanime player.",
  icon: "lucide:tv",
  author: "awful-org",
  license: "MIT",
  version: "0.2.3",
  repository: "https://github.com/awful-org/awfully-awesome",
  apiVersion: 1,
  commands: [
    { name: "anime", usage: "/anime search terms or a MyAnimeList show URL" },
  ],
  // Without clock-sample the party cannot do its job at all: it is what
  // turns positions into a shared timeline. An older host refuses to LOAD
  // the plugin and says so, instead of mounting a party that cannot sync.
  // No plugin-stream: the video plays inside the provider's own embed, so
  // nothing rides the relay.
  requires: ["clock-sample"],
};
