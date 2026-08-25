import type { UpdateCtx } from "$lib/plugins/api";

export type ActivityAction =
  | "added"
  | "removed"
  | "skipped"
  | "played"
  | "paused"
  | "seeked";

export interface Activity {
  senderName: string;
  action: ActivityAction;
  videoId: string | null;
}

export interface MusicState {
  queue: string[];
  currentIndex: number | null;
  playing: boolean;
  position: number;
  activity: Activity[];
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function validVideoId(value: unknown): value is string {
  return typeof value === "string" && VIDEO_ID_RE.test(value);
}

export function youtubeVideoId(input: string): string | null {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let candidate: string | null = null;

    if (host === "youtu.be") {
      candidate = url.pathname.split("/").filter(Boolean)[0] ?? null;
    } else if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/watch") candidate = url.searchParams.get("v");
      if (parts[0] === "shorts" || parts[0] === "embed") candidate = parts[1] ?? null;
    }

    return validVideoId(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function initialState(cardData: unknown): MusicState {
  const data = cardData as { videoId?: unknown } | null;
  const videoId = validVideoId(data?.videoId) ? data.videoId : null;
  return {
    queue: videoId ? [videoId] : [],
    currentIndex: videoId ? 0 : null,
    playing: false,
    position: 0,
    activity: [],
  };
}

function validIndex(index: unknown, queue: string[]): index is number {
  return (
    typeof index === "number" &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < queue.length
  );
}

function validPosition(position: unknown): position is number {
  return typeof position === "number" && Number.isFinite(position) && position >= 0;
}

function withActivity(
  state: MusicState,
  ctx: UpdateCtx,
  action: ActivityAction,
  videoId: string | null
): MusicState {
  return {
    ...state,
    activity: [...state.activity, { senderName: ctx.senderName, action, videoId }],
  };
}

export function reduce(state: unknown, update: { data: unknown }, ctx: UpdateCtx): MusicState {
  const music = state as MusicState;
  const data = update.data as Record<string, unknown>;

  switch (data.action) {
    case "add": {
      if (!validVideoId(data.videoId)) return music;
      return withActivity(
        { ...music, queue: [...music.queue, data.videoId] },
        ctx,
        "added",
        data.videoId
      );
    }
    case "remove": {
      if (!validIndex(data.index, music.queue)) return music;
      const removedVideoId = music.queue[data.index];
      const queue = music.queue.filter((_, index) => index !== data.index);
      let currentIndex = music.currentIndex;
      let playing = music.playing;
      let position = music.position;

      if (currentIndex === data.index) {
        currentIndex = queue.length === 0 ? null : Math.min(data.index, queue.length - 1);
        playing = queue.length === 0 ? false : playing;
        position = 0;
      } else if (currentIndex !== null && currentIndex > data.index) {
        currentIndex -= 1;
      }

      return withActivity(
        { ...music, queue, currentIndex, playing, position },
        ctx,
        "removed",
        removedVideoId
      );
    }
    case "skip": {
      if (music.currentIndex === null) return music;
      const videoId = music.queue[music.currentIndex] ?? null;
      const currentIndex = music.currentIndex + 1;
      return withActivity(
        currentIndex < music.queue.length
          ? { ...music, currentIndex, position: 0 }
          : { ...music, currentIndex: null, playing: false, position: 0 },
        ctx,
        "skipped",
        videoId
      );
    }
    case "play": {
      if (music.currentIndex === null || !validPosition(data.position)) return music;
      if (music.playing && music.position === data.position) return music;
      return withActivity({ ...music, playing: true, position: data.position }, ctx, "played", music.queue[music.currentIndex]);
    }
    case "pause": {
      if (music.currentIndex === null || !validPosition(data.position)) return music;
      if (!music.playing && music.position === data.position) return music;
      return withActivity({ ...music, playing: false, position: data.position }, ctx, "paused", music.queue[music.currentIndex]);
    }
    case "seek": {
      if (music.currentIndex === null || !validPosition(data.position)) return music;
      if (music.position === data.position) return music;
      return withActivity({ ...music, position: data.position }, ctx, "seeked", music.queue[music.currentIndex]);
    }
    default:
      return music;
  }
}
