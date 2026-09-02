/**
 * What a queued episode is called, in one place.
 *
 * There is nothing to fetch: a track's name is the show's title and the
 * episode number, both already in the folded state. waffle-party had to ask
 * YouTube's oEmbed endpoint for every queue entry and cache the answers;
 * here the same job is a string, so the card, the call tile, the sidebar
 * widget and the lock screen all read it from this helper instead of each
 * formatting it slightly differently.
 */
import type { Episode, Show } from "./anidb";

export function episodeLabel(
  show: Pick<Show, "title"> | null,
  episode: Pick<Episode, "number"> | null
): string {
  if (!episode) return show?.title ?? "";
  if (!show) return `Episode ${episode.number}`;
  return `${show.title} · Episode ${episode.number}`;
}
