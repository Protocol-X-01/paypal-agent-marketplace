import { useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CandleChart, CandleIndicatorControls, type CandleIndicator, type CandleIndicators } from '@/components/candle-chart';
import { MarketChart } from '@/components/market-chart';
import { MarketHeader } from '@/components/market-header';
import { NativeButton } from '@/components/native-button';
import { formatCurrency } from '@/lib/currency';
import { useData, useIntradayCandles, useMarketCandles, useMarketChart } from '@/lib/data-context';
import { palette } from '@/lib/palette';
import { useResponsiveLayout } from '@/lib/responsive-layout';
import {
  ASSETS,
  chartPercentageChange,
  chronologicalChartPoints,
  formatChartSampleTime,
  formatChange,
  formatProviderUpdate,
  formatRetrievalComparison,
  formatTimestamp,
  metricLabel,
  metricValueLabel,
  pointsForMetric,
  selectHeadlineMetric,
  type ChartDays,
  type CoinId,
  type IntradayDays,
  type IntradayInterval,
  type Metric,
} from '@/lib/market';
import { useAppearanceStyles, usePalette } from '@/lib/theme-context';

const CHART_RANGES: { label: string; days: ChartDays }[] = [
  { label: '1D', days: 1 },
  { label: '1W', days: 7 },
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '1Y', days: 365 },
];

const METRICS: Metric[] = ['price', 'marketCap', 'volume'];
type ChartViewport = { start: number; end: number };
const FULL_CHART_VIEWPORT: ChartViewport = { start: 0, end: 1 };
const VIEWPORT_EPSILON = 1e-9;

/** Keep at least three samples visible without imposing a fixed 4× limit. */
function minimumChartViewportSpan(pointCount: number): number {
  return pointCount < 4 ? 1 : Math.min(1, 2 / (pointCount - 1));
}

function chartViewportAction(viewport: ChartViewport, action: 'in' | 'out' | 'earlier' | 'later', pointCount: number): ChartViewport {
  const minimumSpan = minimumChartViewportSpan(pointCount);
  // A refreshed series can contain fewer samples than the one being viewed.
  const span = Math.max(minimumSpan, Math.min(1, viewport.end - viewport.start));
  const center = (viewport.start + viewport.end) / 2;
  const normalizedStart = Math.max(0, Math.min(1 - span, center - span / 2));
  if (action === 'in' || action === 'out') {
    const nextSpan = action === 'in' ? Math.max(minimumSpan, span / 2) : Math.min(1, span * 2);
    if (Math.abs(nextSpan - (viewport.end - viewport.start)) < VIEWPORT_EPSILON) return viewport;
    const normalizedEnd = normalizedStart + span;
    const desiredStart = action === 'in' ? normalizedEnd - nextSpan : normalizedStart + span / 2 - nextSpan / 2;
    const start = Math.max(0, Math.min(1 - nextSpan, desiredStart));
    return { start, end: start + nextSpan };
  }

  const shift = span * 0.5 * (action === 'earlier' ? -1 : 1);
  const start = Math.max(0, Math.min(1 - span, normalizedStart + shift));
  return { start, end: start + span };
}

function visibleChartPoints(points: ReturnType<typeof pointsForMetric>, viewport: ChartViewport) {
  if (points.length < 4 || (viewport.start === 0 && viewport.end === 1)) return points;
  const first = Math.max(0, Math.min(points.length - 3, Math.floor(viewport.start * (points.length - 1) + VIEWPORT_EPSILON)));
  const end = Math.min(points.length, Math.max(first + 3, Math.ceil(viewport.end * (points.length - 1) - VIEWPORT_EPSILON) + 1));
  return points.slice(first, end);
}

function AssetMark({ coinId, large = false }: { coinId: CoinId; large?: boolean }) {
  const styles = useAppearanceStyles(baseStyles);
  const asset = ASSETS.find((item) => item.id === coinId)!;
  return (
    <View style={[styles.assetMark, large && styles.assetMarkLarge, { backgroundColor: `${asset.color}15` }]} importantForAccessibility="no">
      <Text style={[styles.assetMarkText, large && styles.assetMarkTextLarge, { color: asset.color }]}>{asset.monogram}</Text>
    </View>
  );
}

function DataNotice({
  stale,
  loading,
  error,
  retrievedAt,
  alternativeRetrievedAt,
  onRetry,
  onShowLatest,
}: {
  stale: boolean;
  loading: boolean;
  error: string | null;
  retrievedAt: string | null;
  alternativeRetrievedAt: string | null;
  onRetry: () => void;
  onShowLatest?: () => void;
}) {
  const styles = useAppearanceStyles(baseStyles);
  const comparison = formatRetrievalComparison(retrievedAt, alternativeRetrievedAt);
  if (stale) {
    return (
      <View style={[styles.notice, styles.noticeStale]} accessibilityRole="summary">
        <View style={styles.noticeCopy}>
          <Text style={styles.noticeTitle}>Market data needs attention</Text>
          <Text style={styles.noticeBody}>{error ?? 'Showing a saved market view while requesting another response.'}</Text>
          <Text style={styles.noticeBody}>{comparison ?? `Displayed view retrieved ${formatTimestamp(retrievedAt)}`}</Text>
          <Text style={styles.noticeBody}>Retrieval time alone does not confirm price freshness.</Text>
        </View>
        <View style={styles.noticeActions}>
          {onShowLatest && <NativeButton label="Show latest response" onPress={onShowLatest} compact variant="text" />}
          <NativeButton label="Retry" onPress={onRetry} compact variant="text" />
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.notice, styles.noticeError]} accessibilityRole="summary">
        <View style={styles.noticeCopy}>
          <Text style={styles.noticeTitle}>Market data is temporarily unavailable</Text>
          <Text style={styles.noticeBody}>{error}</Text>
        </View>
        <NativeButton label="Retry" onPress={onRetry} compact variant="text" />
      </View>
    );
  }

  return (
    <View style={[styles.notice, styles.noticeFresh]} accessibilityRole="summary">
      <View style={styles.dataDot} />
      <View style={styles.noticeCopy}>
        <Text style={styles.freshText}>{loading ? 'Requesting market data' : `CoinGecko · Response retrieved ${formatTimestamp(retrievedAt)}`}</Text>
        <Text style={styles.noticeBody}>Retrieval time alone does not confirm price freshness.</Text>
      </View>
    </View>
  );
}

