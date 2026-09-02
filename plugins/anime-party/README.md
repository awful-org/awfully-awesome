# Anime Party

Watch anime together, synced, from [anidb.app](https://anidb.app) - the same
provider `ani-cli` reads. Start a party with `/anime`, pick a show, queue
episodes, and everyone in the room watches the same second of the same
episode with room-wide controls.

## Use

Start a party with search terms, or with a show URL if you already have one:

```text
/anime bocchi the rock
/anime https://anidb.app/anime/bocchi-the-rock-729
```

Search terms post a card with the matching shows; pick one and the card
switches to that show's episode list. A pasted show URL skips the picking
step. The show can be re-picked until the first episode is queued (the
"Change show" link next to the title), so a wrong Bocchi costs a click
rather than a new party.

Then, on the card:

1. **Join** the party. Only members can search, pick, queue or control it.
2. **Add episodes** opens the show's episode list, read from anidb.app by
   your own browser. Add one at a time, or "Add all" (which becomes "Add the
   rest" once some are queued). Episodes already in the room's queue are
   marked and skipped.
3. The first batch starts playing straight away, so a season begins before
   the rest of it has finished queueing.
4. **Show queue** lists what is lined up: click a row to jump the whole
   party to that episode, or the bin to drop it.

Party members can queue episodes, select a numbered one, remove it, go to
the previous or next episode, seek, pause and play, and cycle looping
between off, one episode, and the whole queue. At the last episode, next
restarts it in episode-loop mode and wraps to the first in queue-loop mode.
The queue holds up to 200 episodes, added in batches of 50 per update.

Hovering the video reveals the same controls the call tile carries: play and
pause, ten seconds back and forward, previous and next episode, a seek bar,
your own volume, and the Sub/Dub button. Everything there acts on the whole
party except volume and Sub/Dub, which are yours alone and say so.

In a call the party is a tile in the grid rather than a card in the chat.
Only one surface plays at a time: whichever one is rendering holds the
lock-screen controls too, and joining or leaving a call hands the live
position over rather than restarting the episode.

The host can disband the party. A participant may join only one Anime Party
in the same room at a time; refreshing or leaving removes that participant.
If the host disconnects, members wait fifteen seconds before closing the
party and cancel that close if the host reconnects.

After a party closes, its creator can press **Start again** on their latest
closed party in that room to open a new one with the same show and queue,
starting from the first episode, without carrying members forward.

## Sub or dub

An episode on anidb.app can carry Japanese audio, English audio, or both.
Which one you get is a **per-viewer local preference**, stored on your own
device and never sent to the room: your friend can watch dubbed while you
watch subbed, on the same synchronized episode and the same position. When
the episode has only one audio language, everybody gets that one, labelled
with what it actually is rather than what was asked for.

The button lives in the player's own controls, on the right next to the
volume slider, and reads "Sub" or "Dub". Pressing it re-resolves and reloads
only your stream: the party's episode, position and play state are untouched,
so nobody else sees anything happen. The choice is remembered on this device.

## Install

Add this repository to `PLUGIN_SOURCES` and redeploy:

```text
PLUGIN_SOURCES=awful-org/awfully-awesome#<tag-or-sha>
```

## Requirements

On the instance:

```text
PLUGIN_PROXY_HOSTS=anidb.app,hls.anidb.app
```

`anidb.app` is for search and the embed page (through `/plugin-proxy`);
`hls.anidb.app` is the video CDN (through `/plugin-stream`). With only the
first, search works and every episode fails with "Could not load the
stream." No API key and no secret: anidb.app asks for neither. The host build must
also ship the `plugin-stream` feature, which is the relay lane the video
segments ride; an older build refuses to load this plugin and says so
instead of mounting a player that cannot play.

## Privacy

Two of the four lookups are open-CORS JSON and happen in each viewer's own
browser, straight to anidb.app: the episode list of a show, and which audio
languages an episode has. anidb.app therefore sees each viewer's IP for
those, the way it would if they opened the site themselves.

The other two go through the instance relay, because the pages carry no CORS
headers: the search page, and the embed page that names the video. The video
itself is relayed too, in every browser that plays HLS through hls.js
(Chrome, Firefox, Edge), because the CDN only serves anidb.app's own origin.
So the relay sees what a party is watching, and it carries the bandwidth:
roughly 0.2 to 0.8 Mbps per viewer, per party, for as long as the episode
plays. An operator running this on a small box should know that number
before enabling it. Safari plays HLS natively and fetches the video straight
from `hls.anidb.app`, so those viewers cost the relay nothing and show the
CDN their own IP instead.

Show posters are not relayed. They load from `cdn.xlsbox.com`, anidb.app's
poster CDN, in each member's own browser, so that host sees the IP of
everyone who has the card on screen. Only that one prefix is accepted, in
the parser and again in the reducer, so a peer cannot put some other host's
url on everybody's card.

## Fragility

The search page and the embed page are scraped HTML, not an API. That is the
same exposure `ani-cli` has, and it has the same failure mode: anidb.app can
change its markup and the parsers stop finding anything, with no warning and
no version to pin. The two JSON endpoints are steadier but are just as
unpromised.

The parsers are tested against captured fixtures in `fixtures/`, so a break
is a failing test with a real page next to it rather than a mystery. When
search suddenly returns nothing, re-capture the fixtures and look at the
diff first.

This plugin does not host, cache, or redistribute anything. It reads a public
site the way a browser does and plays what that site serves.
