import { config } from "../package.json";
import hooks from "./hooks";

/**
 * Addon singleton, published as `Zotero.ZTransplit` by src/index.ts (the name
 * comes from package.json config.addonInstance) and reachable from every module
 * through `_globalThis.addon`.
 */
class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized?: boolean;
    locale?: {
      /** Fluent Localization instance created by initLocale(). */
      current: any;
    };
  };
  public hooks: typeof hooks;
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