function MetricButton({ metric, selected, disabled, onPress }: { metric: Metric; selected: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <NativeButton
      label={metricLabel(metric)}
      selected={selected}
      disabled={disabled}
      compact
      onPress={onPress}
    />
  );
}

function ChartZoomControls({ viewport, points, visiblePoints, onAction }: { viewport: ChartViewport; points: ReturnType<typeof pointsForMetric>; visiblePoints: ReturnType<typeof pointsForMetric>; onAction: (action: 'in' | 'out' | 'earlier' | 'later' | 'reset') => void }) {
  const styles = useAppearanceStyles(baseStyles);
  const span = viewport.end - viewport.start;
  const zoomed = span < 1 - VIEWPORT_EPSILON;
  const minimumSpan = minimumChartViewportSpan(points.length);
  const fullTime = (points[points.length - 1]?.timestamp ?? 0) - (points[0]?.timestamp ?? 0);
  const visibleTime = (visiblePoints[visiblePoints.length - 1]?.timestamp ?? 0) - (visiblePoints[0]?.timestamp ?? 0);
  const ratio = fullTime / visibleTime;
  const factor = fullTime > 0 && visibleTime > 0 && Number.isFinite(ratio) ? `${ratio.toFixed(1)}× view` : 'View range unavailable';
  return (
    <View style={styles.zoomRow}>
      <Text style={styles.zoomLevel} accessibilityLiveRegion="polite">{factor}</Text>
      <View style={styles.zoomButtons}>
        {zoomed && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show earlier chart points"
            accessibilityState={{ disabled: viewport.start <= VIEWPORT_EPSILON }}
            disabled={viewport.start <= VIEWPORT_EPSILON}
            onPress={() => onAction('earlier')}
            style={({ pressed }) => [styles.zoomButton, pressed && styles.zoomButtonPressed, viewport.start <= VIEWPORT_EPSILON && styles.zoomButtonDisabled]}>
            <Text style={styles.zoomButtonText}>←</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Zoom out"
          accessibilityState={{ disabled: !zoomed }}
          disabled={!zoomed}
          onPress={() => onAction('out')}
          style={({ pressed }) => [styles.zoomButton, pressed && styles.zoomButtonPressed, !zoomed && styles.zoomButtonDisabled]}>
          <Text style={styles.zoomButtonText}>−</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset chart zoom"
          accessibilityState={{ disabled: !zoomed }}
          disabled={!zoomed}
          onPress={() => onAction('reset')}
          style={({ pressed }) => [styles.zoomButton, styles.zoomResetButton, pressed && styles.zoomButtonPressed, !zoomed && styles.zoomButtonDisabled]}>
          <Text style={styles.zoomButtonText}>Reset</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Zoom in"
          accessibilityState={{ disabled: points.length < 4 || span <= minimumSpan + VIEWPORT_EPSILON }}
          disabled={points.length < 4 || span <= minimumSpan + VIEWPORT_EPSILON}
          onPress={() => onAction('in')}
          style={({ pressed }) => [styles.zoomButton, pressed && styles.zoomButtonPressed, (points.length < 4 || span <= minimumSpan + VIEWPORT_EPSILON) && styles.zoomButtonDisabled]}>
          <Text style={styles.zoomButtonText}>+</Text>
        </Pressable>
        {zoomed && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show later chart points"
            accessibilityState={{ disabled: viewport.end >= 1 - VIEWPORT_EPSILON }}
            disabled={viewport.end >= 1 - VIEWPORT_EPSILON}
            onPress={() => onAction('later')}
            style={({ pressed }) => [styles.zoomButton, pressed && styles.zoomButtonPressed, viewport.end >= 1 - VIEWPORT_EPSILON && styles.zoomButtonDisabled]}>
            <Text style={styles.zoomButtonText}>→</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export default function MarketsScreen() {
  const styles = useAppearanceStyles(baseStyles);
  const colors = usePalette();
  const { overview, refreshOverview, showLatestOverviewResponse, currency, currencyReady } = useData();
  const layout = useResponsiveLayout();
  const [selectedCoin, setSelectedCoin] = useState<CoinId>('bitcoin');
  const [days, setDays] = useState<ChartDays>(7);
  const [metric, setMetric] = useState<Metric>('price');
  const [chartMode, setChartMode] = useState<'line' | 'candles'>('line');
  const [candleInterval, setCandleInterval] = useState<'auto' | IntradayInterval>('auto');
  const [intradayDays, setIntradayDays] = useState<IntradayDays>(1);
  const [candleIndicators, setCandleIndicators] = useState<CandleIndicators>({ sma: false, ema: false, rsi: false });
  const [lineIndicatorsOpen, setLineIndicatorsOpen] = useState(false);
  const [chartViewport, setChartViewport] = useState<ChartViewport>(FULL_CHART_VIEWPORT);
  const chart = useMarketChart(selectedCoin, days, currency, currencyReady);
  const asset = ASSETS.find((item) => item.id === selectedCoin)!;
  const quote = overview.data?.coins.find((item) => item.id === selectedCoin) ?? null;
  const availableMetrics = chart.data?.availableMetrics ?? ['price', 'marketCap', 'volume'];
  const visibleMetric = availableMetrics.includes(metric) ? metric : 'price';
  const anyIndicator = Object.values(candleIndicators).some(Boolean);
  const estimatedLine = chart.data?.seriesSource === 'market_overview_sparkline';
  const intradaySelected = visibleMetric === 'price' && chartMode === 'candles' && candleInterval !== 'auto';
  const intradayWindowValid = candleInterval !== 'auto' && (intradayDays === 1 || candleInterval === '15m');
  const needsCandles = currencyReady && visibleMetric === 'price'
    && ((chartMode === 'candles' && candleInterval === 'auto') || (chartMode === 'line' && anyIndicator));
  const intradayFeedEnabled = intradaySelected && intradayWindowValid && selectedCoin !== 'paypal-usd';
  const candleResource = useMarketCandles(selectedCoin, days, currency, needsCandles);
  const intradayResource = useIntradayCandles(selectedCoin, candleInterval === 'auto' ? null : candleInterval, intradayDays,
    intradayFeedEnabled);
  const refreshingMarketData = currencyReady && (
    overview.loading || chart.loading || (needsCandles && candleResource.loading) || (intradayFeedEnabled && intradayResource.loading)
  );
  const points = useMemo(() => chart.data ? chronologicalChartPoints(pointsForMetric(chart.data, visibleMetric)) : [], [chart.data, visibleMetric]);
  const displayedPoints = visibleChartPoints(points, chartViewport);
  const lastPoint = points[points.length - 1];
  const chartDelta = chartPercentageChange(points);

  const headline = selectHeadlineMetric(quote, visibleMetric, lastPoint);
  const hasOverviewValue = headline.source === 'overview';
  const selectedValue = headline.value;
  const headlineSource = hasOverviewValue ? (overview.stale ? 'Earlier overview' : 'Overview') : headline.source === 'chart' ? (chart.stale ? 'Earlier chart' : 'Chart fallback') : 'Waiting for data';
  const headlineRetrievedAt = hasOverviewValue ? overview.data?.retrievedAt : headline.source === 'chart' ? chart.data?.retrievedAt : null;
  const quoteChange = quote?.change24hPct ?? null;

  function refreshMarketData() {
    refreshOverview();
    chart.retry();
    if (needsCandles) candleResource.retry();
    if (intradayFeedEnabled) intradayResource.retry();
  }

  function chooseCoin(coinId: CoinId) {
    setChartViewport(FULL_CHART_VIEWPORT);
    if (coinId !== selectedCoin) intradayResource.retry();
    setSelectedCoin(coinId);
  }

  function chooseDays(nextDays: ChartDays) {
    setChartViewport(FULL_CHART_VIEWPORT);
    setDays(nextDays);
  }

  function chooseMetric(nextMetric: Metric) {
    setChartViewport(FULL_CHART_VIEWPORT);
    if (nextMetric === 'price' && metric !== 'price' && anyIndicator) candleResource.retry();
    setMetric(nextMetric);
    if (nextMetric !== 'price') setChartMode('line');
  }

  function chooseChartMode(nextMode: 'line' | 'candles') {
    if (nextMode === chartMode) return;
    if (nextMode === 'candles' && candleInterval === 'auto' && !anyIndicator) candleResource.retry();
    if (nextMode === 'candles' && candleInterval !== 'auto') intradayResource.retry();
    setChartMode(nextMode);
  }

  function chooseCandleInterval(interval: 'auto' | IntradayInterval) {
    if (interval === candleInterval) return;
    if (interval !== 'auto') intradayResource.retry();
    setCandleInterval(interval);
  }

  function chooseIntradayDays(window: IntradayDays) {
    if (window === intradayDays) return;
    intradayResource.retry();
    setIntradayDays(window);
  }

  function toggleIndicator(indicator: CandleIndicator) {
    if (chartMode === 'line' && !anyIndicator && !candleIndicators[indicator]) candleResource.retry();
    setCandleIndicators((current) => ({ ...current, [indicator]: !current[indicator] }));
  }

  function changeChartViewport(action: 'in' | 'out' | 'earlier' | 'later' | 'reset') {
    if (action === 'reset') {
      setChartViewport(FULL_CHART_VIEWPORT);
      return;
    }
    setChartViewport((current) => chartViewportAction(current, action, points.length));
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={[styles.content, layout.wideCanvas && styles.contentWide]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshingMarketData} onRefresh={refreshMarketData} tintColor={colors.blue} colors={[colors.blue]} />
        }>
        <MarketHeader />

        <View style={styles.titleBlock}>
          <Text style={styles.kicker}>CRYPTO OVERVIEW</Text>
          <Text accessibilityRole="header" style={styles.pageTitle}>Markets</Text>
          <Text style={styles.subtitle}>Reference prices · availability varies.</Text>
        </View>

        <DataNotice
          stale={overview.stale}
          loading={overview.loading}
          error={overview.error}
          retrievedAt={overview.data?.retrievedAt ?? null}
          alternativeRetrievedAt={overview.networkAlternative?.retrievedAt ?? null}
          onRetry={refreshMarketData}
          onShowLatest={overview.networkAlternative ? showLatestOverviewResponse : undefined}
        />

        <View style={styles.sectionHeading}>
          <View style={styles.sectionHeadingText}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Selected asset</Text>
            <Text style={styles.sectionSubtitle}>Choose an asset; pull to refresh.</Text>
          </View>
          <NativeButton label={refreshingMarketData ? 'Refreshing…' : 'Refresh'} accessibilityLabel="Refresh quote and active chart data" onPress={refreshMarketData} disabled={refreshingMarketData} compact variant="text" />
        </View>

        <View style={styles.assetPickerHeading}>
          <Text style={styles.assetPickerTitle}>Choose asset</Text>
          <Text style={styles.assetPickerHint}>Swipe to explore</Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.assetPicker} accessibilityLabel="Choose a crypto asset">
          {ASSETS.map((item) => {
            const selected = item.id === selectedCoin;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={`Select ${item.name}, ${item.symbol}`}
                accessibilityHint="Updates the selected asset and chart."
                accessibilityState={{ selected }}
                onPress={() => chooseCoin(item.id)}
                style={({ pressed }) => [styles.assetPickerButton, selected && styles.assetPickerButtonSelected, pressed && styles.marketRowPressed]}>
                <Text style={[styles.assetPickerMonogram, { color: item.color }]} accessibilityElementsHidden importantForAccessibility="no">{item.monogram}</Text>
                <Text style={[styles.assetPickerSymbol, selected && styles.assetPickerSymbolSelected]}>{item.symbol}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={layout.pairedPanels ? styles.marketPanels : undefined}>
        <View style={layout.pairedPanels ? styles.marketSummaryPanel : undefined}>
        <View style={styles.selectedCard}>
          <View style={styles.cardAccent} importantForAccessibility="no" />
          <View style={styles.selectedTop}>
            <View style={styles.assetIdentity}>
              <AssetMark coinId={selectedCoin} large />
              <View style={styles.assetTitleWrap}>
                <Text style={styles.assetName}>{quote?.name ?? asset.name}</Text>
                <Text style={styles.assetSymbol}>{(quote?.symbol ?? asset.symbol).toUpperCase()} · {currency}</Text>
              </View>
            </View>
            {visibleMetric === 'price' && <View style={[styles.changePill, quoteChange === null ? styles.changeNeutral : quoteChange < 0 ? styles.changeDown : styles.changeUp]} accessible accessibilityLabel={quoteChange === null ? '24-hour price change unavailable' : `24-hour price change ${formatChange(quoteChange)}`}>
              <Text style={[styles.changeText, quoteChange === null ? styles.changeTextNeutral : quoteChange < 0 ? styles.changeTextDown : styles.changeTextUp]}>
                {formatChange(quoteChange)}
              </Text>
              <Text style={[styles.changePeriod, quoteChange === null ? styles.changeTextNeutral : quoteChange < 0 ? styles.changeTextDown : styles.changeTextUp]}>24h price</Text>
            </View>}
          </View>
          <Text style={styles.mainValue} accessibilityLabel={`${metricLabel(visibleMetric)} ${metricValueLabel(visibleMetric, selectedValue, currency, selectedCoin === 'paypal-usd')}`}>
            {metricValueLabel(visibleMetric, selectedValue, currency, selectedCoin === 'paypal-usd')}
          </Text>
          <Text style={styles.valueCaption}>{metricLabel(visibleMetric)} · {hasOverviewValue ? 'overview' : headline.source === 'chart' ? 'chart fallback' : 'waiting for a quote'}</Text>
          <View style={styles.selectedRule} />
          <View style={styles.selectedFooter}>
            <View style={styles.selectedTimeBlock}>
              <Text style={styles.selectedFootnote}>{headlineSource}{headlineRetrievedAt ? ` · retrieved ${formatTimestamp(headlineRetrievedAt)}` : ''}</Text>
              {headline.source === 'chart' && <Text style={styles.selectedFootnote}>{formatChartSampleTime(lastPoint, chart.data?.seriesSource)}</Text>}
              {headline.source === 'overview' && <Text style={styles.selectedFootnote}>Provider update {formatProviderUpdate(quote?.lastUpdated)}</Text>}
            </View>
            <Text style={styles.selectedFootnote}>CoinGecko</Text>
          </View>
        </View>
        </View>

        <View style={layout.pairedPanels ? styles.marketChartPanel : undefined}>
        <View style={styles.sectionHeading}>
          <View>
            <Text accessibilityRole="header" style={styles.sectionTitle}>{metricLabel(visibleMetric)} history</Text>
            <Text style={styles.sectionSubtitle}>Compare the selected measure over time.</Text>
          </View>
        </View>

        <View style={styles.chartCard}>
          <View style={styles.controlRow} accessibilityLabel="Chart measure">
            {METRICS.map((item) => (
              <MetricButton
                key={item}
                metric={item}
                selected={visibleMetric === item}
                disabled={!availableMetrics.includes(item)}
                onPress={() => chooseMetric(item)}
              />
            ))}
          </View>
          {(!intradaySelected) && <View style={styles.rangeRow} accessibilityLabel={chartMode === 'candles' ? 'Automatic candle history range' : 'Chart period'}>
            {CHART_RANGES.map((range) => (
              <NativeButton
                key={range.days}
                label={range.label}
                selected={days === range.days}
                compact
                onPress={() => chooseDays(range.days)}
              />
            ))}
          </View>}
          {visibleMetric === 'price' && <View style={styles.chartModeRow} accessibilityLabel="Price chart style">
            <NativeButton label="Line" selected={chartMode === 'line'} compact onPress={() => chooseChartMode('line')} />
            <NativeButton label="Candles" selected={chartMode === 'candles'} compact onPress={() => chooseChartMode('candles')} />
          </View>}
          {visibleMetric === 'price' && chartMode === 'candles' && <View>
            <Text style={styles.candleControlLabel}>Candle interval</Text>
            <View style={styles.chartModeRow} accessibilityLabel="Candle interval">
              {(['auto', '3m', '5m', '15m'] as const).map((interval) => <NativeButton
                key={interval}
                label={interval === 'auto' ? 'Auto' : interval}
                selected={candleInterval === interval}
                compact
                onPress={() => chooseCandleInterval(interval)}
              />)}
            </View>
            {candleInterval !== 'auto' && <>
              <Text style={styles.candleControlLabel}>Intraday window · Binance Spot / USDT</Text>
              <View style={styles.chartModeRow} accessibilityLabel="Intraday history window">
                {([1, 7] as const).map((window) => <NativeButton
                  key={window}
                  label={window === 1 ? '1D' : '7D'}
                  selected={intradayDays === window}
                  disabled={window === 7 && candleInterval !== '15m'}
                  compact
                  onPress={() => chooseIntradayDays(window)}
                />)}
              </View>
              <Text style={styles.fallbackNote}>7D is available for 15m candles only. USDT is a crypto quote, not USD.</Text>
            </>}
          </View>}

          {chartMode === 'line' || visibleMetric !== 'price' ? <>
          {visibleMetric === 'price' && <CandleIndicatorControls indicators={candleIndicators} onIndicatorChange={toggleIndicator} candleCount={candleResource.data?.candles.length ?? null} open={lineIndicatorsOpen} onToggleOpen={() => setLineIndicatorsOpen((open) => !open)} />}
          {visibleMetric === 'price' && anyIndicator && (estimatedLine ? (
            <View style={styles.indicatorNotice} accessibilityRole="summary">
              <Text style={styles.fallbackNote}>Indicators are unavailable on this estimated-time line. Switch to Candles to inspect exact CoinGecko OHLC closes.</Text>
              <NativeButton label="View candles" onPress={() => chooseChartMode('candles')} compact variant="text" />
            </View>
          ) : candleResource.loading || !currencyReady ? (
            <Text style={styles.fallbackNote} accessibilityLiveRegion="polite">Loading CoinGecko candle closes for indicators…</Text>
          ) : candleResource.error ? (
            <View style={styles.indicatorNotice} accessibilityRole="summary">
              <Text style={styles.fallbackNote}>Indicators unavailable: {candleResource.error} The price line remains available.</Text>
              <NativeButton label="Retry indicators" onPress={candleResource.retry} compact variant="text" />
            </View>
          ) : null)}
          <ChartZoomControls viewport={chartViewport} points={points} visiblePoints={displayedPoints} onAction={changeChartViewport} />
          {chart.data ? (
            <>
              <MarketChart points={displayedPoints} metric={visibleMetric} color={colors.aqua} currency={currency} isPaypalUsd={selectedCoin === 'paypal-usd'} indicators={visibleMetric === 'price' ? candleIndicators : undefined} indicatorHistory={estimatedLine ? null : candleResource.data} seriesSource={chart.data.seriesSource} selectionScope={`${selectedCoin}:${currency}:${days}:${visibleMetric}:${chart.data.retrievedAt}`} />
              <View style={styles.chartMeta}>
                <Text style={styles.chartDeltaLabel}>{days === 1 ? '1 day change' : `${days} day change`}</Text>
                <Text style={[styles.chartDeltaValue, chartDelta === null ? styles.changeTextNeutral : chartDelta < 0 && styles.chartDeltaNegative]}>{formatChange(chartDelta)}</Text>
              </View>
              {chart.data.seriesSource === 'market_overview_sparkline' && (
                <Text style={styles.fallbackNote}>Price-only fallback data · chart times are estimated from the available samples.</Text>
              )}
              {chart.stale && (
                <View style={styles.chartStaleRow} accessibilityRole="summary">
                  <View style={styles.noticeCopy}>
                    <Text style={styles.fallbackNote}>{chart.error ?? 'Showing the last available chart while requesting another response.'}</Text>
                    {chart.networkAlternative && <Text style={styles.fallbackNote}>{formatRetrievalComparison(chart.data.retrievedAt, chart.networkAlternative.retrievedAt)}</Text>}
                  </View>
                  <View style={styles.noticeActions}>
                    {chart.networkAlternative && <NativeButton label="Show latest response" onPress={chart.showLatestResponse} compact variant="text" />}
                    <NativeButton label="Retry" onPress={chart.retry} compact variant="text" />
                  </View>
                </View>
              )}
            </>
          ) : chart.loading ? (
            <View style={styles.chartLoading} accessibilityRole="progressbar" accessibilityLabel="Loading selected asset chart">
              <View style={styles.loadingLineWide} />
              <View style={styles.loadingLineNarrow} />
              <Text style={styles.loadingText}>Loading {asset.name} chart…</Text>
            </View>
          ) : (
            <View style={styles.chartError} accessibilityRole="summary">
              <Text style={styles.chartErrorTitle}>Chart not ready</Text>
              <Text style={styles.chartErrorText}>{chart.error ?? 'Market history is temporarily unavailable.'}</Text>
              {chart.stale && <Text style={styles.fallbackNote}>An earlier chart could not be loaded for this selection.</Text>}
              <View style={styles.chartRetry}>
                <NativeButton label="Retry chart" onPress={chart.retry} compact />
              </View>
            </View>
          )}

          <Text style={styles.chartProvider}>{chart.data ? `Reference data by CoinGecko · Retrieved ${formatTimestamp(chart.data.retrievedAt)}` : 'Chart retrieval time unavailable · CoinGecko'}</Text>
          {chart.data && <Text style={styles.chartSampleTime}>{formatChartSampleTime(lastPoint, chart.data.seriesSource)}</Text>}
          </> : intradaySelected ? <>
            {selectedCoin === 'paypal-usd' ? (
              <View style={styles.chartError} accessibilityRole="summary">
                <Text style={styles.chartErrorTitle}>Minute candles unavailable for PYUSD</Text>
                <Text style={styles.chartErrorText}>This feed does not offer PayPal USD. Choose Auto for CoinGecko candles.</Text>
                <View style={styles.chartRetry}><NativeButton label="Use Auto" onPress={() => chooseCandleInterval('auto')} compact /></View>
              </View>
            ) : !intradayWindowValid ? (
              <View style={styles.chartError} accessibilityRole="summary">
                <Text style={styles.chartErrorTitle}>Choose a supported window</Text>
                <Text style={styles.chartErrorText}>Choose 1D for 3m or 5m candles, or choose 15m for 7D.</Text>
              </View>
            ) : intradayResource.data ? (
              <CandleChart
                key={intradayResource.requestKey}
                candles={intradayResource.data.candles}
                intervalMinutes={intradayResource.data.intervalMinutes}
                currency={currency}
                quote="USDT"
                indicators={candleIndicators}
                onIndicatorChange={toggleIndicator}
              />
            ) : intradayResource.loading ? (
              <View style={styles.chartLoading} accessibilityRole="progressbar" accessibilityLabel="Loading intraday candlestick history">
                <View style={styles.loadingLineWide} />
                <View style={styles.loadingLineNarrow} />
                <Text style={styles.loadingText}>Loading {asset.name} intraday candles…</Text>
              </View>
            ) : (
              <View style={styles.chartError} accessibilityRole="summary">
                <Text style={styles.chartErrorTitle}>Intraday candles not ready</Text>
                <Text style={styles.chartErrorText}>{intradayResource.error ?? 'Intraday candles are temporarily unavailable.'}</Text>
                <View style={styles.chartRetry}><NativeButton label="Retry intraday" onPress={intradayResource.retry} compact /></View>
              </View>
            )}
            <Text style={styles.chartProvider}>{intradayResource.data
              ? `Binance Spot · USDT · ${intradayResource.data.count} closed candles\nCovered ${formatTimestamp(intradayResource.data.coveredStart)} to ${formatTimestamp(intradayResource.data.coveredEnd)}\nProvider response ${formatTimestamp(intradayResource.data.observedAt)} · Retrieved ${formatTimestamp(intradayResource.data.retrievedAt)}`
              : 'Binance Spot · USDT quote · Closed candles only'}</Text>
          </> : <>
            {candleResource.data && candleResource.data.candles.length > 0 ? (
              <CandleChart
                key={candleResource.requestKey}
                candles={candleResource.data.candles}
                intervalMinutes={candleResource.data.candleIntervalMinutes}
                currency={currency}
                isPaypalUsd={selectedCoin === 'paypal-usd'}
                indicators={candleIndicators}
                onIndicatorChange={toggleIndicator}
              />
            ) : candleResource.loading || !currencyReady ? (
              <View style={styles.chartLoading} accessibilityRole="progressbar" accessibilityLabel="Loading candlestick history">
                <View style={styles.loadingLineWide} />
                <View style={styles.loadingLineNarrow} />
                <Text style={styles.loadingText}>Loading {asset.name} candles…</Text>
              </View>
            ) : candleResource.data ? (
              <View style={styles.chartError} accessibilityRole="summary">
                <Text style={styles.chartErrorTitle}>No candle history for this range</Text>
                <Text style={styles.chartErrorText}>CoinGecko returned no candles for this selection. Try another period or return to the line chart.</Text>
                <View style={styles.chartRetry}><NativeButton label="Retry candles" onPress={candleResource.retry} compact /></View>
              </View>
            ) : (
              <View style={styles.chartError} accessibilityRole="summary">
                <Text style={styles.chartErrorTitle}>Candles not ready</Text>
                <Text style={styles.chartErrorText}>{candleResource.error ?? 'Candlestick data is temporarily unavailable.'}</Text>
                <View style={styles.chartRetry}><NativeButton label="Retry candles" onPress={candleResource.retry} compact /></View>
              </View>
            )}
            <Text style={styles.chartProvider}>{candleResource.data ? `CoinGecko OHLC · Retrieved ${formatTimestamp(candleResource.data.retrievedAt)}` : 'Candle retrieval time unavailable · CoinGecko'}</Text>
          </>}
        </View>
        </View>
        </View>

        <View style={styles.sectionHeading}>
          <View>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Tracked assets</Text>
          </View>
        </View>

        <View style={styles.marketList}>
          {ASSETS.map((item, index) => {
            const row = overview.data?.coins.find((coin) => coin.id === item.id);
            const selected = item.id === selectedCoin;
            const change = row?.change24hPct;
            return (
              <Pressable
                key={item.id}
                onPress={() => chooseCoin(item.id)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`${row?.name ?? item.name}, ${item.symbol}, ${row ? formatCurrency(row.price, currency, false, item.id === 'paypal-usd' ? 4 : undefined) : 'price unavailable'}${change === null || change === undefined ? '' : `, ${formatChange(change)} today`}`}
                style={({ pressed }) => [styles.marketRow, selected && styles.marketRowSelected, pressed && styles.marketRowPressed, index === ASSETS.length - 1 && styles.marketRowLast]}>
                <AssetMark coinId={item.id} />
                <View style={styles.marketNameWrap}>
                  <Text style={styles.marketName}>{row?.name ?? item.name}</Text>
                  <Text style={styles.marketSymbol}>{(row?.symbol ?? item.symbol).toUpperCase()}</Text>
                </View>
                <View style={styles.marketQuoteWrap}>
                  <Text style={styles.marketPrice}>{row ? formatCurrency(row.price, currency, false, item.id === 'paypal-usd' ? 4 : undefined) : '—'}</Text>
                  <Text style={[styles.marketChange, change === null || change === undefined ? styles.changeTextNeutral : change < 0 ? styles.changeTextDown : styles.changeTextUp]}>
                    {formatChange(change)}
                  </Text>
                </View>
                <Text style={[styles.chevron, selected && styles.chevronSelected]}>›</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.disclosure}>
          <Text style={styles.disclosureTitle}>A reference view, built for clarity</Text>
          <Text style={styles.disclosureText}>
            Prices and automatic charts come from CoinGecko. Minute candles use Binance Spot USDT, a separate crypto quote. Availability, prices, and features may vary by region and account. This screen does not trade, connect a wallet, or initiate a payment.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const baseStyles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  content: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 6, paddingBottom: 34 },
  contentWide: { maxWidth: 1160 },
  marketPanels: { flexDirection: 'row', alignItems: 'flex-start', gap: 20 },
  marketSummaryPanel: { flex: 3, minWidth: 300, maxWidth: 380 },
  marketChartPanel: { flex: 6, minWidth: 540 },
  titleBlock: { marginBottom: 10 },
  kicker: { color: palette.blue, fontSize: 10, lineHeight: 15, fontWeight: '800', letterSpacing: 0.9, marginBottom: 3 },
  pageTitle: { color: palette.ink, fontSize: 30, lineHeight: 37, fontWeight: '800', letterSpacing: -0.4 },
  subtitle: { color: '#526B83', fontSize: 13, lineHeight: 19, marginTop: 4, maxWidth: 390 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 12, borderRadius: 14, marginBottom: 15, borderWidth: 1 },
  noticeFresh: { backgroundColor: 'transparent', borderColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, paddingVertical: 2, marginBottom: 12 },
  noticeStale: { backgroundColor: '#FFF7E8', borderColor: '#F6DFB1' },
  noticeError: { backgroundColor: '#FFF1F0', borderColor: '#F2D2CF' },
  noticeCopy: { flex: 1, gap: 3 },
  noticeActions: { alignItems: 'flex-end', gap: 4 },
  noticeTitle: { color: '#28435D', fontSize: 12, fontWeight: '800' },
  noticeBody: { color: '#526B83', fontSize: 11, lineHeight: 16 },
  freshText: { flex: 1, color: '#526B83', fontSize: 11, lineHeight: 16, fontWeight: '700' },
  dataDot: { width: 7, height: 7, borderRadius: 5, backgroundColor: '#526B83' },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2, marginBottom: 8, gap: 8 },
  sectionHeadingText: { flex: 1, minWidth: 0 },
  sectionTitle: { color: palette.ink, fontSize: 16, lineHeight: 22, fontWeight: '800' },
  sectionSubtitle: { color: '#526B83', fontSize: 12, lineHeight: 17, marginTop: 2 },
  assetPickerHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 4, marginBottom: 7 },
  assetPickerTitle: { color: '#38536E', fontSize: 11, lineHeight: 16, fontWeight: '800' },
  assetPickerHint: { color: '#526B83', fontSize: 10, lineHeight: 15 },
  assetPicker: { alignItems: 'center', gap: 8, paddingBottom: 14 },
  assetPickerButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 13, borderWidth: 1, borderColor: palette.line, borderRadius: 14, backgroundColor: palette.surface },
  assetPickerButtonSelected: { borderColor: palette.blue, backgroundColor: palette.blueWash },
  assetPickerMonogram: { fontSize: 16, lineHeight: 21, fontWeight: '800' },
  assetPickerSymbol: { color: '#38536E', fontSize: 12, lineHeight: 18, fontWeight: '800' },
  assetPickerSymbolSelected: { color: '#005DAB' },
  selectedCard: { padding: 18, borderRadius: 20, backgroundColor: palette.navy, marginBottom: 20, shadowColor: palette.navy, shadowOpacity: 0.14, shadowRadius: 16, shadowOffset: { width: 0, height: 7 }, elevation: 4 },
  cardAccent: { position: 'absolute', top: 0, left: 18, width: 42, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, backgroundColor: palette.aqua },
  selectedTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  assetIdentity: { flexDirection: 'row', alignItems: 'center', gap: 11, flex: 1 },
  assetMark: { width: 42, height: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  assetMarkLarge: { width: 48, height: 48, borderRadius: 17 },
  assetMarkText: { fontSize: 21, fontWeight: '800' },
  assetMarkTextLarge: { fontSize: 24 },
  assetTitleWrap: { flex: 1 },
  assetName: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  assetSymbol: { color: '#D2E1F5', fontSize: 11, fontWeight: '700', marginTop: 2, letterSpacing: 0.4 },
  changePill: { flexDirection: 'row', flexWrap: 'wrap', flexShrink: 1, alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 18 },
  changeUp: { backgroundColor: palette.blueWash },
  changeDown: { backgroundColor: '#FBE4E2' },
  changeNeutral: { backgroundColor: '#EAF1FA' },
  changeText: { fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'] },
  changePeriod: { fontSize: 9, lineHeight: 13, fontWeight: '700' },
  changeTextUp: { color: palette.blue },
  changeTextDown: { color: '#A6322D' },
  changeTextNeutral: { color: '#405A72' },
  mainValue: { color: '#FFFFFF', fontSize: 32, lineHeight: 40, fontWeight: '800', letterSpacing: -0.4, marginTop: 14, fontVariant: ['tabular-nums'] },
  valueCaption: { color: '#D2E1F5', fontSize: 12, lineHeight: 18, marginTop: 1 },
  selectedRule: { height: 1, backgroundColor: '#37538C', marginTop: 14, marginBottom: 10 },
  selectedFooter: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6 },
  selectedTimeBlock: { flex: 1, minWidth: 0, gap: 3 },
  selectedFootnote: { color: '#D2E1F5', fontSize: 10, lineHeight: 15, fontWeight: '600', flexShrink: 1 },
  chartCard: { backgroundColor: palette.surface, borderRadius: 20, padding: 15, borderWidth: 1, borderColor: palette.line, marginBottom: 20 },
  controlRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 12 },
  rangeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 12, paddingBottom: 4 },
  chartModeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 12 },
  candleControlLabel: { color: '#526B83', fontSize: 11, fontWeight: '700', marginBottom: 5 },
  indicatorNotice: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  zoomRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 11 },
  zoomLevel: { color: '#526B83', fontSize: 11, fontVariant: ['tabular-nums'] },
  zoomButtons: { maxWidth: '100%', flexDirection: 'row', flexWrap: 'wrap', flexShrink: 1, alignItems: 'center', gap: 5 },
  zoomButton: { minWidth: 48, minHeight: 48, paddingHorizontal: 8, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D5E0EC', borderRadius: 12, backgroundColor: '#FFFFFF' },
  zoomResetButton: { minWidth: 52 },
  zoomButtonPressed: { backgroundColor: '#F0F6FD', opacity: 0.8 },
  zoomButtonDisabled: { borderColor: '#EDF1F5', backgroundColor: '#F8FAFC', opacity: 0.6 },
  zoomButtonText: { color: '#315579', fontSize: 12, fontWeight: '700' },
  chartMeta: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 12, borderTopWidth: 1, borderTopColor: '#EFF3F7' },
  chartDeltaLabel: { color: '#526B83', fontSize: 12, fontWeight: '600' },
  chartDeltaValue: { color: palette.blue, fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  chartDeltaNegative: { color: '#A6322D' },
  chartProvider: { color: '#526B83', fontSize: 10, lineHeight: 15, marginTop: 12 },
  chartSampleTime: { color: '#526B83', fontSize: 10, lineHeight: 15, marginTop: 3 },
  chartLoading: { height: 208, borderRadius: 16, backgroundColor: '#F6F9FC', alignItems: 'center', justifyContent: 'center', gap: 14, overflow: 'hidden' },
  loadingLineWide: { width: '78%', height: 5, backgroundColor: '#E4EBF3', borderRadius: 3, transform: [{ rotate: '-8deg' }] },
  loadingLineNarrow: { width: '52%', height: 5, backgroundColor: '#E4EBF3', borderRadius: 3, transform: [{ rotate: '4deg' }] },
  loadingText: { color: '#526B83', fontSize: 12, fontWeight: '600' },
  chartError: { minHeight: 190, alignItems: 'center', justifyContent: 'center', padding: 18, gap: 7, borderRadius: 16, backgroundColor: '#F8FAFC' },
  chartErrorTitle: { color: '#28435D', fontSize: 15, fontWeight: '800' },
  chartErrorText: { color: '#526B83', fontSize: 12, textAlign: 'center', lineHeight: 17 },
  chartRetry: { marginTop: 4 },
  fallbackNote: { color: '#6D521D', fontSize: 10, lineHeight: 15, marginTop: 9 },
  chartStaleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 7, marginTop: 6 },
  marketList: { backgroundColor: palette.surface, borderRadius: 20, paddingHorizontal: 13, borderWidth: 1, borderColor: palette.line, marginBottom: 18 },
  marketRow: { minHeight: 69, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: 1, borderBottomColor: '#EDF1F5', paddingVertical: 10, paddingHorizontal: 3, borderRadius: 14 },
  marketRowSelected: { backgroundColor: '#F0F7FF', paddingHorizontal: 8, borderColor: '#DDEAF9' },
  marketRowPressed: { opacity: 0.72 },
  marketRowLast: { borderBottomWidth: 0 },
  marketNameWrap: { flex: 1 },
  marketName: { color: '#142C4E', fontSize: 13, fontWeight: '800' },
  marketSymbol: { color: '#526B83', fontSize: 10, fontWeight: '700', marginTop: 3, letterSpacing: 0.5 },
  marketQuoteWrap: { alignItems: 'flex-end', minWidth: 92 },
  marketPrice: { color: '#142C4E', fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  marketChange: { fontSize: 10, fontWeight: '700', marginTop: 3, fontVariant: ['tabular-nums'] },
  chevron: { color: '#526B83', fontSize: 22, lineHeight: 24, marginLeft: 1 },
  chevronSelected: { color: '#0070E0' },
  disclosure: { paddingHorizontal: 3, paddingTop: 4, gap: 5 },
  disclosureTitle: { color: '#38536E', fontSize: 12, fontWeight: '800' },
  disclosureText: { color: '#526B83', fontSize: 11, lineHeight: 17 },
});
