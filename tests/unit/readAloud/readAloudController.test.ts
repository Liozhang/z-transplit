/**
 * ReadAloudController state-machine tests — Web Speech driven against a fake
 * speechSynthesis whose cancel()/finish() fire onend on a LATER macrotask, the
 * same task model real platforms use. That async onend is exactly what
 * behavior-F4 tripped: a moveTo()'s canceled utterance fired onend after the
 * index had moved, read the new index as "last sentence finished" and either
 * truncated the freshly started sentence or double-advanced.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ReadAloudController,
  type ReadAloudSegment,
} from "../../../src/core/readAloud/readAloudController";

class FakeUtterance {
  text: string;
  lang = "";
  rate = 1;
  voice: any = null;
  onend: (() => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

/** Minimal speechSynthesis double; onend always lands on a later macrotask. */
class FakeSynth {
  spoken: FakeUtterance[] = [];
  private current: FakeUtterance | null = null;

  speak(u: FakeUtterance): void {
    this.spoken.push(u);
    this.current = u;
  }

  cancel(): void {
    const u = this.current;
    this.current = null;
    // Real platforms fire the canceled utterance's onend asynchronously.
    if (u) setTimeout(() => u.onend?.(), 0);
  }

  /** Natural end of the current utterance (test-driven). */
  finish(): void {
    const u = this.current;
    this.current = null;
    if (u) setTimeout(() => u.onend?.(), 0);
  }

  pause(): void {}
  resume(): void {}
  getVoices(): any[] {
    return [];
  }
}

function segs(...texts: string[]): ReadAloudSegment[] {
  return texts.map((text) => ({ text }));
}

/** Drain one macrotask turn: all pending onend/stopping-clear timers fire. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function makeController(synth: FakeSynth, hooks: { onEnded?: () => void } = {}) {
  return new ReadAloudController({
    getWin: () =>
      ({
        speechSynthesis: synth,
        SpeechSynthesisUtterance: FakeUtterance,
      }) as any,
    onEnded: hooks.onEnded,
  });
}

describe("ReadAloudController moveTo（behavior-F4 回归：末句截断/索引错位）", () => {
  it("mid-sentence next()：被 cancel 的旧 onend 既不截断新句也不 double-advance", async () => {
    const synth = new FakeSynth();
    const c = makeController(synth);
    c.play(segs("a", "b", "c"));
    expect(synth.spoken.map((u) => u.text)).toEqual(["a"]);

    c.next(); // moveTo(1): cancel(a) + 同步 speak(b)
    expect(synth.spoken.map((u) => u.text)).toEqual(["a", "b"]);
    expect(c.getState()).toMatchObject({ playing: true, index: 1 });

    // 旧 utterance 的 onend 在 index 已移动之后才到——必须被抑制。
    await flush();
    expect(synth.spoken.map((u) => u.text)).toEqual(["a", "b"]);
    expect(c.getState()).toMatchObject({ playing: true, index: 1 });

    // 新句正常播完并推进到最后一句——不被截断。
    synth.finish(); // b 结束 → c
    await flush();
    expect(synth.spoken.map((u) => u.text)).toEqual(["a", "b", "c"]);
    expect(c.getState().index).toBe(2);
    synth.finish(); // c 结束（末句）→ 停止
    await flush();
    expect(c.getState().playing).toBe(false);
  });

  it("末句 next()：干净停止，迟到的 onend 不能复活播放或重复触发 onEnded", async () => {
    const synth = new FakeSynth();
    const onEnded = vi.fn();
    const c = makeController(synth, { onEnded });
    c.play(segs("a", "b"));
    synth.finish(); // a → b
    await flush();
    expect(c.getState()).toMatchObject({ playing: true, index: 1 });

    c.next(); // moveTo(2) — 越过末句 → stopInternal
    expect(c.getState().playing).toBe(false);
    expect(onEnded).toHaveBeenCalledTimes(1);

    await flush(); // b 被 cancel 的 onend 迟到
    expect(c.getState().playing).toBe(false);
    expect(synth.spoken.map((u) => u.text)).toEqual(["a", "b"]);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("mid-list prev()：回退一句重播，旧 onend 不造成错位", async () => {
    const synth = new FakeSynth();
    const c = makeController(synth);
    c.play(segs("a", "b", "c"));
    synth.finish(); // → b
    await flush();
    c.next(); // → c
    c.prev(); // → b（重播）
    expect(c.getState().index).toBe(1);
    expect(synth.spoken.map((u) => u.text)).toEqual(["a", "b", "c", "b"]);
    await flush(); // 被 cancel 的 c 的 onend 迟到
    expect(c.getState().index).toBe(1);
    expect(synth.spoken).toHaveLength(4);
  });

  it("stop() 同样抑制迟到的 onend", async () => {
    const synth = new FakeSynth();
    const c = makeController(synth);
    c.play(segs("a", "b"));
    c.stop();
    expect(c.getState().playing).toBe(false);
    await flush();
    expect(c.getState().playing).toBe(false);
    expect(synth.spoken).toHaveLength(1);
  });

  it("pause/resume 只切换暂停态，不 cancel 语音", () => {
    const synth = new FakeSynth();
    const c = makeController(synth);
    c.play(segs("a", "b"));
    c.pause();
    expect(c.getState().paused).toBe(true);
    c.resume();
    expect(c.getState().paused).toBe(false);
    expect(synth.spoken).toHaveLength(1);
  });
});
