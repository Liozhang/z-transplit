/**
 * IME-safe keyboard test.
 *
 * Extracted from translatePane.ts so the word-cards tab's search box
 * (src/ui/wordCardsTab.ts) shares one implementation.
 *
 * During composition, Enter CONFIRMS the candidate — it must not submit.
 * `isComposing` covers the modern path, `keyCode === 229` the legacy one.
 */
export function isIMEComposing(e: any): boolean {
  if (!e) return false;
  if (e.isComposing === true || e.keyCode === 229) return true;
  const native = e.nativeEvent;
  return native?.isComposing === true || native?.keyCode === 229;
}
