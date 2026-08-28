import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "waffle-party",
  name: "Waffle Party",
  description: "Queue YouTube videos and listen together.",
  icon: "lucide:music",
  author: "Gustavo Walk",
  license: "MIT",
  version: "1.2.6",
  repository: "https://github.com/awful-org/awfully-awesome",
  apiVersion: 1,
  commands: [
    { name: "play", usage: "/play YouTube video or playlist URL" },
  ],
};
