import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "soundboard",
  name: "Soundboard",
  description: "Import, trim and preview personal MP3 clips for your call audio.",
  icon: "lucide:audio-lines",
  author: "Gustavo Walk",
  license: "MIT",
  version: "1.1.0",
  repository: "https://github.com/awful-org/awfully-awesome",
  apiVersion: 1,
  commands: [{ name: "soundboard", usage: "/soundboard" }],
};
