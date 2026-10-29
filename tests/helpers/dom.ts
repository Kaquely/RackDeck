import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * A DOM for renderer tests.
 *
 * The chart geometry and formatting are pure and tested directly, but the renderers write into
 * real elements. Without a DOM they would only ever be type-checked, which is not evidence
 * that a single SVG path is actually produced. `happy-dom` is used rather than a hand-rolled
 * stub so the assertions run against genuine element behaviour.
 *
 * Registration is global and idempotent, so importing this module from several test files is
 * safe.
 */
let registered = false;

export function registerDom(): void {
  if (registered) return;
  GlobalRegistrator.register({ url: "http://localhost/" });
  registered = true;
}
