import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { allocationShareLabel, portfolioAllocation } from '@/lib/portfolio-allocation';
import type { CoinId } from '@/lib/market';
import type { Palette } from '@/lib/palette';
import { usePalette, useThemedStyles } from '@/lib/theme-context';
import { responsiveAllocationSize } from '@/lib/responsive-layout';

export type AllocationPosition = { id: CoinId; name: string; symbol: string; color: string; value: number | null };

export function PortfolioAllocation({ positions, total, currency, unavailableMessage, formatValue, stale }: {
  positions: AllocationPosition[];
  total: number | null;
  currency: string;
  unavailableMessage: string;
  formatValue: (value: number) => string;
  stale: boolean;
}) {
  const palette = usePalette();
  const styles = useThemedStyles(createStyles);
  const [selectedId, setSelectedId] = useState<CoinId | null>(null);
  const [cardWidth, setCardWidth] = useState(0);
  const ringSize = responsiveAllocationSize(cardWidth);
  const slices = portfolioAllocation(positions, total);
  const selected = slices?.find((slice) => slice.id === selectedId) ?? null;
  const circumference = 2 * Math.PI * 72;
  const spokenValue = (value: number) => formatValue(value).replace(/^<\s*/, 'Less than ');

  return <View style={styles.card} onLayout={(event) => setCardWidth(event.nativeEvent.layout.width)}>
    <View style={styles.heading}>
      <View style={styles.headingCopy}><Text style={styles.eyebrow}>PORTFOLIO MIX</Text><Text style={styles.title} accessibilityRole="header">Your allocation</Text><Text style={styles.subtitle}>Your entered quantities · {currency} reference prices</Text></View>
      <Text style={styles.badge}>ESTIMATE</Text>
    </View>
    {slices ? <>
      <View style={[styles.chartWrap, { width: ringSize, height: ringSize }]}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Svg width={ringSize} height={ringSize} viewBox="0 0 200 200">
            <Circle cx="100" cy="100" r="72" fill="none" stroke={palette.ice} strokeWidth="22" />
            {slices.map((slice) => <Circle key={slice.id} cx="100" cy="100" r="72" fill="none" stroke={slice.color} strokeWidth={selected?.id === slice.id ? 26 : 22} strokeDasharray={[circumference * slice.share / 100, circumference * (100 - slice.share) / 100]} strokeDashoffset={-circumference * slice.start / 100} transform="rotate(-90 100 100)" />)}
          </Svg>
        </View>
        <View pointerEvents="none" style={[styles.chartCenter, { top: ringSize * 0.285, left: ringSize * 0.21, width: ringSize * 0.58, height: ringSize * 0.43 }]} accessible accessibilityLabel={selected ? `${selected.name}, ${allocationShareLabel(selected.share)} of portfolio, ${spokenValue(selected.value)}` : `Total estimated portfolio value ${spokenValue(total!)}`} accessibilityLiveRegion="polite">
          <Text style={styles.centerLabel}>{selected ? selected.symbol : 'TOTAL VALUE'}</Text>
          <Text style={styles.centerValue} numberOfLines={2} adjustsFontSizeToFit>{selected ? allocationShareLabel(selected.share) : formatValue(total!)}</Text>
          <Text style={styles.centerDetail}>{selected ? formatValue(selected.value) : `${slices.length} ${slices.length === 1 ? 'holding' : 'holdings'}`}</Text>
        </View>
      </View>
      <View style={styles.legendHeading}><Text style={styles.legendLabel}>Select an asset</Text>{selected && <Pressable accessibilityRole="button" accessibilityLabel="Show total allocation" onPress={() => setSelectedId(null)} style={styles.clear}><Text style={styles.clearText}>Show total</Text></Pressable>}</View>
      <View style={styles.legend}>
        {slices.map((slice) => {
          const active = selected?.id === slice.id;
          return <Pressable key={slice.id} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`${slice.name}, ${spokenValue(slice.value)}, ${allocationShareLabel(slice.share)} of portfolio`} onPress={() => setSelectedId(slice.id)} style={({ pressed }) => [styles.legendRow, active && styles.legendSelected, pressed && styles.pressed]}>
            <View style={[styles.swatch, { backgroundColor: slice.color }]} />
            <View style={styles.asset}><Text style={styles.assetName}>{slice.name}</Text><Text style={styles.assetSymbol}>{slice.symbol}</Text></View>
            <View style={styles.amount}><Text style={styles.share}>{allocationShareLabel(slice.share)}</Text><Text style={styles.value}>{formatValue(slice.value)}</Text></View>
          </Pressable>;
        })}
      </View>
      <Text style={styles.caption}>{stale ? 'Based on earlier reference prices. ' : ''}Share of estimated value, not investment return. Percentages are rounded.</Text>
    </> : <View style={styles.empty} accessibilityRole="summary"><View style={styles.emptyRing}><Text style={styles.emptyPlus} importantForAccessibility="no">＋</Text></View><View style={styles.emptyCopy}><Text style={styles.emptyTitle}>Allocation unavailable</Text><Text style={styles.emptyText}>{unavailableMessage}</Text></View></View>}
  </View>;
}

