// @vitest-environment jsdom
/**
 * splitResizer.dom — behaviour tests for the divider drag wiring.
 *
 * installResizer() is the piece that was rewritten after the real-machine
 * investigation of issue #4. These tests drive the actual listeners with
 * synthetic MouseEvents, so the regression they guard against is the wiring,
 * not the arithmetic (that lives in splitResizer.test.ts).
 *
 * jsdom has no layout engine, so getBoundingClientRect() is stubbed per
 * element — the same approach tests/unit/core/pdf/sdt/interleaveView.manual.test.ts
 * uses. Note that the handler reads `screenX`, never `clientX`: that is the
 * whole point of the fix (see installResizer's doc comment), and these tests
 * pin it by giving the two fields deliberately different values.
 *
 * Run: npm run test:unit -- splitResizer.dom
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installResizer } from "../../../../../src/core/pdf/splitview/splitViewFactory";
import {
  MIN_PANE_WIDTH,
  RESIZER_WIDTH,
  type SplitTabState,
} from "../../../../../src/core/pdf/splitview/types";

const HBOX_WIDTH = 1264;
const USABLE = HBOX_WIDTH - RESIZER_WIDTH;
const START_LEFT = USABLE / 2; // 629.5

/** A DOM element whose getBoundingClientRect reports a fixed width. */
function stubWidth(el: HTMLElement, width: number): void {
  el.getBoundingClientRect = () =>
    ({ width, left: 0, right: width, top: 0, bottom: 0 }) as DOMRect;
}

interface Harness {
  state: SplitTabState;
  win: Window & { runTimers: () => void };
  resizer: HTMLElement;
  left: HTMLElement;
  right: HTMLElement;
  down: (screenX: number) => void;
  move: (screenX: number, buttons?: number) => void;
  up: () => void;
}

function makeHarness(): Harness {
  const resizer = document.createElement("div");
  const left = document.createElement("div");
  const right = document.createElement("div");
  stubWidth(left, START_LEFT);

  const mainHbox = document.createElement("div");
  stubWidth(mainHbox, HBOX_WIDTH);

  const timers: Array<() => void> = [];
  const win = window as Window & { runTimers: () => void };
  // Replace the timer the handler uses so the resume callback can be driven
  // synchronously. setTimeout lives on the window, which is also the event
  // target the mousemove/mouseup listeners are attached to.
  (win as any).setTimeout = (fn: () => void) => {
    timers.push(fn);
    return timers.length;
  };
  win.runTimers = () => {
    for (const fn of timers.splice(0)) fn();
  };

  const state: SplitTabState = {
    tabID: "t",
    win,
    container: null,
    mainHbox,
    leftBrowser: left,
    rightBrowser: right,
    resizer,
    leftAdapter: null,
    rightAdapter: null,
    syncPaused: false,
    mirrorGuard: false,
    syncScheduled: false,
    lastLeftFraction: null,
    lastRightFraction: null,
    lastLeftHFraction: null,
    lastRightHFraction: null,
    lastLeftScale: null,
    lastRightScale: null,
    lastLeftScaleValue: null,
    lastRightScaleValue: null,
    syncIntervalId: null,
    syncRAFId: null,
    leftTriggerCleanup: null,
    rightTriggerCleanup: null,
    eventListeners: [],
    timeoutIds: [],
    isCleaningUp: false,
  };

  installResizer(state);

  // clientX is deliberately left at 0: a handler that still reads it would
  // clamp to the minimum instead of following screenX.
  const fire = (type: string, target: EventTarget, screenX: number, buttons: number) =>
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons,
        screenX,
        clientX: 0,
      }),
    );

  return {
    state,
    win,
    resizer,
    left,
    right,
    down: (screenX: number) => fire("mousedown", resizer, screenX, 1),
    move: (screenX: number, buttons = 1) => fire("mousemove", win, screenX, buttons),
    up: () => fire("mouseup", win, 0, 0),
  };
}

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("installResizer", () => {
  it("mousedown enters the drag and pauses sync", () => {
    expect(h.resizer.className).toBe("");
    h.down(600);
    expect(h.resizer.className).toBe("dragging");
    expect(h.state.syncPaused).toBe(true);
  });

  it("ignores a non-primary button", () => {
    h.resizer.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 2, buttons: 2 }),
    );
    expect(h.resizer.className).toBe("");
    expect(h.state.syncPaused).toBe(false);
  });

  it("does nothing before mousedown", () => {
    h.move(700);
    expect(h.left.style.flexGrow).toBe("");
    expect(h.right.style.flexGrow).toBe("");
  });

  it("moves both panes by the pointer travel", () => {
    h.down(600);
    h.move(700); // +100 to the right
    expect(h.left.style.flexGrow).toBe(String(START_LEFT + 100));
    expect(h.right.style.flexGrow).toBe(String(USABLE - START_LEFT - 100));

    h.move(500); // back to the left of the start
    expect(h.left.style.flexGrow).toBe(String(START_LEFT - 100));
    expect(h.right.style.flexGrow).toBe(String(USABLE - START_LEFT + 100));
  });

  it("keeps the two flexGrow values summing to the usable width", () => {
    h.down(600);
    for (const screenX of [610, 650, 700, 800, 900, 1000]) {
      h.move(screenX);
      const sum =
        Number(h.left.style.flexGrow) + Number(h.right.style.flexGrow);
      expect(sum).toBe(USABLE);
    }
  });

  it("clamps at both ends without a dead zone", () => {
    h.down(600);
    h.move(600 + 5000);
    expect(h.left.style.flexGrow).toBe(String(USABLE - MIN_PANE_WIDTH));
    expect(h.right.style.flexGrow).toBe(String(MIN_PANE_WIDTH));

    h.move(600 - 5000);
    expect(h.left.style.flexGrow).toBe(String(MIN_PANE_WIDTH));
    expect(h.right.style.flexGrow).toBe(String(USABLE - MIN_PANE_WIDTH));
  });

  it("mouseup ends the drag and schedules the sync resume", () => {
    h.down(600);
    h.move(700);
    h.up();
    expect(h.resizer.className).toBe("");
    expect(h.state.syncPaused).toBe(true); // still paused until the timer runs

    h.win.runTimers();
    expect(h.state.syncPaused).toBe(false);
  });

  it("does not resume sync when the tab is being cleaned up", () => {
    h.down(600);
    h.up();
    h.state.isCleaningUp = true;
    h.win.runTimers();
    expect(h.state.syncPaused).toBe(true);
  });

  it("ends the drag itself when the button is already released", () => {
    // Regression guard: a mouseup swallowed by the pane used to leave the drag
    // running, so every later pointer move kept resizing the panes.
    h.down(600);
    h.move(700, 0); // no button held
    expect(h.resizer.className).toBe("");
    // The panes must not have moved on that event.
    expect(h.left.style.flexGrow).toBe("");
  });

  it("stops responding once the drag has ended", () => {
    h.down(600);
    h.up();
    const before = h.left.style.flexGrow;
    h.move(900);
    expect(h.left.style.flexGrow).toBe(before);
  });

  it("registers every listener for cleanup", () => {
    const targets = h.state.eventListeners.map((l) => l.target);
    const types = h.state.eventListeners.map((l) => l.type);
    expect(targets).toContain(h.resizer);
    expect(targets).toContain(h.win);
    expect(types.sort()).toEqual(["mousedown", "mousemove", "mouseup"]);
  });
});
