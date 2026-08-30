import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "soundboard",
  name: "Soundboard",
  description: "Crop personal MP3 clips and play them through your call audio.",
  icon: "lucide:audio-lines",
  author: "Gustavo Walk",
  license: "MIT",
  version: "1.0.0",
  repository: "https://github.com/awful-org/awfully-awesome",
  apiVersion: 1,
  commands: [{ name: "soundboard", usage: "/soundboard" }],
};
