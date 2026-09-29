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
