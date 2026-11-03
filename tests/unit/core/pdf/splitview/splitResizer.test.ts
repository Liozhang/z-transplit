/**
 * splitResizer — unit tests for the divider's width arithmetic.
 *
 * resolveLeftWidth() is the pure core of installResizer(): it turns "where the
 * pointer was at mousedown" plus "how far it travelled" into the left pane's
 * pixel width. The retargeted-coordinate bug that made the divider jump (see
 * installResizer's doc comment) is invisible here — these tests pin the
 * clamping contract instead, including the degenerate narrow-container case
 * the old hardcoded [0.1, 0.9] ratio clamp got wrong.
 *
 * Run: npm run test:unit -- splitResizer
 */

import { describe, expect, it } from "vitest";

import { resolveLeftWidth } from "../../../../../src/core/pdf/splitview/splitViewFactory";
import { MIN_PANE_WIDTH, RESIZER_WIDTH } from "../../../../../src/core/pdf/splitview/types";

/** The width both panes share, i.e. the hbox width minus the divider itself. */
function usable(hboxWidth: number): number {
  return hboxWidth - RESIZER_WIDTH;
}

describe("resolveLeftWidth", () => {
  it("returns the start width plus the travel inside the legal range", () => {
    // 1264px hbox → 1259px usable, start 629.5, drag right by 100.
    expect(resolveLeftWidth(629.5, 100, usable(1264))).toBe(729.5);
    expect(resolveLeftWidth(629.5, -100, usable(1264))).toBe(529.5);
  });

  it("clamps to the minimum pane width", () => {
    // A long drag left must stop at MIN_PANE_WIDTH, not run past it.
    expect(resolveLeftWidth(629.5, -5000, usable(1264))).toBe(MIN_PANE_WIDTH);
    // Starting below the floor is also pulled up to it.
    expect(resolveLeftWidth(10, 0, usable(1264))).toBe(MIN_PANE_WIDTH);
  });

  it("clamps to the maximum pane width", () => {
    // A long drag right must stop at total - MIN_PANE_WIDTH.
    expect(resolveLeftWidth(629.5, 5000, usable(1264))).toBe(
      usable(1264) - MIN_PANE_WIDTH,
    );
  });

  it("keeps the result inside the range for every travel value", () => {
    const total = usable(1264);
    for (let dx = -2000; dx <= 2000; dx += 37) {
      const w = resolveLeftWidth(400, dx, total);
      expect(w).toBeGreaterThanOrEqual(MIN_PANE_WIDTH);
      expect(w).toBeLessThanOrEqual(total - MIN_PANE_WIDTH);
      // The right pane is whatever is left, so it must respect its own floor.
      expect(total - w).toBeGreaterThanOrEqual(MIN_PANE_WIDTH);
    }
  });

  it("leaves both panes inside the range on an exactly-sized window", () => {
    // total === 2 * MIN_PANE_WIDTH is the tightest workable layout.
    const total = MIN_PANE_WIDTH * 2;
    expect(resolveLeftWidth(MIN_PANE_WIDTH, 0, total)).toBe(MIN_PANE_WIDTH);
    expect(resolveLeftWidth(MIN_PANE_WIDTH, 50, total)).toBe(MIN_PANE_WIDTH);
    expect(resolveLeftWidth(MIN_PANE_WIDTH, -50, total)).toBe(MIN_PANE_WIDTH);
  });

  it("does not collapse the left pane when the window is narrower than two minimums", () => {
    // Regression guard: with total < 2 * minPane a naive
    // Math.min(total - minPane, Math.max(minPane, x)) inverts its own bounds
    // and yields 0 (or a negative width), because the upper bound sits below
    // the lower one.
    const total = MIN_PANE_WIDTH - 50;
    for (const dx of [-1000, -10, 0, 10, 1000]) {
      const w = resolveLeftWidth(MIN_PANE_WIDTH, dx, total);
      expect(w).toBe(MIN_PANE_WIDTH);
      expect(w).toBeGreaterThan(0);
    }
  });

  it("is exact at the boundaries", () => {
    const total = usable(1264);
    const max = total - MIN_PANE_WIDTH;
    expect(resolveLeftWidth(max, 0, total)).toBe(max);
    expect(resolveLeftWidth(MIN_PANE_WIDTH, 0, total)).toBe(MIN_PANE_WIDTH);
    // One pixel past either boundary must not move the width.
    expect(resolveLeftWidth(max, 1, total)).toBe(max);
    expect(resolveLeftWidth(MIN_PANE_WIDTH, -1, total)).toBe(MIN_PANE_WIDTH);
  });
});
