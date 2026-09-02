import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "anime-party",
  name: "Anime Party",
  description: "Watch anime together, synced, from anidb.app.",
  icon: "lucide:tv",
  author: "Gustavo Walk",
  license: "MIT",
  version: "0.1.0",
  repository: "https://github.com/awful-org/awfully-awesome",
  apiVersion: 1,
  commands: [
    { name: "anime", usage: "/anime search terms or anidb.app show URL" },
  ],
  // Without these two the party cannot do its job at all: clock-sample is
  // what turns positions into a shared timeline, and plugin-stream is the
  // relay lane the HLS segments ride. An older host refuses to LOAD the
  // plugin and says so, instead of mounting a player that cannot play.
  requires: ["clock-sample", "plugin-stream"],
};
