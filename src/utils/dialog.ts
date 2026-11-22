/**
 * Unified modal alert for user-facing failures.
 *
 * The codebase previously alerted through three different paths —
 * Services.prompt.alert (registerItemTreeMenu), the legacy
 * Components.classes nsIPromptService (splitViewFactory), each with its own
 * title convention. Services.prompt is available in the bootstrap loadSubScript
 * scope on both Zotero 7 and 10, so this collapses them into one entry point
 * that always passes a parent window (nsIPromptService.alert(null, …) opens an
 * ownerless dialog, which on Windows can surface behind the main window).
 *
 * Never throws: a failed alert must not mask the error it is reporting — the
 * caller's debug log keeps the details.
 */

import { safeDebug } from "./logger";

export function alertDialog(title: string, text: string, win?: any): void {
  try {
    const Services = (globalThis as any).Services;
    const parent =
      win ?? (globalThis as any).Zotero?.getMainWindow?.() ?? null;
    Services?.prompt?.alert(parent, title, text);
  } catch (e) {
    safeDebug("[Z-Transplit] alertDialog failed: " + e);
  }
}

/**
 * Modal single-line text input. Returns the entered string, or null when the
 * user cancelled (or no prompt service is available — same never-throws
 * contract as alertDialog: a failed dialog must not take the caller down).
 *
 * The argument shape is load-bearing. nsIPromptService.prompt takes the entered
 * value and the checkbox state as `inout` parameters, and XPConnect only accepts
 * a plain object (`{ value: … }`) for an `inout` parameter — a primitive or null
 * is rejected with NS_ERROR_XPC_NEED_OUT_OBJECT. Passing null for the checkbox
 * state therefore makes every prompt fail before a dialog appears, which is how
 * "translate specified pages" used to do nothing at all. The shape below is the
 * one Zotero itself uses in the same build (aboutProfiles.js, printPageSetup.js,
 * advancedSearchPane.js, devtools prompt.js — all pass `null` then an object).
 */
export function promptDialog(
  title: string,
  text: string,
  initialValue = "",
  win?: any,
): string | null {
  try {
    const Services = (globalThis as any).Services;
    const parent =
      win ?? (globalThis as any).Zotero?.getMainWindow?.() ?? null;
    const input = { value: String(initialValue ?? "") };
    const checkState = { value: false };
    const ok = Services?.prompt?.prompt(parent, title, text, input, null, checkState);
    return ok ? String(input.value ?? "") : null;
  } catch (e) {
    safeDebug("[Z-Transplit] promptDialog failed: " + e);
    return null;
  }
}
