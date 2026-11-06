export type PlotBounds = { left: number; top: number; width: number; height: number };
export type WheelDirection = "in" | "out";
export const WHEEL_ZOOM_FACTOR = 1.25;
export const WHEEL_ZOOM_PIXELS = 48;

/** AG14.2 sizes this rendered element from its series layout. No guessed axis gutters. */
export function agChartPlotBounds(root: ParentNode | null): PlotBounds | null {
  const plot = root?.querySelector<HTMLElement>(".ag-charts-series-area");
  return plot?.getBoundingClientRect() ?? null;
}

export function normalizedWheelPixels(deltaY: number, deltaMode: number, plotHeight: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, plotHeight) : 1);
  return Math.max(-WHEEL_ZOOM_PIXELS * 4, Math.min(WHEEL_ZOOM_PIXELS * 4, pixels));
}

/** Native non-passive binding; unknown bounds and hard limits always leave scrolling alone. */
export function bindPlotWheelZoom(element: HTMLElement | SVGElement, { getBounds, canZoom, onZoom }: {
  getBounds: () => PlotBounds | null;
  canZoom: (direction: WheelDirection, ratio: number) => boolean;
  onZoom: (direction: WheelDirection, steps: number, ratio: number) => boolean;
}): () => void {
  let accumulated = 0;
  let lastTime = -Infinity;
  const ignoredTargets = "button,input,select,textarea,a,summary,details,[role='button'],[contenteditable='true'],[data-chart-wheel-ignore],.ag-charts-tooltip,.ag-charts-menu";
  const listener = (raw: Event) => {
    const event = raw as WheelEvent;
    const target = event.target as Element | null;
    if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || (typeof target?.closest === "function" && target.closest(ignoredTargets))) { accumulated = 0; return; }
    const bounds = getBounds();
    if (!bounds || ![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || event.clientX < bounds.left || event.clientX > bounds.left + bounds.width || event.clientY < bounds.top || event.clientY > bounds.top + bounds.height) { accumulated = 0; return; }
    const delta = normalizedWheelPixels(event.deltaY, event.deltaMode, bounds.height);
    if (delta === 0) return;
    const direction = delta < 0 ? "in" : "out";
    const ratio = (event.clientX - bounds.left) / bounds.width;
    if (!canZoom(direction, ratio)) { accumulated = 0; return; }
    if (event.timeStamp - lastTime > 200 || event.timeStamp < lastTime || Math.sign(accumulated) !== Math.sign(delta)) accumulated = 0;
    accumulated += delta;
    lastTime = event.timeStamp;
    const steps = Math.min(4, Math.floor(Math.abs(accumulated) / WHEEL_ZOOM_PIXELS));
    if (steps > 0) {
      if (!onZoom(direction, steps, ratio)) { accumulated = 0; return; }
      accumulated -= Math.sign(delta) * steps * WHEEL_ZOOM_PIXELS;
    }
    event.preventDefault();
  };
  element.addEventListener("wheel", listener, { passive: false, capture: true });
  return () => { accumulated = 0; element.removeEventListener("wheel", listener, true); };
}
