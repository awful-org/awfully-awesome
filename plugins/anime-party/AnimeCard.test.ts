import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import LoopButton, {
  loopButtonClass,
  loopLabelFor,
  queueButtonClass,
} from "./LoopButton.svelte";
import { episodeLabel } from "./titles";

describe("party control states", () => {
  it.each([
    ["off", "Loop Off"],
    ["track", "Loop Track"],
    ["queue", "Loop Queue"],
  ] as const)("labels %s loop mode", (mode, label) => {
    expect(loopLabelFor(mode)).toBe(label);
    const { body } = render(LoopButton, {
      props: { mode, onclick: () => {} },
    });
    expect(body).toContain(`aria-label="${label}"`);
    // The app's tooltip, not the browser's. This used to assert the native
    // `title` and so passed happily while the loop button was the last
    // control still popping an unstyled OS tooltip in the middle of the app.
    expect(body).not.toContain("title=");
  });

  it("keeps the off loop muted and active loops green", () => {
    expect(loopButtonClass("off")).toBe("border-border hover:bg-muted");
    for (const mode of ["track", "queue"] as const) {
      expect(loopButtonClass(mode)).toContain("border-green-500/50");
      expect(loopButtonClass(mode)).toContain("text-green-500");
      expect(loopButtonClass(mode)).toContain("hover:bg-green-500/10");
    }
  });

  it("uses muted queue hover until the panel is open", () => {
    expect(queueButtonClass(false)).toBe("border-border hover:bg-muted");
    expect(queueButtonClass(true)).toContain("bg-green-500/10");
    expect(queueButtonClass(true)).toContain("text-green-500");
    expect(queueButtonClass(true)).toContain("hover:bg-green-500/20");
  });
});

describe("episode labels", () => {
  const show = { title: "Bocchi the Rock!" };

  it("names a track by its show and episode number", () => {
    expect(episodeLabel(show, { number: 7 })).toBe(
      "Bocchi the Rock! · Episode 7"
    );
  });

  it("degrades to whichever half it has", () => {
    expect(episodeLabel(show, null)).toBe("Bocchi the Rock!");
    expect(episodeLabel(null, { number: 3 })).toBe("Episode 3");
    expect(episodeLabel(null, null)).toBe("");
  });

  it("keeps episode 0 (a special or a recap) a real episode", () => {
    expect(episodeLabel(show, { number: 0 })).toBe(
      "Bocchi the Rock! · Episode 0"
    );
  });
});
