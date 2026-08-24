# awesome-awful

Plugins for [awful.chat](https://github.com/awful-org/awful.chat). Point your
instance at this repo and redeploy:

```
PLUGIN_SOURCES=awful-org/awesome-awful
```

Pin a ref for reproducible deploys: `awful-org/awesome-awful#<tag-or-sha>`.

## Plugins

| Plugin | Command | What it does |
| --- | --- | --- |
| steam-roulette | `/steam` | Everyone links their Steam library, the card intersects them, and one spin picks a game you all own. Instance env: `PLUGIN_PROXY_HOSTS=api.steampowered.com` and `PLUGIN_PROXY_SECRETS=STEAM@api.steampowered.com=<api key>` ([get one](https://steamcommunity.com/dev/apikey)). |

## Writing a plugin

The folder layout, API contract, and rules live in the app repo:
[frontend/plugins/README.md](https://github.com/awful-org/awful.chat/blob/main/frontend/plugins/README.md).
A plugin here is a folder under `plugins/` with a `manifest.ts` and an
`index.ts`; tests (`*.test.ts`) run inside the app's vitest once fetched.
