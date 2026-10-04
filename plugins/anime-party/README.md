# Anime Party

Watch anime together, synced. Start a party with `/anime`, pick a show, queue
episodes, and everyone in the room watches the same second of the same
episode with room-wide controls. Shows come from [AniList](https://anilist.co)
and play in the [zokoanime](https://zokoanime.video) embed player.

## Use

Start a party with search terms, or with a MyAnimeList show URL if you
already have one:

```text
/anime bocchi the rock
/anime https://myanimelist.net/anime/47917/Bocchi_the_Rock
```

Search terms post a card with the matching shows, most popular first. Only
shows AniList lists as finished or currently airing are offered: an
announced show has nothing to play yet. Pick one and the card switches to
that show. A pasted show URL skips the picking step. The show can be
re-picked until the first episode is queued (the "Change show" link next to
the title), so a wrong Bocchi costs a click rather than a new party.

Then, on the card:

1. **Join** the party. Only members can search, pick, queue or control it.
2. **Add episodes** opens the show's episode list: every episode that has
   aired, as AniList counts them. The empty queue links straight to it. Add
   one at a time, or "Add all" (which becomes "Add the rest" once some are
   queued). Episodes already in the room's queue are marked and skipped.
3. The first batch starts playing straight away, so a season begins before
   the rest of it has finished queueing.
4. **Show queue** lists what is lined up: click a row to jump the whole
   party to that episode, or the bin to drop it.

Party members can queue episodes, select a numbered one, remove it, go to
the previous or next episode, seek, pause and play. When the last queued
episode ends the party stops; there is no shuffle and no looping, a season
plays in order. The queue holds up to 200 episodes, added in batches of 50
per update.

Hovering the video reveals the same controls the call tile carries: play and
pause, ten seconds back and forward, previous and next episode, a seek bar,
and the Sub/Dub button. Everything there acts on the whole party except
Sub/Dub, which is yours alone and says so.

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

Which audio you get is a **per-viewer local preference**, stored on your own
device and never sent to the room: your friend can watch dubbed while you
watch subbed, on the same synchronized episode and the same position.

The button lives in the player's own controls and reads "Sub" or "Dub".
Pressing it reloads only your player on the other track and puts it back
where the party is: the party's episode, position and play state are
untouched, so nobody else sees anything happen. The choice is remembered on
this device.

Not every episode has a dub. The embed answers a missing one with its own
"Not found" page, which says nothing the party can read, so after twenty
seconds without the player starting the card says the episode did not load
and suggests Sub.

## What the embed cannot do

The video plays inside zokoanime's page, which the party drives over the
messages that page documents (play, pause, seek, and a state report). It
takes no other commands, so some things a player of our own could do are
gone:

- **Volume.** There is no volume command, so there is no volume slider:
  loudness is your system's or your browser tab's. The call tile's up and
  down arrows do nothing.
- **Picture-in-picture.** Nobody but the browser can float a video inside
  another site's frame.
- **Gentle drift correction.** A viewer who drifts more than a few seconds
  from the party is seeked back; there is no playback-rate nudge for smaller
  drift.

The embed's own controls are covered by the party's, because they would
move only you. The one exception: if your browser refuses to start the
video with sound, the embed plays it muted, the card says so, and the cover
steps aside until a click on the video turns the sound on.

## Install

Add this repository to `PLUGIN_SOURCES` and redeploy:

```text
PLUGIN_SOURCES=awful-org/awfully-awesome#<tag-or-sha>
```

## Requirements

No proxy hosts, no secrets, no relay lane: AniList answers browsers
directly, and the video loads inside the embed. Three things on the host:

- The page's **Permissions-Policy must delegate `autoplay` (and
  `fullscreen`) to `https://zokoanime.video`**, the way awful.chat's
  `frontend/nginx.conf` already does for YouTube:

  ```text
  autoplay=(self "https://www.youtube.com" "https://zokoanime.video"),
  fullscreen=(self "https://www.youtube.com" "https://zokoanime.video")
  ```

  Without it the browser refuses every play the party sends the embed,
  silently: the episode sits on its first frame. The player notices after a
  few seconds and asks each viewer to click the video, which starts it (a
  click inside the player is allowed where autoplay is not), but that click
  is needed again for every episode, by every viewer.
- The page's Content-Security-Policy must allow `https:` frames, which
  awful.chat's default does.
- The host build must ship `clock-sample`; an older one refuses to load the
  plugin and says so.

## Privacy

Nothing goes through the instance. In exchange, each viewer's browser talks
to two outside services itself:

- **AniList** (`graphql.anilist.co`) gets the search from whoever searches,
  and one lookup per show from each member, to count its episodes. It sees
  those viewers' IPs. Show covers load from `s4.anilist.co` in the browser
  of everyone who has the card on screen. Only that one prefix is accepted,
  in the parser and again in the reducer, so a peer cannot put some other
  host's url on everybody's card.
- **zokoanime** serves the player and the video to everyone watching, so it
  and its video host see each viewer's IP and what they watch. The embed
  page also loads a large number of advertising and tracking frames of its
  own (about thirty-five were counted in one session, from ad exchanges such
  as Rubicon, PubMatic and Amazon). Those are the embed's, not the
  plugin's, and nothing here can turn them off. Anyone joining a party
  should know that before pressing play.

The relay carries no video, so a party costs the instance no bandwidth.

## Performance

The first time an episode is played its video can take a while to start,
sometimes over thirty seconds: the embed's video host is slow on an episode
nobody has pulled recently. The card says "Loading player…" until it moves.
Later plays of the same episode start in about a second.

## Fragility

AniList's API is public and versioned, and zokoanime documents both its
embed address and its messages. Neither is promised forever, and the two do
not always agree with each other: a show on AniList may simply not exist on
zokoanime, or be missing episodes, which shows up as an episode that does
not load. zokoanime also documents AniList ids, but its AniList addresses
answer "not found" for every show tried, so parties address it by the
MyAnimeList id AniList carries, and a show with no MyAnimeList id is left
out of search.

The parser is tested against captured AniList answers in `fixtures/`. When
search suddenly returns nothing, re-capture them with the queries in
`anilist.ts` and look at the diff first.

This plugin does not host, cache, or redistribute anything. It embeds a
public player page the way any site that embeds it does.
