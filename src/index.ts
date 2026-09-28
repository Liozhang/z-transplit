import Addon from "./addon";
import { config } from "../package.json";

// Unconditional assignment: a guard like `if (!Zotero[config.addonInstance])`
// silently skips the assignment when a previous shutdown left the pointer in
// place (upgrade / hot-reload races), leaving `_globalThis.addon` undefined and
// every later hook throwing on the first property access. Re-entrancy is
// handled by the latch in src/hooks.ts#onStartup, so re-creating the instance
// here is safe: the constructor is pure data.
_globalThis.addon = new Addon();

(Zotero as any)[config.addonInstance] = _globalThis.addon;
