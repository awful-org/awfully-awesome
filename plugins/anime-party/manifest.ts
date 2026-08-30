import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "anime-party",
  name: "Anime Party",
  description:
    "Watch an episode together. Everyone opens their own file; the party keeps every player in step.",
  icon: "lucide:clapperboard",
  author: "awful-org",
  license: "MIT",
  version: "1.0.0",
  repository: "https://github.com/awful-org/awfully-awesome",
  apiVersion: 1,
  commands: [{ name: "anime-party", usage: "/anime-party <anime title>" }],
};
