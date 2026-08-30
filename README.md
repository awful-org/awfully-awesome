<p align="center">
  <img src="logo.svg" alt="awfully-awesome" width="140">
</p>

<h1 align="center">awfully-awesome</h1>

<p align="center">
  Curated plugins for <a href="https://github.com/awful-org/awful.chat">awful.chat</a>.
</p>

## Use these plugins on your instance

Point your instance at this repo and redeploy:

```
PLUGIN_SOURCES=awful-org/awfully-awesome
```

Pin a ref for reproducible deploys: `awful-org/awfully-awesome#<tag-or-sha>`.
Plugins are fetched at build time and compiled into the app, so they update
when you redeploy, not on their own.

## Plugins

| Plugin | Command | What it does |
| --- | --- | --- |
| [steam-roulette](plugins/steam-roulette) | `/steam` | Everyone links their Steam library, the card intersects them, and one spin picks a game you all own. Needs two instance env vars, see its [README](plugins/steam-roulette/README.md). |
| [waffle-party](plugins/waffle-party) | `/play` | Start a room-wide YouTube watch or listening party from a video or playlist URL. Members join in one click from the chat card or the party's call tile, share queue and playback controls, and add or remove tracks. Playlists resolve with no API key. |
| [soundboard](plugins/soundboard) | `/soundboard` | Keep nine private, device-local MP3 crops and play them through your outgoing call audio. |

Each plugin folder has its own README with setup and details.

## Writing a plugin

The folder layout, API contract, and rules live in the app repo:
[frontend/plugins/README.md](https://github.com/awful-org/awful.chat/blob/main/frontend/plugins/README.md).
A plugin here is a folder under `plugins/` with a `manifest.ts` and an
`index.ts`; tests (`*.test.ts`) run inside the app's vitest once fetched.

## Adding your plugin here

Open a PR with your plugin folder under `plugins/`. A few things we look for:

- Tests for the state logic (the reducer folds on every member's device, so
  it has to be deterministic).
- A `repository` field in the manifest pointing at your source, the app's
  settings page groups and links plugins by it.
- A short README in the folder: what it does, any instance env it needs.
- No network calls except through the plugin proxy or documented public APIs.

## License

[MIT](LICENSE).
