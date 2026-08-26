/** YouTube titles via oEmbed, cached for the session - shared by the
 *  widget's "Playing:" line and the lock-screen metadata. */

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function cachedTitle(videoId: string): string | undefined {
  return cache.get(videoId);
}

export function fetchTitle(videoId: string): Promise<string> {
  const hit = cache.get(videoId);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(videoId);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(
          `https://www.youtube.com/watch?v=${videoId}`
        )}&format=json`
      );
      const data = (await res.json()) as { title?: unknown };
      const t = typeof data.title === "string" ? data.title : videoId;
      cache.set(videoId, t);
      return t;
    } catch {
      return videoId;
    } finally {
      inflight.delete(videoId);
    }
  })();
  inflight.set(videoId, p);
  return p;
}
