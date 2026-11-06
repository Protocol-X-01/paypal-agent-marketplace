"use client";

import { useEffect, type RefObject } from "react";
import { bindPlotWheelZoom, WHEEL_ZOOM_FACTOR, type PlotBounds } from "@/lib/chart-wheel";

/** Each binding keeps its current view between high-frequency events until React commits. */
export function usePlotWheelZoom<T>({ elementRef, view, getBounds, project, onChange }: {
  elementRef: RefObject<HTMLElement | SVGElement | null>;
  view: T;
  getBounds: () => PlotBounds | null;
  project: (view: T, factor: number, ratio: number) => T;
  onChange: (next: T, previous: T, ratio: number) => void;
}) {
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let current = view;
    const factorFor = (direction: "in" | "out") => direction === "in" ? 1 / WHEEL_ZOOM_FACTOR : WHEEL_ZOOM_FACTOR;
    return bindPlotWheelZoom(element, {
      getBounds,
      canZoom: (direction, ratio) => project(current, factorFor(direction), ratio) !== current,
      onZoom: (direction, steps, ratio) => {
        const previous = current;
        for (let step = 0; step < steps; step++) current = project(current, factorFor(direction), ratio);
        if (current === previous) return false;
        onChange(current, previous, ratio);
        return true;
      },
    });
  }, [elementRef, getBounds, onChange, project, view]);
}
