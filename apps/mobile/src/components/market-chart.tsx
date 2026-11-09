import { useCallback, useMemo, useState } from 'react';
import Svg, { Circle, Defs, LinearGradient, Line, Path, Stop } from 'react-native-svg';
import { PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { buildChartPath, CHART_HEIGHT, CHART_PAD_X, CHART_PAD_Y, CHART_WIDTH, nearestPlottedSampleIndex } from '@/lib/chart-path';
import { describeVisibleChart, formatChartTime } from '@/lib/chart-description';
import { DEFAULT_DISPLAY_CURRENCY, type DisplayCurrency } from '@/lib/currency';
import { buildVisibleLineIndicators, projectIndicatorSegments, type IndicatorSelection, type LineIndicator } from '@/lib/line-indicators';
import { formatCandlePrice, formatChartSampleTime, formatTimestamp, metricLabel, metricValueLabel, shouldShowUsdPeg, type ChartPoint, type MarketCandles, type MarketChart as MarketChartData, type Metric } from '@/lib/market';
import { palette } from '@/lib/palette';
import { responsiveChartHeight } from '@/lib/responsive-layout';
import { useAppearanceStyles, usePalette } from '@/lib/theme-context';

interface MarketChartProps {
  points: ChartPoint[];
  metric: Metric;
  color: string;
  currency: DisplayCurrency;
  isPaypalUsd?: boolean;
  indicatorHistory?: MarketCandles | null;
  indicators?: IndicatorSelection;
  seriesSource: MarketChartData['seriesSource'];
  /** Reset selection for a different asset, range, currency or response. */
  selectionScope: string;
}

const NO_INDICATORS: IndicatorSelection = { sma: false, ema: false, rsi: false };
const INDICATOR_LABELS: Record<LineIndicator, string> = { sma: 'SMA 20', ema: 'EMA 20', rsi: 'RSI 14' };
const decorativeSvgAccessibilityProps = Platform.OS === 'web'
  ? { 'aria-hidden': true as const }
  : { accessible: false };

export function MarketChart({ points, metric, color, currency = DEFAULT_DISPLAY_CURRENCY, isPaypalUsd = false, indicatorHistory = null, indicators = NO_INDICATORS, seriesSource, selectionScope }: MarketChartProps) {
  const styles = useAppearanceStyles(baseStyles);
  const colors = usePalette();
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [selection, setSelection] = useState<{ key: string; index: number } | null>(null);
  const chartHeight = responsiveChartHeight(layoutWidth);
  const showUsdPeg = shouldShowUsdPeg(isPaypalUsd, metric, currency);
  const ordered = useMemo(() => points.filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value)).sort((a, b) => a.timestamp - b.timestamp), [points]);
  const firstTime = ordered[0]?.timestamp;
  const lastTime = ordered[ordered.length - 1]?.timestamp;
  const active = metric === 'price' && Object.values(indicators).some(Boolean);
  const overlay = useMemo(() => active && indicatorHistory && firstTime !== undefined && lastTime !== undefined
    ? buildVisibleLineIndicators(indicatorHistory.candles, firstTime, lastTime, indicatorHistory.candleIntervalMinutes, indicators)
    : null, [active, indicatorHistory, firstTime, lastTime, indicators]);
  const overlayPrices = useMemo(() => overlay ? [...overlay.segments.sma, ...overlay.segments.ema].flatMap((segment) => segment.map((point) => point.value)) : [], [overlay]);
  const chart = useMemo(() => buildChartPath(points, showUsdPeg ? { value: 1, minDomain: 0.98, maxDomain: 1.02 } : undefined, overlayPrices), [points, showUsdPeg, overlayPrices]);
  // The plotted list is bounded to 120 points. Use its actual contents as part
  // of the identity so zooming or a changed response cannot retain a stale index.
  const selectionKey = useMemo(() => JSON.stringify([selectionScope, metric, currency, seriesSource, chart.samples.map(({ timestamp, value }) => [timestamp, value])]), [selectionScope, metric, currency, seriesSource, chart.samples]);
  // Keep the responder stable when a parent redraws the same points during a
  // gesture, even if it supplies a new array with identical values.
  const positionKey = chart.samples.map(({ x }) => x).join(',');
  const positions = useMemo(() => positionKey ? positionKey.split(',').map((x) => ({ x: Number(x) })) : [], [positionKey]);
  const stepSelection = useCallback((step: number) => setSelection((current) => {
    const index = current?.key === selectionKey ? current.index : chart.samples.length - 1;
    return { key: selectionKey, index: Math.max(0, Math.min(chart.samples.length - 1, index + step)) };
  }), [chart.samples.length, selectionKey]);
  const chooseAt = useCallback((locationX: number, measuredWidth = layoutWidth) => {
    if (!(measuredWidth > 0) || !Number.isFinite(measuredWidth) || !Number.isFinite(locationX)) return;
    const index = nearestPlottedSampleIndex(positions, locationX / measuredWidth * CHART_WIDTH);
    if (index !== null) setSelection({ key: selectionKey, index });
  }, [layoutWidth, positions, selectionKey]);
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponderCapture: (_event, gesture) => Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.25,
    onPanResponderGrant: (event) => chooseAt(event.nativeEvent.locationX),
    onPanResponderMove: (event) => chooseAt(event.nativeEvent.locationX),
    onPanResponderTerminationRequest: () => true,
  }), [chooseAt]);
  if (!chart.line || !chart.last || !chart.first || !chart.lastPoint || chart.low === null || chart.high === null) {
    return (
      <View style={styles.empty} accessibilityRole="text">
        <Text style={styles.emptyText}>Chart points are not available for this range yet.</Text>
      </View>
    );
  }

  const description = describeVisibleChart(metric, chart.low, chart.high, currency, isPaypalUsd, chart.first, chart.lastPoint);
  const selectedIndex = selection?.key === selectionKey ? Math.max(0, Math.min(chart.samples.length - 1, selection.index)) : chart.samples.length - 1;
  const selected = chart.samples[selectedIndex]!;
  const valueLabel = metricValueLabel(metric, selected.value, currency, isPaypalUsd);
  const sampleTime = formatChartSampleTime(selected, seriesSource);
  const sampleTimestamp = formatTimestamp(selected.timestamp);
  const sampleTimeLabel = sampleTime.slice(0, sampleTime.length - sampleTimestamp.length).trimEnd();
  const selectedDescription = `Plotted point ${selectedIndex + 1} of ${chart.samples.length}, ${metricLabel(metric)} ${valueLabel}. ${sampleTime}.`;
  const webAccessibility = Platform.OS === 'web' ? {
    'aria-valuemin': 1,
    'aria-valuemax': chart.samples.length,
    'aria-valuenow': selectedIndex + 1,
    'aria-valuetext': `${description} ${selectedDescription}`,
  } : {};
  const keyboardProps = Platform.OS === 'web' ? {
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        stepSelection(event.key === 'ArrowLeft' ? -1 : 1);
      }
    },
  } : {};
  const span = chart.lastPoint.timestamp - chart.first.timestamp;
  const x = (timestamp: number) => CHART_PAD_X + (timestamp - chart.first!.timestamp) / span * (CHART_WIDTH - CHART_PAD_X * 2);
  const domainLow = chart.domainLow!;
  const domainHigh = chart.domainHigh!;
  const y = (value: number) => domainHigh > domainLow
    ? CHART_PAD_Y + (domainHigh - value) / (domainHigh - domainLow) * (CHART_HEIGHT - CHART_PAD_Y * 2)
    : CHART_HEIGHT / 2;
  const rsiY = (value: number) => 8 + (100 - value) / 100 * 84;
  const projected = overlay && span > 0 && Number.isFinite(span) && Number.isFinite(domainHigh - domainLow) ? {
    sma: projectIndicatorSegments(overlay.segments.sma, x, y),
    ema: projectIndicatorSegments(overlay.segments.ema, x, y),
    rsi: projectIndicatorSegments(overlay.segments.rsi, x, rsiY),
  } : null;
  const interval = indicatorHistory?.candleIntervalMinutes === 30 ? '30-minute' : indicatorHistory?.candleIntervalMinutes === 240 ? '4-hour' : '4-day';

  return (
    <View>
      {showUsdPeg && chart.referenceY !== null && (
        <View style={styles.guideLegend} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={styles.guideSwatch} />
          <Text style={styles.guideText}>$1.00 USD peg</Text>
        </View>
      )}
      <View style={styles.plotSurface}>
      <View {...pan.panHandlers} onLayout={(event) => setLayoutWidth(event.nativeEvent.layout.width)}>
        <Pressable
          {...keyboardProps}
          {...webAccessibility}
          accessibilityRole="adjustable"
          accessibilityLabel="Line chart"
          accessibilityHint="Swipe up or down to inspect a plotted point, or use the previous and next point buttons."
          accessibilityValue={{ min: 1, max: chart.samples.length, now: selectedIndex + 1, text: `${description} ${selectedDescription}` }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'increment') stepSelection(1);
            if (event.nativeEvent.actionName === 'decrement') stepSelection(-1);
          }}
          onPress={(event) => {
            if (Platform.OS === 'web') {
              // React Native Web delivers a DOM MouseEvent for onPress rather
              // than the normalized responder event used by drag gestures.
              const mouse = event.nativeEvent as unknown as { clientX?: number; detail?: number };
              const target = event.currentTarget as unknown as { getBoundingClientRect?: () => { left: number; width: number } };
              if (mouse.detail === 0 || typeof mouse.clientX !== 'number' || !Number.isFinite(mouse.clientX) || typeof target?.getBoundingClientRect !== 'function') return;
              const rect = target.getBoundingClientRect();
              if (!Number.isFinite(rect.left)) return;
              chooseAt(mouse.clientX - rect.left, rect.width);
            } else {
              chooseAt(event.nativeEvent.locationX);
            }
          }}>
          <Svg width="100%" height={chartHeight} viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" pointerEvents="none" {...decorativeSvgAccessibilityProps}>
            <Defs>
              <LinearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={color} stopOpacity={0.2} />
                <Stop offset="1" stopColor={color} stopOpacity={0.015} />
              </LinearGradient>
            </Defs>
            {[0, 1, 2, 3].map((step) => {
              const y = CHART_PAD_Y + (step / 3) * (CHART_HEIGHT - CHART_PAD_Y * 2);
              return <Line key={step} x1={CHART_PAD_X} y1={y} x2={CHART_WIDTH - CHART_PAD_X} y2={y} stroke={colors.plotGrid} strokeWidth={1} />;
            })}
            <Path d={chart.area} fill="url(#chartFill)" />
            {chart.referenceY !== null && <Line x1={CHART_PAD_X} y1={chart.referenceY} x2={CHART_WIDTH - CHART_PAD_X} y2={chart.referenceY} stroke={colors.warning} strokeWidth={2} strokeDasharray="7 5" />}
            <Path d={chart.line} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
            {projected && (['sma', 'ema'] as const).filter((indicator) => indicators[indicator] && projected[indicator].path).map((indicator) => {
              const stroke = indicator === 'sma' ? '#FFD166' : '#C4B5FD';
              return <ViewIndicator key={indicator} path={projected[indicator].path} singletons={projected[indicator].singletons} color={stroke} />;
            })}
            <Line x1={selected.x} x2={selected.x} y1={CHART_PAD_Y} y2={CHART_HEIGHT - CHART_PAD_Y} stroke={colors.plotText} strokeWidth={1.5} strokeDasharray="4 4" />
            <Line x1={CHART_PAD_X} x2={CHART_WIDTH - CHART_PAD_X} y1={selected.y} y2={selected.y} stroke={colors.plotText} strokeWidth={1} strokeDasharray="4 5" />
            <Circle cx={selected.x} cy={selected.y} r={7} fill={colors.surface} stroke={color} strokeWidth={4} />
          </Svg>
        </Pressable>
      </View>
      </View>
      <View style={styles.selectionRow}>
        <View style={styles.selectionText}>
          <Text style={styles.selectionLabel}>Plotted point {selectedIndex + 1} / {chart.samples.length} · {metricLabel(metric)} {valueLabel}</Text>
          <Text style={styles.selectionTime}>{sampleTimeLabel}</Text>
          <Text style={styles.selectionTime}>{sampleTimestamp.replace(/ UTC$/, '\u00a0UTC')}</Text>
        </View>
        <View style={styles.selectionActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Select previous chart point" accessibilityState={{ disabled: selectedIndex === 0 }} disabled={selectedIndex === 0} onPress={() => stepSelection(-1)} style={[styles.selectionButton, selectedIndex === 0 && styles.selectionButtonDisabled]}><Text style={styles.selectionButtonText}>‹</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Select next chart point" accessibilityState={{ disabled: selectedIndex === chart.samples.length - 1 }} disabled={selectedIndex === chart.samples.length - 1} onPress={() => stepSelection(1)} style={[styles.selectionButton, selectedIndex === chart.samples.length - 1 && styles.selectionButtonDisabled]}><Text style={styles.selectionButtonText}>›</Text></Pressable>
        </View>
      </View>
      <Text style={styles.selectionHint}>Tap or drag to inspect samples.{ordered.length > chart.samples.length ? ` ${chart.samples.length} of ${ordered.length} shown · zoom to see more.` : ''}</Text>
      <View style={styles.rangeLabels}>
        <Text style={styles.axisLabel}>Low {metricValueLabel(metric, chart.low, currency, isPaypalUsd)}</Text>
        <Text style={[styles.axisLabel, styles.alignRight]}>High {metricValueLabel(metric, chart.high, currency, isPaypalUsd)}</Text>
      </View>
      <View style={styles.timeLabels}>
        <View style={styles.endpoint}>
          <Text style={styles.timeLabel}>{formatChartTime(chart.first.timestamp)}</Text>
          <Text style={styles.endpointValue}>Start {metricValueLabel(metric, chart.first.value, currency, isPaypalUsd)}</Text>
        </View>
        <View style={styles.endpoint}>
          <Text style={[styles.timeLabel, styles.alignRight]}>{formatChartTime(chart.lastPoint.timestamp)}</Text>
          <Text style={[styles.endpointValue, styles.alignRight]}>End {metricValueLabel(metric, chart.lastPoint.value, currency, isPaypalUsd)}</Text>
        </View>
      </View>
      {active && indicatorHistory && <View style={styles.indicatorDetails}>
        <Text style={styles.indicatorSource}>Indicators: CoinGecko OHLC · {interval} candle closes · retrieved {formatTimestamp(indicatorHistory.retrievedAt)}. Gaps break indicator lines.</Text>
        {overlay?.visibleCandles ? (['sma', 'ema', 'rsi'] as const).filter((indicator) => indicators[indicator]).map((indicator) => {
          const value = overlay.segments[indicator].at(-1)?.at(-1)?.value;
          return <Text key={indicator} style={styles.indicatorValue}>{INDICATOR_LABELS[indicator]} · {value === undefined ? (indicator === 'rsi' ? 'Warming up · needs 15 closes (14 changes)' : 'Warming up · needs 20 closes') : indicator === 'rsi' ? value.toFixed(2) : formatCandlePrice(value, currency, isPaypalUsd)}</Text>;
        }) : <Text style={styles.indicatorValue}>{indicatorHistory.candles.length ? 'No candle closes fall within this visible line range.' : 'No candle history is available for indicators.'}</Text>}
        {indicators.rsi && projected && overlay?.segments.rsi.length ? <View style={styles.rsiPanel}>
          <Text style={styles.indicatorValue}>RSI 14 · 0–100</Text>
          <Svg width="100%" height={Math.max(72, Math.round(chartHeight * 0.38))} viewBox={`0 0 ${CHART_WIDTH} 100`} preserveAspectRatio="none" {...decorativeSvgAccessibilityProps}>
            {[30, 70].map((level) => <Line key={level} x1={CHART_PAD_X} x2={CHART_WIDTH - CHART_PAD_X} y1={rsiY(level)} y2={rsiY(level)} stroke={colors.plotGrid} strokeWidth={1} strokeDasharray="4 5" />)}
            <ViewIndicator path={projected.rsi.path} singletons={projected.rsi.singletons} color={colors.rsi} />
          </Svg>
        </View> : null}
      </View>}
    </View>
  );
}