function createStyles(palette: Palette) {
  return StyleSheet.create({
  card: { marginTop: 18, padding: 18, borderWidth: 1, borderColor: palette.line, borderRadius: 20, backgroundColor: palette.surface },
  heading: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  headingCopy: { flex: 1 },
  eyebrow: { color: palette.link, fontSize: 10, lineHeight: 15, fontWeight: '800', letterSpacing: 0.9 },
  title: { color: palette.ink, fontSize: 20, lineHeight: 26, fontWeight: '800', marginTop: 3 },
  subtitle: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  badge: { color: palette.ink, backgroundColor: palette.blueWash, overflow: 'hidden', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 6, fontSize: 9, fontWeight: '800' },
  chartWrap: { alignSelf: 'center', marginTop: 18 },
  chartCenter: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  centerLabel: { color: palette.muted, fontSize: 10, lineHeight: 15, fontWeight: '800', letterSpacing: 0.5 },
  centerValue: { color: palette.ink, fontSize: 19, lineHeight: 24, fontWeight: '800', textAlign: 'center', fontVariant: ['tabular-nums'] },
  centerDetail: { color: palette.muted, fontSize: 10, lineHeight: 15, textAlign: 'center' },
  legendHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  legendLabel: { color: palette.muted, fontSize: 11, lineHeight: 17, fontWeight: '700' },
  clear: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  clearText: { color: palette.link, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  legend: { gap: 6, marginTop: 5 },
  legendRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, paddingVertical: 8, borderWidth: 1, borderColor: 'transparent', borderRadius: 11, backgroundColor: palette.ice },
  legendSelected: { borderColor: palette.featureLine, backgroundColor: palette.blueWash },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  asset: { flex: 1, minWidth: 0 },
  assetName: { color: palette.ink, fontSize: 12, lineHeight: 17, fontWeight: '800' },
  assetSymbol: { color: palette.muted, fontSize: 10, lineHeight: 15 },
  amount: { alignItems: 'flex-end', flexShrink: 1 },
  share: { color: palette.ink, fontSize: 12, lineHeight: 17, fontWeight: '800', textAlign: 'right', fontVariant: ['tabular-nums'] },
  value: { color: palette.muted, fontSize: 10, lineHeight: 15, textAlign: 'right', fontVariant: ['tabular-nums'] },
  caption: { color: palette.muted, fontSize: 11, lineHeight: 17, marginTop: 12 },
  empty: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 18, padding: 14, backgroundColor: palette.ice, borderRadius: 13 },
  emptyRing: { width: 48, height: 48, borderWidth: 1, borderColor: palette.featureLine, backgroundColor: palette.blueWash, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  emptyPlus: { color: palette.blue, fontSize: 20, lineHeight: 24, fontWeight: '700' },
  emptyCopy: { flex: 1 },
  emptyTitle: { color: palette.ink, fontSize: 13, lineHeight: 19, fontWeight: '800' },
  emptyText: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 3 },
  pressed: { opacity: 0.72 },
  });
}
