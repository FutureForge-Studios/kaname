import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/* ------------------------------------------------------------------ *
 * jsdom has no layout engine, so the three browser APIs the kit reads
 * geometry from are missing or inert. Rather than stub them into
 * silence, the ResizeObserver here reports the one size a component
 * actually declares — its inline style — and stays quiet for elements
 * that declare nothing.
 *
 * That distinction is load-bearing: LogViewer's character-width probe
 * and useFloating's anchors are unsized on purpose and must keep their
 * defaults, while LogViewer's scroll region carries `style={{ height }}`
 * and needs that height to window anything at all.
 * ------------------------------------------------------------------ */

function inlineBox(target: Element): DOMRectReadOnly | null {
  const style = (target as HTMLElement).style;
  const width = Number.parseFloat(style?.width ?? "");
  const height = Number.parseFloat(style?.height ?? "");
  if (!Number.isFinite(width) && !Number.isFinite(height)) return null;
  const box = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: Number.isFinite(width) ? width : 0,
    bottom: Number.isFinite(height) ? height : 0,
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  };
  return { ...box, toJSON: () => box } as DOMRectReadOnly;
}

class InlineSizeResizeObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    const contentRect = inlineBox(target);
    if (!contentRect) return;
    this.callback(
      [{ target, contentRect } as unknown as ResizeObserverEntry],
      this as ResizeObserver,
    );
  }

  unobserve(): void {}

  disconnect(): void {}
}

globalThis.ResizeObserver = InlineSizeResizeObserver;

// Not implemented in jsdom at all; Combobox calls it on the active row.
Element.prototype.scrollIntoView = function scrollIntoView(): void {};

// vitest runs without globals, so RTL cannot register its own hook.
afterEach(cleanup);
