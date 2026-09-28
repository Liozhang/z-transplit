/**
 * Vitest configuration.
 *
 * Tests live under tests/ split by RUNTIME (first directory level = runner
 * boundary — a whole subtree belongs to exactly one runner):
 *
 *   tests/unit/  → vitest unit tests (pure Node)                        ✅
 *   tests/node/  → vitest Node-only specs (node:fs, real fixtures)      ✅
 *   tests/zotero/ → mocha specs run INSIDE Zotero via `zotero-plugin test`
 *                   (use `window.expect`, `Zotero.Item`, `Components.*`).
 *                   Importing these under Node throws → must be excluded. ❌
 *
 * Without this config, vitest's default glob grabs every `*.spec.*` in the
 * repo (including tests/zotero/ and vendored .scaffold/ files), producing
 * spurious failures that mask the real suite.
 *
 * @see https://vitest.dev/config/
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure unit tests; no DOM needed — the specs stub the bits of Zotero they
    // use themselves (there is no shared setup file in this skeleton).
    environment: "node",
    include: [
      "tests/unit/**/*.test.ts",
      "tests/node/**/*.spec.ts",
    ],
    exclude: [
      "node_modules/**",
      // mocha + Zotero runner specs — NOT vitest.
      "tests/zotero/**",
      ".scaffold/**",
      "addon/**",
      "build/**",
    ],
    // Fail fast on unhandled rejections instead of letting them produce
    // flaky "false positive" warnings.
    dangerouslyIgnoreUnhandledErrors: false,
    // tests/node may carry real-PDF integration specs; a higher ceiling only
    // bounds failures — it never slows passing tests.
    testTimeout: 120_000,
  },
});
