export type MarketChartAppearance = "light" | "dark";

export function marketChartThemeFor(appearance: MarketChartAppearance) {
  return { baseTheme: appearance === "light" ? "ag-default" : "ag-default-dark" } as const;
}

export function marketChartColorsFor(appearance: MarketChartAppearance) {
  return appearance === "light"
    ? {
        axisText: "#66758B",
        axisLine: "#B8C5D5",
        gridLine: "rgba(16, 44, 77, 0.12)",
        guideLine: "rgba(16, 44, 77, 0.24)",
        sma: "#B77905",
        ema: "#6541C1",
        rsi: "#7650C8",
      } as const
    : {
        axisText: "#AAB5C1",
        axisLine: "#59636F",
        gridLine: "rgba(255, 255, 255, 0.12)",
        guideLine: "rgba(255, 255, 255, 0.2)",
        sma: "#F2C461",
        ema: "#BCA7FF",
        rsi: "#91A6FF",
      } as const;
}

export const marketChartColors = marketChartColorsFor("dark");
