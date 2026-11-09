import { StyleSheet, Text, View } from 'react-native';

import { CurrencyPicker, CurrencyPreferenceNotice } from '@/components/currency-picker';
import type { Palette } from '@/lib/palette';
import { useThemedStyles } from '@/lib/theme-context';

export function MarketHeader({ showCurrencyControls = true }: { showCurrencyControls?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <>
      <View style={styles.header}>
        <View style={styles.brand} accessible accessibilityLabel="PayPal Markets concept">
          <View style={styles.mark}><Text style={styles.markText}>P</Text></View>
          <View>
            <Text style={styles.name}>PayPal</Text>
            <Text style={styles.product}>MARKETS · CONCEPT</Text>
          </View>
        </View>
        {showCurrencyControls && <CurrencyPicker />}
      </View>
      {showCurrencyControls && <CurrencyPreferenceNotice />}
    </>
  );
}

function createStyles(palette: Palette) {
  return StyleSheet.create({
  header: { minHeight: 48, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 14 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9, flexShrink: 1 },
  mark: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.blue },
  markText: { color: palette.onBlue, fontSize: 21, fontWeight: '800', fontStyle: 'italic' },
  name: { color: palette.ink, fontSize: 15, lineHeight: 18, fontWeight: '800' },
  product: { color: palette.muted, fontSize: 10, lineHeight: 14, fontWeight: '800', letterSpacing: 0.6 },
  });
}
