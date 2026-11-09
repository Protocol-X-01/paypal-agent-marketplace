import { useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { filterDisplayCurrencies } from '@/lib/currency';
import { useData } from '@/lib/data-context';
import { palette } from '@/lib/palette';
import { useAppearanceStyles, usePalette } from '@/lib/theme-context';

export function CurrencyPicker() {
  const styles = useAppearanceStyles(baseStyles);
  const colors = usePalette();
  const { currency, currencyReady, setCurrency } = useData();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const matches = filterDisplayCurrencies(query);

  function closePicker() {
    Keyboard.dismiss();
    setOpen(false);
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Display currency, ${currency}`}
        accessibilityHint="Choose the currency used for portfolio and market values."
        accessibilityState={{ disabled: !currencyReady, expanded: open }}
        disabled={!currencyReady}
        onPress={() => { setQuery(''); setOpen(true); }}
        style={({ pressed }) => [styles.trigger, !currencyReady && styles.disabled, pressed && styles.pressed]}>
        <Text style={styles.triggerText}>{currency}</Text>
        <Text style={styles.triggerCaption}>display</Text>
        <Text style={styles.chevron} accessibilityElementsHidden>⌄</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={closePicker}>
        <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}>
          <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Close currency selection" onPress={closePicker} />
          <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.sheet} accessibilityViewIsModal>
            <View style={styles.heading}>
              <View style={styles.headingText}>
                <Text accessibilityRole="header" style={styles.title}>Display currency</Text>
                <Text style={styles.description}>Choose how values appear on this device.</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Close currency selection" onPress={closePicker} style={styles.closeButton}>
                <Text style={styles.closeText}>×</Text>
              </Pressable>
            </View>
            <View style={styles.searchField}>
              <Text style={styles.searchIcon} accessibilityElementsHidden importantForAccessibility="no">⌕</Text>
              <TextInput
                accessibilityLabel="Search currencies by name or code"
                value={query}
                onChangeText={setQuery}
                placeholder="Search name or code"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                maxLength={60}
                style={styles.searchInput}
              />
              {query.length > 0 && (
                <Pressable accessibilityRole="button" accessibilityLabel="Clear currency search" onPress={() => setQuery('')} style={styles.clearButton}>
                  <Text style={styles.clearText}>×</Text>
                </Pressable>
              )}
            </View>
            <ScrollView style={styles.list} accessibilityRole="radiogroup" accessibilityLabel="Display currencies" keyboardShouldPersistTaps="always" keyboardDismissMode="on-drag">
              {matches.map((item) => (
                <Pressable
                  key={item.code}
                  accessibilityRole="radio"
                  accessibilityLabel={`${item.code}, ${item.name}`}
                  accessibilityState={{ checked: currency === item.code }}
                  aria-checked={Platform.OS === 'web' ? currency === item.code : undefined}
                  onPress={() => {
                    setCurrency(item.code);
                    closePicker();
                  }}
                  style={({ pressed }) => [styles.option, currency === item.code && styles.selectedOption, pressed && styles.pressed]}>
                  <View style={styles.optionCopy}>
                    <Text style={styles.optionCode}>{item.code}</Text>
                    <Text style={styles.optionName}>{item.name}</Text>
                  </View>
                  {currency === item.code && <Text style={styles.checkmark} accessibilityElementsHidden>✓</Text>}
                </Pressable>
              ))}
              {matches.length === 0 && (
                <View style={styles.empty} accessibilityRole="summary" accessibilityLiveRegion="polite">
                  <Text style={styles.emptyTitle}>No currencies found</Text>
                  <Text style={styles.emptyText}>Try another name or three-letter code.</Text>
                  <Pressable accessibilityRole="button" onPress={() => setQuery('')} style={styles.emptyClear}>
                    <Text style={styles.emptyClearText}>Clear search</Text>
                  </Pressable>
                </View>
              )}
            </ScrollView>
            <Text style={styles.footnote}>Reference values change; payment and wallet currencies stay the same.</Text>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

export function CurrencyPreferenceNotice() {
  const styles = useAppearanceStyles(baseStyles);
  const { currencyStatus } = useData();
  if (currencyStatus !== 'invalid' && currencyStatus !== 'unavailable') return null;
  return (
    <Text style={styles.notice} accessibilityRole="summary" accessibilityLiveRegion="polite">
      {currencyStatus === 'invalid'
        ? 'The saved display currency could not be read. Choose a currency to save a new preference.'
        : 'Your saved display currency could not be confirmed. Check your choice for this session.'}
    </Text>
  );
}

const baseStyles = StyleSheet.create({
  trigger: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 24, backgroundColor: palette.blueWash },
  triggerText: { color: palette.navy, fontSize: 12, lineHeight: 18, fontWeight: '800' },
  triggerCaption: { color: palette.muted, fontSize: 11, lineHeight: 17, fontWeight: '600' },
  chevron: { color: palette.navy, fontSize: 16, lineHeight: 20, fontWeight: '700' },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.7 },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(8, 31, 55, 0.48)' },
  sheet: { width: '100%', maxWidth: 560, maxHeight: '88%', alignSelf: 'center', backgroundColor: palette.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 18 },
  heading: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  headingText: { flex: 1 },
  title: { color: palette.ink, fontSize: 21, lineHeight: 28, fontWeight: '800' },
  description: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 3 },
  closeButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, backgroundColor: '#F1F5F9' },
  closeText: { color: '#142C4E', fontSize: 24, lineHeight: 30 },
  searchField: { minHeight: 48, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#CAD8E7', backgroundColor: '#F8FAFD', borderRadius: 14, marginBottom: 10, paddingLeft: 13 },
  searchIcon: { color: '#526B83', fontSize: 22, lineHeight: 28, marginRight: 8 },
  searchInput: { flex: 1, minHeight: 48, paddingVertical: 8, color: '#142C4E', fontSize: 14 },
  clearButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  clearText: { color: '#526B83', fontSize: 22, lineHeight: 28 },
  list: { flexShrink: 1 },
  option: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12 },
  selectedOption: { backgroundColor: palette.blueWash },
  optionCopy: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  optionCode: { width: 45, color: '#142C4E', fontSize: 14, lineHeight: 20, fontWeight: '800' },
  optionName: { flex: 1, color: '#526B83', fontSize: 13, lineHeight: 19 },
  checkmark: { color: palette.blue, fontSize: 20, fontWeight: '800' },
  empty: { alignItems: 'flex-start', paddingHorizontal: 12, paddingVertical: 18 },
  emptyTitle: { color: '#142C4E', fontSize: 14, lineHeight: 20, fontWeight: '800' },
  emptyText: { color: '#526B83', fontSize: 13, lineHeight: 19, marginTop: 4 },
  emptyClear: { minHeight: 48, justifyContent: 'center', paddingRight: 14 },
  emptyClearText: { color: palette.blue, fontSize: 13, fontWeight: '700' },
  footnote: { color: '#526B83', fontSize: 11, lineHeight: 16, paddingVertical: 12 },
  notice: { color: '#6C5122', backgroundColor: '#FFF7E8', borderRadius: 12, padding: 10, marginBottom: 14, fontSize: 11, lineHeight: 16 },
});
