# Steam roulette

Everyone links their Steam library; the card intersects them and one spin
picks a game you all own. First spin wins, the winner is deterministic on
every client, and the result shows the game's store page art.

## Usage

```
/steam
```

Each member pastes their Steam profile (full url, vanity name, or id64)
into the card and hits Link. With two or more complete libraries the card
shows the common count and a Spin button.

Steam profiles must have **game details set to public**
(Steam > Profile > Privacy settings) or the library comes back empty.

## Install

Add this repo to the instance and redeploy:

```
PLUGIN_SOURCES=awful-org/awesome-awful
```

## Instance requirements

The card talks to Steam through the instance relay's plugin proxy, so the
operator must set on the relay:

```
PLUGIN_PROXY_HOSTS=api.steampowered.com
PLUGIN_PROXY_SECRETS=STEAM@api.steampowered.com=<steam web api key>
```

Get a key at https://steamcommunity.com/dev/apikey (any domain value
works). Without these the card says the instance is not set up instead of
failing silently.

## Privacy notes

- Linked libraries travel to the room as plugin updates - everyone in the
  room can see which appids you own.
- The relay operator can see which Steam profiles get looked up (the proxy
  brokers the fetch a browser cannot make itself). The API key never
  reaches clients.
