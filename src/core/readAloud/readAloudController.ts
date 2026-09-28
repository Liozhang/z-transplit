/**
 * readAloudController — sentence-level TTS playback state machine.
 *
 * Transport-agnostic: callers build the segment list (and any highlight/scroll
 * side effects) and drive the controller; the controller owns the Web Speech
 * playback, the play/pause/prev/next/stop state machine and sentence-boundary
 * callbacks. Voices come from the host's speechSynthesis (Windows SAPI on
 * desktop Zotero — free, offline, zero configuration).
 *
 * @module core/readAloud/readAloudController
 */

import { safeDebug } from "../../utils/logger";

export interface ReadAloudSegment {
  text: string;
  /** Opaque caller context (block ref, page number, …), echoed back. */
  meta?: any;
}

export interface ReadAloudState {
  playing: boolean;
  paused: boolean;
  index: number;
  total: number;
}

export interface ReadAloudOptions {
  /** Resolve the window whose speechSynthesis drives playback. */
  getWin: () => any | null;
  /** Preferred voice name (exact or substring, case-insensitive). */
  voiceName?: string;
  /** Preferred voice language prefix, e.g. "en" / "zh". */
  lang?: string;
  rate?: number;
  onState?: (state: ReadAloudState) => void;
  /** Fired when a sentence starts (before speak) — highlight hook. */
  onSentenceStart?: (index: number, segment: ReadAloudSegment) => void;
  /** Fired when playback leaves a sentence — unhighlight hook. */
  onSentenceEnd?: (index: number, segment: ReadAloudSegment) => void;
  /** Fired when the list finishes or playback stops. */
  onEnded?: () => void;
}

export class ReadAloudController {
  private segments: ReadAloudSegment[] = [];
  private index = 0;
  private playing = false;
  private paused = false;
  private stopping = false;
  private currentUtterance: any = null;

  constructor(private opts: ReadAloudOptions) {}

  isSupported(): boolean {
    try {
      return !!this.opts.getWin()?.speechSynthesis;
    } catch {
      return false;
    }
  }

  private synth(): any {
    return this.opts.getWin()?.speechSynthesis ?? null;
  }

