import { chartZoomLabel, minimumChartViewportSpan, VIEWPORT_EPSILON, type ChartViewport, type ChartViewportAction } from "@/lib/chart-viewport";

export default function ChartZoomControls({ viewport, points, visiblePoints, onAction }: {
  viewport: ChartViewport;
  points: readonly { timestamp: number }[];
  visiblePoints: readonly { timestamp: number }[];
  onAction: (action: ChartViewportAction) => void;
}) {
  const span = viewport.end - viewport.start;
  const zoomed = span < 1 - VIEWPORT_EPSILON;
  const minimumSpan = minimumChartViewportSpan(points.length);
  return (
    <div className="chart-zoom-control" role="group" aria-label="Chart zoom controls">
      <span className="chart-zoom-level" aria-live="polite">{chartZoomLabel(points, visiblePoints)}</span>
      <div className="chart-zoom-buttons">
        {zoomed && <button type="button" aria-label="Show earlier chart points" disabled={viewport.start <= VIEWPORT_EPSILON} onClick={() => onAction("earlier")}>←</button>}
        <button type="button" aria-label="Zoom out" disabled={!zoomed} onClick={() => onAction("out")}>−</button>
        <button type="button" className="chart-zoom-reset" aria-label="Reset chart zoom" disabled={!zoomed} onClick={() => onAction("reset")}>Reset</button>
        <button type="button" aria-label="Zoom in" disabled={points.length < 4 || span <= minimumSpan + VIEWPORT_EPSILON} onClick={() => onAction("in")}>+</button>
        {zoomed && <button type="button" aria-label="Show later chart points" disabled={viewport.end >= 1 - VIEWPORT_EPSILON} onClick={() => onAction("later")}>→</button>}
      </div>
    </div>
  );
}
