import { useCallback, useMemo, useState } from 'react';
import { PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path, Rect } from 'react-native-svg';

import { calculateEma, calculateRsi, calculateSma, candleIndexAtRatio, type Candle } from '@/lib/candle-series';
import { changeCandleViewport, initialCandleViewport, revealCandle, type CandleViewportAction } from '@/lib/candle-viewport';
import type { DisplayCurrency } from '@/lib/currency';
import { formatCandlePrice, formatIntradayPrice, formatTimestamp } from '@/lib/market';
import { responsiveChartHeight } from '@/lib/responsive-layout';
import { useAppearanceStyles, usePalette } from '@/lib/theme-context';

export type CandleIndicator = 'sma' | 'ema' | 'rsi';
export type CandleIndicators = Record<CandleIndicator, boolean>;
const WIDTH = 640;
const HEIGHT = 230;
const PAD_X = 16;
const PAD_Y = 16;
const RSI_HEIGHT = 90;
const decorativeSvgAccessibilityProps = Platform.OS === 'web'
  ? { 'aria-hidden': true as const }
  : { accessible: false };
const indicatorLabels: Record<CandleIndicator, string> = { sma: 'SMA 20', ema: 'EMA 20', rsi: 'RSI 14' };
const indicatorRequirements: Record<CandleIndicator, { minimum: number; detail: string }> = {
  sma: { minimum: 20, detail: '20 closes' },
  ema: { minimum: 20, detail: '20 closes' },
  rsi: { minimum: 15, detail: '15 closes (14 changes)' },
};

interface CandleChartProps {
  candles: Candle[];
  currency: DisplayCurrency;
  quote?: 'USDT';
  intervalMinutes: number;
  isPaypalUsd?: boolean;
  indicators: CandleIndicators;
  onIndicatorChange: (indicator: CandleIndicator) => void;
}

interface IndicatorControlsProps {
  indicators: CandleIndicators;
  onIndicatorChange: (indicator: CandleIndicator) => void;
  candleCount: number | null;
  open: boolean;
  onToggleOpen: () => void;
}

/** Shared by line and candle views; unknown history stays selectable so it can be requested. */
export function CandleIndicatorControls({ indicators, onIndicatorChange, candleCount, open, onToggleOpen }: IndicatorControlsProps) {
  const styles = useAppearanceStyles(baseStyles);
  const activeCount = Object.values(indicators).filter(Boolean).length;
  return <View style={styles.indicatorWrap}>
    <Pressable accessibilityRole="button" accessibilityLabel="Indicators" accessibilityState={{ expanded: open }} onPress={onToggleOpen} style={({ pressed }) => [styles.indicatorTrigger, pressed && styles.pressed]}>
      <Text style={styles.indicatorTriggerText}>Indicators{activeCount ? ` · ${activeCount} on` : ''} {open ? '⌃' : '⌄'}</Text>
    </Pressable>
    {open && <View style={styles.indicatorOptions}>
      {(['sma', 'ema', 'rsi'] as const).map((indicator) => {
        const requirement = indicatorRequirements[indicator];
        const insufficient = candleCount !== null && candleCount < requirement.minimum;
        const disabled = insufficient && !indicators[indicator];
        return <Pressable
          key={indicator}
          accessibilityRole="checkbox"
          accessibilityLabel={`${indicatorLabels[indicator]}, requires ${requirement.detail}`}
          accessibilityHint={insufficient ? (disabled ? 'Not enough candle history to enable.' : 'Not enough candle history; you can switch this indicator off.') : undefined}
          accessibilityState={{ checked: indicators[indicator], disabled }}
          disabled={disabled}
          onPress={() => onIndicatorChange(indicator)}
          style={({ pressed }) => [styles.indicatorOption, indicators[indicator] && styles.indicatorSelected, disabled && styles.disabled, pressed && styles.pressed]}>
          <Text style={[styles.indicatorOptionText, indicators[indicator] && styles.indicatorSelectedText]}>{indicatorLabels[indicator]}</Text>
          <Text style={styles.indicatorRequirement}>Needs {requirement.detail}</Text>
        </Pressable>;
      })}
    </View>}
  </View>;
}

function intervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}-minute`;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  return `${minutes / 60}-hour`;
}

function linePath(values: readonly (number | null)[], candles: readonly Candle[], start: number, end: number, intervalMs: number, x: (index: number) => number, y: (value: number) => number): string {
  let previous: number | null = null;
  let drawing = false;
  const commands: string[] = [];
  for (let index = start; index < end; index += 1) {
    const candle = candles[index];
    const value = values[index];
    if (!candle || value === null || value === undefined || !Number.isFinite(value)) {
      previous = null;
      drawing = false;
      continue;
    }
    if (previous !== null && candle.timestamp - previous > intervalMs * 1.5) drawing = false;
    commands.push(`${drawing ? 'L' : 'M'} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`);
    previous = candle.timestamp;
    drawing = true;
  }
  return commands.join(' ');
}

export function CandleChart({ candles, currency, quote, intervalMinutes, isPaypalUsd = false, indicators, onIndicatorChange }: CandleChartProps) {
  const styles = useAppearanceStyles(baseStyles);
  const colors = usePalette();
  const [selection, setSelection] = useState(() => ({ viewport: initialCandleViewport(candles.length), selectedIndex: candles.length - 1 }));
  const { viewport, selectedIndex } = selection;
  const [layoutWidth, setLayoutWidth] = useState(0);
  const chartHeight = responsiveChartHeight(layoutWidth);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const selected = candles[selectedIndex]!;
  const visible = candles.slice(viewport.start, viewport.end);
  const count = visible.length;
  const intervalMs = intervalMinutes * 60_000;
  const plots = useMemo(() => {
    const closes = candles.map((candle) => candle.close);
    return { sma: calculateSma(closes), ema: calculateEma(closes), rsi: calculateRsi(closes) };
  }, [candles]);
  const activeCount = Object.values(indicators).filter(Boolean).length;
  const visibleLow = Math.min(...visible.map((candle) => candle.low));
  const visibleHigh = Math.max(...visible.map((candle) => candle.high));
  const visiblePrices = visible.flatMap((candle) => [candle.low, candle.high]);
  const showUsdPeg = quote !== 'USDT' && isPaypalUsd && currency === 'USD';
  if (showUsdPeg) visiblePrices.push(0.98, 1.02);
  for (const indicator of ['sma', 'ema'] as const) {
    if (indicators[indicator]) {
      for (const value of plots[indicator].slice(viewport.start, viewport.end)) {
        if (value !== null && Number.isFinite(value)) visiblePrices.push(value);
      }
    }
  }
  const minimum = Math.min(...visiblePrices);
  const maximum = Math.max(...visiblePrices);
  const scale = Math.max(maximum, Number.MIN_VALUE);
  const normalizedSpan = maximum / scale - minimum / scale;
  const plotWidth = WIDTH - PAD_X * 2;
  const slot = plotWidth / count;
  const x = (index: number) => PAD_X + (index - viewport.start + 0.5) * slot;
  const priceY = (price: number) => normalizedSpan > 0
    ? PAD_Y + (maximum / scale - price / scale) / normalizedSpan * (HEIGHT - PAD_Y * 2)
    : HEIGHT / 2;
  const rsiY = (value: number) => 8 + (100 - value) / 100 * (RSI_HEIGHT - 16);
  const gaps = visible.map((candle, index) => index > 0 && candle.timestamp - visible[index - 1]!.timestamp > intervalMs * 1.5 ? viewport.start + index : -1).filter((index) => index >= 0);

  const chooseAt = useCallback((locationX: number, measuredWidth = layoutWidth) => {
    if (!(measuredWidth > 0) || !Number.isFinite(measuredWidth) || !Number.isFinite(locationX)) return;
    const ratio = ((locationX / measuredWidth) * WIDTH - PAD_X) / (WIDTH - PAD_X * 2);
    const index = candleIndexAtRatio(ratio, viewport.start, viewport.end);
    if (index !== null) setSelection((current) => ({ ...current, selectedIndex: index }));
  }, [layoutWidth, viewport.start, viewport.end]);

  const stepSelection = useCallback((step: number) => {
    setSelection((current) => {
      const next = Math.max(0, Math.min(candles.length - 1, current.selectedIndex + step));
      return { selectedIndex: next, viewport: revealCandle(current.viewport, candles.length, next) };
    });
  }, [candles.length]);

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponderCapture: (_event, gesture) => Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.25,
    onPanResponderGrant: (event) => chooseAt(event.nativeEvent.locationX),
    onPanResponderMove: (event) => chooseAt(event.nativeEvent.locationX),
    onPanResponderTerminationRequest: () => true,
  }), [chooseAt]);

  const keyboardProps = Platform.OS === 'web' ? {
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        stepSelection(event.key === 'ArrowLeft' ? -1 : 1);
      }
    },
  } : {};

  function changeView(action: CandleViewportAction) {
    setSelection((current) => {
      const next = changeCandleViewport(current.viewport, candles.length, action);
      return { viewport: next, selectedIndex: Math.max(next.start, Math.min(next.end - 1, current.selectedIndex)) };
    });
  }

  const original = initialCandleViewport(candles.length);
  const maxWidth = original.end - original.start;
  const priceLabel = (value: number) => quote === 'USDT' ? formatIntradayPrice(value) : formatCandlePrice(value, currency, isPaypalUsd);
  const selectedDescription = `Candle ${selectedIndex + 1} of ${candles.length}, closes ${formatTimestamp(selected.timestamp)}, open ${priceLabel(selected.open)}, high ${priceLabel(selected.high)}, low ${priceLabel(selected.low)}, close ${priceLabel(selected.close)}.`;

  return (
    <View>
      <View style={styles.toolbar}>
        <Text style={styles.smallLabel}>{count} of {candles.length} candles · {intervalLabel(intervalMinutes)}</Text>
        <View style={styles.actions}>
          {([
            ['earlier', 'Earlier candles', '←', viewport.start === 0],
            ['out', 'Zoom out candles', '−', count >= maxWidth],
            ['reset', 'Reset candle view', 'Reset', viewport.start === original.start && viewport.end === original.end],
            ['in', 'Zoom in candles', '+', count <= Math.min(4, candles.length)],
            ['later', 'Later candles', '→', viewport.end >= candles.length],
          ] as const).map(([action, label, symbol, disabled]) => (
            <Pressable key={action} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={() => changeView(action)} style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && styles.pressed]}>
              <Text style={styles.actionText}>{symbol}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <CandleIndicatorControls indicators={indicators} onIndicatorChange={onIndicatorChange} candleCount={candles.length} open={indicatorsOpen} onToggleOpen={() => setIndicatorsOpen((open) => !open)} />

      {showUsdPeg && <Text style={styles.pegLegend}>Dashed guide · $1.00 USD peg</Text>}

      <View {...pan.panHandlers} onLayout={(event) => setLayoutWidth(event.nativeEvent.layout.width)}>
        <Pressable
          {...keyboardProps}
          accessibilityRole="adjustable"
          accessibilityLabel="Candlestick chart"
          accessibilityHint="Swipe up or down to select a candle, or use the previous and next candle buttons."
          accessibilityValue={{ min: 1, max: candles.length, now: selectedIndex + 1, text: selectedDescription }}
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
          <Svg width="100%" height={chartHeight} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" pointerEvents="none" {...decorativeSvgAccessibilityProps}>
            {[0, 1, 2, 3].map((step) => <Line key={step} x1={PAD_X} y1={PAD_Y + step / 3 * (HEIGHT - PAD_Y * 2)} x2={WIDTH - PAD_X} y2={PAD_Y + step / 3 * (HEIGHT - PAD_Y * 2)} stroke={colors.plotGrid} strokeWidth={1} />)}
            {showUsdPeg && <Line x1={PAD_X} x2={WIDTH - PAD_X} y1={priceY(1)} y2={priceY(1)} stroke={colors.warning} strokeWidth={2} strokeDasharray="7 5" />}
            {gaps.map((index) => <Line key={`gap-${index}`} x1={x(index) - slot / 2} x2={x(index) - slot / 2} y1={PAD_Y} y2={HEIGHT - PAD_Y} stroke={colors.chartGuide} strokeWidth={1.5} strokeDasharray="3 4" />)}
            {visible.map((candle, offset) => {
              const index = viewport.start + offset;
              const rising = candle.close >= candle.open;
              const top = Math.min(priceY(candle.open), priceY(candle.close));
              const bottom = Math.max(priceY(candle.open), priceY(candle.close));
              const bodyWidth = Math.max(0.6, Math.min(12, slot * 0.65));
              const color = rising ? colors.blue : colors.negative;
              return <ViewCandle key={candle.timestamp} x={x(index)} high={priceY(candle.high)} low={priceY(candle.low)} top={top} height={Math.max(2, bottom - top)} width={bodyWidth} color={color} />;
            })}
            {indicators.sma && <Path d={linePath(plots.sma, candles, viewport.start, viewport.end, intervalMs, x, priceY)} fill="none" stroke={colors.sma} strokeWidth={3} />}
            {indicators.ema && <Path d={linePath(plots.ema, candles, viewport.start, viewport.end, intervalMs, x, priceY)} fill="none" stroke={colors.ema} strokeWidth={3} />}
            <Line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={PAD_Y} y2={HEIGHT - PAD_Y} stroke={colors.plotText} strokeWidth={1.5} strokeDasharray="4 4" />
            <Line x1={PAD_X} x2={WIDTH - PAD_X} y1={priceY(selected.close)} y2={priceY(selected.close)} stroke={colors.plotText} strokeWidth={1} strokeDasharray="4 5" />
          </Svg>
        </Pressable>
      </View>

      <View style={styles.rangeLabels}>
        <Text style={styles.rangeLabel}>Low {priceLabel(visibleLow)}</Text>
        <Text style={[styles.rangeLabel, styles.rangeLabelRight]}>High {priceLabel(visibleHigh)}</Text>
      </View>
      <View style={styles.selectedHeading}>
        <View style={styles.selectionText}>
          <Text style={styles.selectionLabel}>Candle {selectedIndex + 1} / {candles.length}</Text>
          <Text style={styles.selectionTime}>Close · {formatTimestamp(selected.timestamp)}</Text>
        </View>
        <View style={styles.selectionActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Select previous candle" accessibilityState={{ disabled: selectedIndex === 0 }} disabled={selectedIndex === 0} onPress={() => stepSelection(-1)} style={[styles.action, selectedIndex === 0 && styles.disabled]}><Text style={styles.actionText}>‹</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Select next candle" accessibilityState={{ disabled: selectedIndex === candles.length - 1 }} disabled={selectedIndex === candles.length - 1} onPress={() => stepSelection(1)} style={[styles.action, selectedIndex === candles.length - 1 && styles.disabled]}><Text style={styles.actionText}>›</Text></Pressable>
        </View>
      </View>
      <View style={styles.ohlc} accessibilityLabel={selectedDescription}>
        {([['Open', selected.open], ['High', selected.high], ['Low', selected.low], ['Close', selected.close]] as const).map(([label, value]) => <View key={label} style={styles.ohlcCell}><Text style={styles.ohlcLabel}>{label}</Text><Text style={styles.ohlcValue}>{priceLabel(value)}</Text></View>)}
      </View>
      {activeCount > 0 && <View style={styles.indicatorReadings}>
        {(['sma', 'ema', 'rsi'] as const).filter((indicator) => indicators[indicator]).map((indicator) => {
          const value = plots[indicator][selectedIndex];
          return <Text key={indicator} style={styles.indicatorReading}>{indicatorLabels[indicator]} · {value === null || value === undefined ? `Warming up · needs ${indicatorRequirements[indicator].detail}` : indicator === 'rsi' ? value.toFixed(2) : priceLabel(value)}</Text>;
        })}
      </View>}
      {indicators.rsi && <View style={styles.rsiChart}>
        <Text style={styles.smallLabel}>RSI 14 · 0–100</Text>
        <Svg width="100%" height={Math.max(74, Math.round(chartHeight * 0.39))} viewBox={`0 0 ${WIDTH} ${RSI_HEIGHT}`} preserveAspectRatio="none" {...decorativeSvgAccessibilityProps}>
          {[30, 70].map((level) => <Line key={level} x1={PAD_X} x2={WIDTH - PAD_X} y1={rsiY(level)} y2={rsiY(level)} stroke={colors.plotGrid} strokeWidth={1} strokeDasharray="4 5" />)}
          <Path d={linePath(plots.rsi, candles, viewport.start, viewport.end, intervalMs, x, rsiY)} fill="none" stroke={colors.rsi} strokeWidth={3} />
          <Line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={8} y2={RSI_HEIGHT - 8} stroke={colors.plotText} strokeWidth={1} strokeDasharray="4 4" />
        </Svg>
      </View>}
      <Text style={styles.hint}>Tap or drag to inspect · candle close in UTC{gaps.length ? ' · dashed gaps mark missing intervals' : ''}{activeCount ? ' · indicators need warm-up' : ''}.</Text>
    </View>
  );
}

function ViewCandle({ x, high, low, top, height, width, color }: { x: number; high: number; low: number; top: number; height: number; width: number; color: string }) {
  return <><Line x1={x} x2={x} y1={high} y2={low} stroke={color} strokeWidth={1.7} /><Rect x={x - width / 2} y={top} width={width} height={height} fill={color} /></>;
}

const baseStyles = StyleSheet.create({
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
  smallLabel: { color: '#526B83', fontSize: 11, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, alignItems: 'center' },
  action: { minWidth: 44, minHeight: 44, paddingHorizontal: 9, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#D5E0EC', borderRadius: 12, backgroundColor: '#FFFFFF' },
  actionText: { color: '#315579', fontSize: 13, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  indicatorWrap: { marginBottom: 6 },
  pegLegend: { color: '#6D521D', fontSize: 10, fontWeight: '700', marginBottom: 4 },
  indicatorTrigger: { alignSelf: 'flex-start', minHeight: 40, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 12, backgroundColor: '#EFF5FC' },
  indicatorTriggerText: { color: '#154573', fontSize: 12, fontWeight: '700' },
  indicatorOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 7 },
  indicatorOption: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: '#D7E3EF', borderRadius: 11 },
  indicatorSelected: { backgroundColor: '#E7F2FF', borderColor: '#0070E0' },
  indicatorOptionText: { color: '#526B83', fontSize: 12, fontWeight: '600' },
  indicatorRequirement: { color: '#526B83', fontSize: 10, lineHeight: 14 },
  indicatorSelectedText: { color: '#004B99' },
  selectedHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 6 },
  rangeLabels: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginTop: 3 },
  rangeLabel: { flex: 1, color: '#526B83', fontSize: 10, fontVariant: ['tabular-nums'] },
  rangeLabelRight: { textAlign: 'right' },
  selectionText: { flex: 1 },
  selectionLabel: { color: '#142E4C', fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  selectionTime: { color: '#526B83', fontSize: 10, lineHeight: 15, fontVariant: ['tabular-nums'] },
  selectionActions: { flexDirection: 'row', gap: 5 },
  ohlc: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 9 },
  ohlcCell: { minWidth: '46%', flex: 1 },
  ohlcLabel: { color: '#657C92', fontSize: 10 },
  ohlcValue: { color: '#173958', fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  indicatorReadings: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4, marginTop: 10 },
  indicatorReading: { color: '#315579', fontSize: 11, fontWeight: '600', fontVariant: ['tabular-nums'] },
  rsiChart: { marginTop: 12 },
  hint: { color: '#657C92', fontSize: 10, lineHeight: 15, marginTop: 8 },
});
