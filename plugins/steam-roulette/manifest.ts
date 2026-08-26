import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "steam-roulette",
  name: "Steam roulette",
  description: "Everyone links their Steam library; spin over the games you share.",
  icon: "lucide:joystick",
  author: "awful-org",
  license: "MIT",
  version: "1.1.0",
  repository: "https://github.com/awful-org/awfully-awesome",
  apiVersion: 1,
  commands: [{ name: "steam", usage: "/steam - roulette over shared Steam games" }],
};
