/**
 * What jsdom lacks and the Studio's components use: Radix wants pointer capture
 * and `scrollIntoView`, the sidebar and the theme `matchMedia`, the layout
 * primitives `ResizeObserver`. And unmount after every test, which Testing
 * Library cannot do by itself without vitest globals.
 */
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// `findBy*` and `waitFor` give up after one second by default. Under the full
// suite's load a page's first render takes longer than that on this machine,
// and the graph test failed for it on most full runs; ten seconds is still far
// inside the project's test timeout and costs nothing when the render is quick.
configure({ asyncUtilTimeout: 10_000 });

if (typeof window !== "undefined") {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;

  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
}
