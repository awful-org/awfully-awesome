import { describe, expect, it } from "vitest";
import { initialState, reduce, youtubeVideoId, type MusicState } from "./logic";

const ctx = (name = "Alice") => ({
  senderDid: `did:${name}`,
  senderName: name,
  updateId: "update-1",
  lamport: 1,
  ephemeral: false,
});

const first = "M7lc1UVf-VE";
const second = "dQw4w9WgXcQ";

function update(state: MusicState, data: unknown, name = "Alice") {
  return reduce(state, { data }, ctx(name));
}

describe("youtubeVideoId", () => {
  it("accepts supported YouTube URL forms", () => {
    expect(youtubeVideoId(`https://www.youtube.com/watch?v=${first}`)).toBe(first);
    expect(youtubeVideoId(`https://youtu.be/${first}?feature=share`)).toBe(first);
    expect(youtubeVideoId(`https://youtube.com/shorts/${first}`)).toBe(first);
    expect(youtubeVideoId(`https://music.youtube.com/embed/${first}`)).toBe(first);
  });

  it("rejects missing, malformed, and unsupported video URLs", () => {
    expect(youtubeVideoId("not a url")).toBeNull();
    expect(youtubeVideoId("https://example.com/watch?v=M7lc1UVf-VE")).toBeNull();
    expect(youtubeVideoId("https://youtube.com/watch?v=short")).toBeNull();
    expect(youtubeVideoId("https://youtube.com/watch")).toBeNull();
  });
});

describe("music reducer", () => {
  it("seeds one selected queue item from card data", () => {
    expect(initialState({ videoId: first })).toEqual({
      queue: [first], currentIndex: 0, playing: false, position: 0, activity: [],
    });
    expect(initialState({ videoId: "invalid" }).queue).toEqual([]);
  });

  it("adds a valid entry and records the verified actor", () => {
    const state = update(initialState({ videoId: first }), { action: "add", videoId: second }, "Bruno");
    expect(state.queue).toEqual([first, second]);
    expect(state.activity).toEqual([{ senderName: "Bruno", action: "added", videoId: second }]);
  });

  it("rejects invalid adds without changing state or activity", () => {
    const original = initialState({ videoId: first });
    expect(update(original, { action: "add", videoId: "invalid" })).toBe(original);
  });

  it("removes the selected entry and selects the remaining entry", () => {
    const state = update(
      { ...initialState({ videoId: first }), queue: [first, second], playing: true, position: 25 },
      { action: "remove", index: 0 },
      "Carla"
    );
    expect(state.queue).toEqual([second]);
    expect(state.currentIndex).toBe(0);
    expect(state.position).toBe(0);
    expect(state.activity.at(-1)).toEqual({ senderName: "Carla", action: "removed", videoId: first });
  });

  it("stops playback when the final entry is removed", () => {
    const state = update(initialState({ videoId: first }), { action: "remove", index: 0 });
    expect(state.queue).toEqual([]);
    expect(state.currentIndex).toBeNull();
    expect(state.playing).toBe(false);
  });

  it("skips to the next track and stops after the final track", () => {
    const queued = { ...initialState({ videoId: first }), queue: [first, second], playing: true };
    const next = update(queued, { action: "skip" });
    expect(next.currentIndex).toBe(1);
    expect(next.playing).toBe(true);
    expect(next.position).toBe(0);
    const ended = update(next, { action: "skip" });
    expect(ended.currentIndex).toBeNull();
    expect(ended.playing).toBe(false);
  });

  it("persists valid playback intent and rejects invalid positions", () => {
    const started = update(initialState({ videoId: first }), { action: "play", position: 12 });
    expect(started.playing).toBe(true);
    expect(started.position).toBe(12);
    const paused = update(started, { action: "pause", position: 18 }, "Dana");
    expect(paused.playing).toBe(false);
    expect(paused.position).toBe(18);
    expect(paused.activity.at(-1)).toEqual({ senderName: "Dana", action: "paused", videoId: first });
    expect(update(paused, { action: "seek", position: -1 })).toBe(paused);
    expect(update(paused, { action: "seek", position: Number.NaN })).toBe(paused);
  });
});
