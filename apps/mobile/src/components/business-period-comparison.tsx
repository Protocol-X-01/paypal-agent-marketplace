import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BUSINESS_COMPARISON_METRICS, buildBusinessComparison, type BusinessComparisonMetric } from '@/lib/business-comparison';
import { compareBusinessChannels } from '@/lib/business-channel-comparison';
import type { BusinessSnapshot } from '@/lib/business-snapshot';
import { palette } from '@/lib/palette';
import { useAppearanceStyles } from '@/lib/theme-context';

export function BusinessPeriodComparison({ snapshot }: { snapshot: BusinessSnapshot }) {
  const styles = useAppearanceStyles(baseStyles);
  const [metric, setMetric] = useState<BusinessComparisonMetric>('transactions');
  const comparison = buildBusinessComparison(snapshot, metric);
  const channels = compareBusinessChannels(snapshot, metric);
  const metricLabel = metric === 'transactions' ? 'Transactions' : metric === 'gross' ? 'Gross volume' : 'Refund amount';

  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>TWO-PERIOD COMPARISON</Text>
      <Text style={styles.title} accessibilityRole="header">Compare your two periods.</Text>
      <Text style={styles.subtitle}>Compare the totals supplied in this report.</Text>

      <View style={styles.metricRow}>
        {BUSINESS_COMPARISON_METRICS.map((option) => {
          const selected = option.id === metric;
          return <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityLabel={`Compare ${option.label.toLowerCase()}`}
            accessibilityState={{ selected }}
            onPress={() => setMetric(option.id)}
            style={({ pressed }) => [styles.metricButton, selected && styles.metricSelected, pressed && styles.pressed]}
          >
            <Text style={[styles.metricText, selected && styles.metricTextSelected]}>{option.label}</Text>
          </Pressable>;
        })}
      </View>

      <View style={styles.rows}>
        {comparison.rows.map((row, index) => <View
          key={row.label}
          style={styles.row}
          accessible
          accessibilityLabel={`${row.label}, ${row.startDate} to before ${row.endExclusive} UTC. ${metricLabel}: ${row.formatted}.`}
        >
          <View style={styles.rowHeading}>
            <Text style={styles.rowLabel}>{row.label}</Text>
            <Text style={styles.rowValue}>{row.formatted}</Text>
          </View>
          <Text style={styles.rowDates}>{row.startDate} to before {row.endExclusive} UTC</Text>
          <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={[styles.fill, index === 0 ? styles.previousFill : styles.currentFill, { width: row.width }]} />
          </View>
        </View>)}
      </View>
      <Text style={styles.scaleNote}>{comparison.bothZero ? 'Both period totals are zero.' : 'Bars are scaled to the larger period total. Exact totals are shown.'}</Text>
      {channels.length > 0 && <View style={styles.channelComparison}>
        <Text accessibilityRole="header" style={styles.channelTitle}>Change by sales channel</Text>
        <Text style={styles.channelHelp}>Compare each channel’s two periods. Bars use that channel’s larger value as their scale.</Text>
        {channels.map((row) => <View
          key={row.channel}
          style={styles.channelRow}
          accessible
          accessibilityLabel={`${row.label}. ${metricLabel}. Previous ${row.previous}. Current ${row.current}. ${row.changeDescription}. ${row.percentage}`}
        >
          <View style={styles.channelSummary}>
            <View style={styles.channelValues}>
              <Text style={styles.channelName}>{row.label}</Text>
              <Text style={styles.channelDetail}>Previous {row.previous} · Current {row.current}</Text>
            </View>
            <View style={styles.channelValues}>
              <Text style={styles.channelName}>Change {row.change}</Text>
              <Text style={styles.channelDetail}>{row.percentage}</Text>
            </View>
          </View>
          <View style={styles.channelBars} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={styles.channelBar}>
              <Text style={styles.channelBarLabel}>Previous</Text>
              <View style={styles.channelTrack}><View style={[styles.channelFill, styles.previousFill, { width: row.previousWidth }]} /></View>
            </View>
            <View style={styles.channelBar}>
              <Text style={styles.channelBarLabel}>Current</Text>
              <View style={styles.channelTrack}><View style={[styles.channelFill, styles.currentFill, { width: row.currentWidth }]} /></View>
            </View>
          </View>
        </View>)}
      </View>}
    </View>
  );
}

const baseStyles = StyleSheet.create({
  card: { marginTop: 16, padding: 14, borderWidth: 1, borderColor: palette.line, borderRadius: 14, backgroundColor: palette.ice },
  eyebrow: { color: '#496789', fontSize: 10, lineHeight: 15, fontWeight: '800', letterSpacing: 0.8 },
  title: { color: '#15385D', fontSize: 16, lineHeight: 22, fontWeight: '800', marginTop: 4 },
  subtitle: { color: '#526B83', fontSize: 12, lineHeight: 18, marginTop: 4 },
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12 },
  metricButton: { minHeight: 44, flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: '#D1DFEE', borderRadius: 10, backgroundColor: '#FFFFFF' },
  metricSelected: { borderColor: palette.blue, backgroundColor: palette.blueWash },
  metricText: { color: '#38536E', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  metricTextSelected: { color: '#005DAB' },
  rows: { gap: 14, marginTop: 15 },
  row: { gap: 4 },
  rowHeading: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 },
  rowLabel: { color: '#38536E', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  rowValue: { color: '#15385D', fontSize: 15, lineHeight: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  rowDates: { color: '#526B83', fontSize: 11, lineHeight: 16 },
  track: { height: 8, overflow: 'hidden', borderRadius: 4, backgroundColor: '#E2EBF5', marginTop: 3 },
  fill: { height: 8, borderRadius: 4 },
  previousFill: { backgroundColor: '#607D9B' },
  currentFill: { backgroundColor: palette.blue },
  scaleNote: { color: '#526B83', fontSize: 11, lineHeight: 16, marginTop: 12 },
  channelComparison: { marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#DCE7F4' },
  channelTitle: { color: '#15385D', fontSize: 13, lineHeight: 19, fontWeight: '800' },
  channelHelp: { color: '#526B83', fontSize: 11, lineHeight: 16, marginTop: 4 },
  channelRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#E8EFF7' },
  channelSummary: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  channelValues: { flexShrink: 1, minWidth: 0 },
  channelName: { color: '#193456', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  channelDetail: { color: '#526B83', fontSize: 11, lineHeight: 16, marginTop: 2 },
  channelBars: { gap: 5, marginTop: 10 },
  channelBar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  channelBarLabel: { width: 50, color: '#526B83', fontSize: 10, lineHeight: 15 },
  channelTrack: { flex: 1, height: 6, overflow: 'hidden', borderRadius: 3, backgroundColor: '#E2EBF5' },
  channelFill: { height: 6, borderRadius: 3 },
  pressed: { opacity: 0.72 },
});