  private pickVoice(): any {
    try {
      const synth = this.synth();
      if (!synth) return null;
      const voices: any[] = synth.getVoices?.() || [];
      if (voices.length === 0) return null;
      const wanted = this.opts.voiceName?.toLowerCase();
      if (wanted) {
        const exact = voices.find(
          (v) => v.name?.toLowerCase() === wanted || v.voiceURI?.toLowerCase?.() === wanted,
        );
        const fuzzy = voices.find((v) => v.name?.toLowerCase?.().includes(wanted));
        if (exact || fuzzy) return exact ?? fuzzy;
      }
      if (this.opts.lang) {
        const prefix = this.opts.lang.toLowerCase();
        const byLang = voices.find((v) =>
          String(v.lang || "").toLowerCase().startsWith(prefix),
        );
        if (byLang) return byLang;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Load a segment list and start playback at `startIndex`. */
  play(segments: ReadAloudSegment[], startIndex = 0): void {
    if (!this.isSupported() || segments.length === 0) {
      this.opts.onEnded?.();
      return;
    }
    this.stopInternal(false);
    this.segments = segments.filter((s) => s.text && s.text.trim());
    this.index = Math.min(Math.max(startIndex, 0), this.segments.length - 1);
    this.playing = true;
    this.paused = false;
    this.emit();
    void this.speakCurrent();
  }

  pause(): void {
    if (!this.playing || this.paused) return;
    try {
      this.synth()?.pause?.();
      this.paused = true;
      this.emit();
    } catch (e) {
      safeDebug("[Z-Transplit] readAloud pause: " + e);
    }
  }

  resume(): void {
    if (!this.playing || !this.paused) return;
    try {
      this.synth()?.resume?.();
      this.paused = false;
      this.emit();
    } catch (e) {
      safeDebug("[Z-Transplit] readAloud resume: " + e);
    }
  }

  next(): void {
    if (!this.playing) return;
    this.moveTo(this.index + 1);
  }

  prev(): void {
    if (!this.playing) return;
    this.moveTo(Math.max(0, this.index - 1));
  }

  /** Jump to a sentence (read-from-here). Starts playback if idle. */
  jumpTo(index: number): void {
    if (this.playing) {
      this.moveTo(index);
      return;
    }
    if (index < 0 || index >= this.segments.length) return;
    this.playing = true;
    this.paused = false;
    this.index = index;
    this.emit();
    void this.speakCurrent();
  }

  stop(): void {
    this.stopInternal(true);
  }

  getState(): ReadAloudState {
    return {
      playing: this.playing,
      paused: this.paused,
      index: this.index,
      total: this.segments.length,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private stopInternal(emit: boolean): void {
    this.stopping = true;
    try {
      const synth = this.synth();
      synth?.cancel?.();
    } catch {
      /* ignore */
    }
    const leaving = this.playing ? this.segments[this.index] : undefined;
    if (leaving) this.opts.onSentenceEnd?.(this.index, leaving);
    this.playing = false;
    this.paused = false;
    this.currentUtterance = null;
    // Cancel fires onend asynchronously; clear the flag on the next tick.
    setTimeout(() => {
      this.stopping = false;
    }, 0);
    if (emit) {
      this.emit();
      this.opts.onEnded?.();
    }
  }

  private moveTo(index: number): void {
    if (index >= this.segments.length) {
      this.stopInternal(true);
      return;
    }
    // Cancel the current utterance; speakCurrent is re-entered via the
    // onend handler chain, so just cancel and set the target index.
    const leaving = this.segments[this.index];
    this.opts.onSentenceEnd?.(this.index, leaving);
    this.index = index;
    this.paused = false;
    this.emit();
    // cancel() fires the OLD utterance's onend asynchronously, after `index`
    // has already moved — that stale onend would then read the new index as
    // "last sentence finished", cancel the freshly started sentence and
    // double-advance. Same suppression as stopInternal: set before cancel,
    // clear on the next tick.
    this.stopping = true;
    try {
      const synth = this.synth();
      synth?.cancel?.();
    } catch {
      /* ignore — onend fallback below */
    }
    setTimeout(() => {
      this.stopping = false;
    }, 0);
    // Some platforms never fire onend after cancel(); speak directly too.
    // The duplicate speak attempt is harmless (cancel already cleared the
    // queue) but keeps prev/next responsive on Windows SAPI.
    void this.speakCurrent();
  }

  private emit(): void {
    try {
      this.opts.onState?.(this.getState());
    } catch {
      /* UI callback must never break playback */
    }
  }

  private async speakCurrent(): Promise<void> {
    if (!this.playing || this.paused) return;
    const segment = this.segments[this.index];
    if (!segment) {
      this.stopInternal(true);
      return;
    }
    // Highlight hooks run outside the speak try — a broken hook must never
    // kill playback (found in the 10.0.3 E2E: a meta-shape mismatch threw
    // here and silence followed).
    try {
      this.opts.onSentenceStart?.(this.index, segment);
    } catch (e) {
      safeDebug("[Z-Transplit] readAloud onSentenceStart hook failed: " + e);
    }
    try {
      const win = this.opts.getWin();
      const synth = win?.speechSynthesis;
      if (!synth) {
        this.stopInternal(true);
        return;
      }
      const utterance = new win.SpeechSynthesisUtterance(segment.text);
      const voice = this.pickVoice();
      if (voice) utterance.voice = voice;
      if (this.opts.lang) utterance.lang = this.opts.lang;
      utterance.rate = this.opts.rate ?? 1;
      this.currentUtterance = utterance;
      utterance.onend = () => {
        // Stale onend from an utterance canceled by stop()/moveTo(): the
        // boolean stopping flag alone races when a previous cancel's
        // clear-timer fires first (overlapping prev/next), so also drop any
        // utterance that is no longer the current one.
        if (utterance !== this.currentUtterance) return;
        if (this.stopping || !this.playing) return;
        this.opts.onSentenceEnd?.(this.index, segment);
        if (!this.playing || this.paused) return;
        if (this.index + 1 >= this.segments.length) {
          this.stopInternal(true);
          return;
        }
        this.index++;
        this.emit();
        void this.speakCurrent();
      };
      utterance.onerror = (ev: any) => {
        if (utterance !== this.currentUtterance || this.stopping) return;
        // "interrupted"/"canceled" errors accompany cancel() — not failures.
        if (ev?.error === "interrupted" || ev?.error === "canceled") return;
        safeDebug("[Z-Transplit] readAloud utterance error: " + (ev?.error || ev));
        // Skip the broken sentence instead of stalling.
        if (this.index + 1 >= this.segments.length) {
          this.stopInternal(true);
        } else {
          this.moveTo(this.index + 1);
        }
      };
      synth.speak(utterance);
    } catch (e) {
      safeDebug("[Z-Transplit] readAloud speak failed: " + e);
      this.stopInternal(true);
    }
  }
}
