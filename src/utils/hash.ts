/**
 * hash — WebCrypto digest helpers shared by the JVM-based components.
 *
 * Both JavaRuntimeManager (downloaded JRE archives) and
 * OpenDataLoaderPdfClient (jars unpacked from a packed XPI install) verify
 * SHA-256 digests; this is the single implementation so the two callers can
 * never drift (different casing, different null-handling).
 *
 * sha256HexOfString() serves the Youdao 智云 signature (a string in, hex out).
 * It resolves WebCrypto from the bundle scope first and from the main window
 * second — src/utils/abort.ts documents that some web globals are missing in
 * Zotero's shared plugin scope (AbortController was, on 10.0.3), so a caller
 * that NEEDS a digest must not depend on the bare global alone.
 */

import { safeDebug } from "./logger";

/**
 * `crypto.subtle` from the bundle scope, else from the main window (a chrome
 * window always carries it). Returns undefined when neither offers it.
 */
function resolveSubtle(): any {
  const g = globalThis as any;
  if (g.crypto?.subtle?.digest) return g.crypto.subtle;
  try {
    const win = g.Zotero?.getMainWindow?.();
    if (win?.crypto?.subtle?.digest) return win.crypto.subtle;
  } catch {
    /* no Zotero (node tests) — fall through */
  }
  return undefined;
}

/** `TextEncoder` from the bundle scope, else from the main window. */
function resolveTextEncoder(): any {
  const g = globalThis as any;
  if (typeof g.TextEncoder === "function") return g.TextEncoder;
  try {
    const win = g.Zotero?.getMainWindow?.();
    if (win && typeof win.TextEncoder === "function") return win.TextEncoder;
  } catch {
    /* no Zotero (node tests) — fall through */
  }
  return undefined;
}

/**
 * Lowercase hex SHA-256 of `data`, or null when WebCrypto is unavailable
 * (callers treat null as "cannot verify" and degrade to accept-with-log).
 */
export async function sha256Hex(data: Uint8Array): Promise<string | null> {
  try {
    const subtle = (globalThis as any).crypto?.subtle;
    if (!subtle?.digest) return null;
    const digest = new Uint8Array(await subtle.digest("SHA-256", data));
    let hex = "";
    for (let i = 0; i < digest.length; i++) {
      hex += digest[i].toString(16).padStart(2, "0");
    }
    return hex;
  } catch (e) {
    safeDebug("[Z-Transplit] hash: " + e);
    return null;
  }
}

/**
 * Lowercase hex SHA-256 of a UTF-8 string, or null when neither the bundle
 * scope nor the main window offers WebCrypto/TextEncoder.
 *
 * Unlike sha256Hex() this one has a caller that MUST NOT proceed without a
 * digest: the Youdao signature. Returning null (rather than a wrong value)
 * lets that caller fail with an actionable error instead of sending a request
 * the server will reject with an opaque signature failure.
 */
export async function sha256HexOfString(input: string): Promise<string | null> {
  try {
    const subtle = resolveSubtle();
    const Encoder = resolveTextEncoder();
    if (!subtle || !Encoder) return null;
    const digest = new Uint8Array(
      await subtle.digest("SHA-256", new Encoder().encode(input)),
    );
    let hex = "";
    for (let i = 0; i < digest.length; i++) {
      hex += digest[i].toString(16).padStart(2, "0");
    }
    return hex;
  } catch (e) {
    safeDebug("[Z-Transplit] hash (string): " + e);
    return null;
  }
}