function ViewIndicator({ path, singletons, color }: { path: string; singletons: { x: number; y: number }[]; color: string }) {
  return <><Path d={path} fill="none" stroke={color} strokeWidth={3} />{singletons.map((point, index) => <Circle key={index} cx={point.x} cy={point.y} r={3} fill={color} />)}</>;
}

const baseStyles = StyleSheet.create({
  empty: { height: 190, alignItems: 'center' as const, justifyContent: 'center' as const, paddingHorizontal: 20 },
  emptyText: { color: palette.muted, fontSize: 13, textAlign: 'center' as const },
  plotSurface: { backgroundColor: palette.canvas, borderRadius: 16, paddingVertical: 7, overflow: 'hidden' },
  guideLegend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  guideSwatch: { width: 20, borderBottomWidth: 1.5, borderColor: '#795716', borderStyle: 'dashed' as const },
  guideText: { color: '#6D521D', fontSize: 10, lineHeight: 15, fontWeight: '700' as const },
  selectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 },
  selectionText: { flex: 1, minWidth: 0, gap: 2 },
  selectionLabel: { color: palette.ink, fontSize: 12, lineHeight: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  selectionTime: { color: palette.muted, fontSize: 10, lineHeight: 15, fontVariant: ['tabular-nums'] },
  selectionActions: { flexDirection: 'row', gap: 5 },
  selectionButton: { minWidth: 44, minHeight: 44, paddingHorizontal: 9, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#D5E0EC', borderRadius: 12, backgroundColor: '#FFFFFF' },
  selectionButtonDisabled: { opacity: 0.4 },
  selectionButtonText: { color: '#315579', fontSize: 20, fontWeight: '700' },
  selectionHint: { color: '#526B83', fontSize: 10, lineHeight: 15, marginTop: 5 },
  rangeLabels: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, gap: 8, marginTop: 6 },
  axisLabel: { flex: 1, color: palette.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  timeLabels: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, gap: 8, marginTop: 4 },
  endpoint: { flex: 1, minWidth: 0 },
  timeLabel: { color: palette.muted, fontSize: 10, lineHeight: 15, fontVariant: ['tabular-nums'] },
  endpointValue: { color: palette.ink, fontSize: 10, lineHeight: 15, fontWeight: '600' as const, fontVariant: ['tabular-nums'] },
  alignRight: { textAlign: 'right' as const },
  indicatorDetails: { marginTop: 10, gap: 4 },
  indicatorSource: { color: '#657C92', fontSize: 10, lineHeight: 15 },
  indicatorValue: { color: '#315579', fontSize: 11, lineHeight: 16, fontWeight: '600' as const, fontVariant: ['tabular-nums'] },
  rsiPanel: { marginTop: 6 },
});
