import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CustomerPrivateBoundary } from '@/components/customer-private-boundary';
import { MarketHeader } from '@/components/market-header';
import { validateVenmoDraftAmount, VENMO_DRAFT_AMOUNT_MAX_LENGTH } from '@/lib/venmo-draft-amount';
import { createVenmoSendIntent, discardVenmoSendIntent } from '@/lib/venmo-send-intent';
import type { Palette } from '@/lib/palette';
import { useResponsiveLayout } from '@/lib/responsive-layout';
import { usePalette, useThemedStyles } from '@/lib/theme-context';

const SUGGESTED_AMOUNTS = ['10', '25', '50', '100'];

function amountMessage(amount: ReturnType<typeof validateVenmoDraftAmount>): string | null {
  if (amount.kind === 'incomplete') return 'Finish the amount before continuing.';
  if (amount.kind !== 'invalid') return null;
  if (amount.reason === 'precision') return 'Use no more than two decimal places.';
  if (amount.reason === 'length') return 'Use no more than 32 characters.';
  if (amount.reason === 'zero') return 'Enter an amount greater than $0.00.';
  return 'Use digits and one decimal point or comma.';
}

function SendContent() {
  const styles = useThemedStyles(createStyles);
  const colors = usePalette();
  const layout = useResponsiveLayout();
  const [amount, setAmount] = useState('');
  const [handoffMessage, setHandoffMessage] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const handoffPendingRef = useRef(false);
  const pendingIntentIdRef = useRef<string | null>(null);
  const parsedAmount = validateVenmoDraftAmount(amount);
  const validationMessage = amount ? amountMessage(parsedAmount) : null;
  const canContinue = parsedAmount.kind === 'valid';

  useFocusEffect(useCallback(() => {
    return () => {
      handoffPendingRef.current = false;
      setAmount('');
      setHandoffMessage(null);
      setHandoffBusy(false);
    };
  }, []));

  useEffect(() => {
    const clearPrivateEntry = () => {
      if (pendingIntentIdRef.current) discardVenmoSendIntent(pendingIntentIdRef.current);
      pendingIntentIdRef.current = null;
      handoffPendingRef.current = false;
      setAmount('');
      setHandoffMessage(null);
      setHandoffBusy(false);
    };
    const stateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') clearPrivateEntry();
    });
    const blurSubscription = Platform.OS === 'android'
      ? AppState.addEventListener('blur', clearPrivateEntry)
      : null;
    return () => {
      stateSubscription.remove();
      blurSubscription?.remove();
    };
  }, []);

  const continueToDraft = () => {
    if (!canContinue || handoffPendingRef.current) return;
    handoffPendingRef.current = true;
    setHandoffBusy(true);
    const sendIntent = createVenmoSendIntent(amount);
    if (!sendIntent) {
      handoffPendingRef.current = false;
      setHandoffBusy(false);
      setHandoffMessage('A previous draft is still being prepared. Return to Contacts & draft and try again.');
      return;
    }
    pendingIntentIdRef.current = sendIntent;
    try {
      router.push({ pathname: '/portfolio', params: { sendIntent } });
      setAmount('');
      setHandoffMessage(null);
    } catch {
      discardVenmoSendIntent(sendIntent);
      pendingIntentIdRef.current = null;
      handoffPendingRef.current = false;
      setHandoffBusy(false);
      setHandoffMessage('Could not open the contact draft. Try again.');
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          contentContainerStyle={[styles.content, layout.wideCanvas && styles.contentWide]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <MarketHeader showCurrencyControls={false} />

          <View style={styles.titleBlock}>
            <Text style={styles.kicker}>PAYMENTS</Text>
            <Text accessibilityRole="header" style={styles.pageTitle}>Send</Text>
            <Text style={styles.subtitle}>Start a USD contact draft.</Text>
          </View>

          <View style={styles.amountCard}>
            <Text style={styles.fieldLabel}>Amount</Text>
            <View style={[styles.amountField, Boolean(validationMessage) && styles.amountFieldInvalid]}>
              <Text style={styles.currencySymbol} importantForAccessibility="no">$</Text>
              <TextInput
                accessibilityLabel="Amount in US dollars"
                accessibilityHint="This amount is carried to a local Venmo draft. It does not send money."
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="decimal-pad"
                maxLength={VENMO_DRAFT_AMOUNT_MAX_LENGTH}
                onChangeText={(next) => {
                  setAmount(next);
                  setHandoffMessage(null);
                }}
                placeholder="0.00"
                placeholderTextColor={colors.muted}
                returnKeyType="done"
                value={amount}
                style={styles.amountInput}
              />
              <Text style={styles.currencyCode}>USD</Text>
            </View>
            {validationMessage
              ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.amountError}>{validationMessage}</Text>
              : <Text style={styles.currencyHint}>US dollars</Text>}

            <View style={styles.suggestions} accessibilityLabel="Suggested amounts">
              {SUGGESTED_AMOUNTS.map((suggestion) => {
                const selected = amount === suggestion;
                return (
                  <Pressable
                    key={suggestion}
                    accessibilityRole="button"
                    accessibilityLabel={`Set amount to $${suggestion}`}
                    accessibilityState={{ selected }}
                    onPress={() => {
                      setAmount(suggestion);
                      setHandoffMessage(null);
                    }}
                    style={({ pressed }) => [styles.suggestion, selected && styles.suggestionSelected, pressed && styles.pressed]}
                  >
                    <Text style={[styles.suggestionText, selected && styles.suggestionTextSelected]}>${suggestion}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.contactCard}>
            <View style={styles.contactMark} importantForAccessibility="no"><Text style={styles.contactMarkText}>↗</Text></View>
            <View style={styles.contactCopy}>
              <Text style={styles.contactTitle}>Choose a contact</Text>
              <Text style={styles.contactDescription}>Select or add a contact, then review your note.</Text>
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Continue to contacts and Venmo draft"
            accessibilityHint="Carries this amount to your local draft. Nothing is sent or opened in Venmo."
            accessibilityState={{ disabled: !canContinue || handoffBusy }}
            disabled={!canContinue || handoffBusy}
            onPress={continueToDraft}
            style={({ pressed }) => [styles.primaryButton, (!canContinue || handoffBusy) && styles.buttonDisabled, pressed && canContinue && !handoffBusy && styles.pressed]}
          >
            <Text style={styles.primaryButtonText}>{handoffBusy ? 'Opening draft…' : 'Continue to contacts'}</Text>
          </Pressable>
          {handoffMessage && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.amountError}>{handoffMessage}</Text>}
          <Text style={styles.disclosure}>Draft only · Review and copy it yourself. No payment is sent.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default function SendScreen() {
  return <CustomerPrivateBoundary><SendContent /></CustomerPrivateBoundary>;
}

function createStyles(palette: Palette) {
  return StyleSheet.create({
    flex: { flex: 1 },
    safeArea: { flex: 1, backgroundColor: palette.canvas },
    content: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 6, paddingBottom: 34 },
    contentWide: { maxWidth: 900 },
    titleBlock: { marginBottom: 18 },
    kicker: { color: palette.aqua, fontSize: 10, lineHeight: 15, fontWeight: '800', letterSpacing: 1, marginBottom: 3 },
    pageTitle: { color: palette.ink, fontSize: 32, lineHeight: 39, fontWeight: '800', letterSpacing: -0.4 },
    subtitle: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 4 },
    amountCard: { backgroundColor: palette.surface, borderColor: palette.line, borderWidth: 1, borderRadius: 20, padding: 18, marginBottom: 14 },
    fieldLabel: { color: palette.ink, fontSize: 13, lineHeight: 18, fontWeight: '700', marginBottom: 9 },
    amountField: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: palette.ice, borderColor: palette.line, borderWidth: 1, borderRadius: 15, paddingHorizontal: 15 },
    amountFieldInvalid: { borderColor: palette.negative },
    currencySymbol: { color: palette.muted, fontSize: 25, lineHeight: 32, fontWeight: '700' },
    amountInput: { minWidth: 70, flex: 1, paddingVertical: 10, color: palette.ink, fontSize: 32, lineHeight: 40, fontWeight: '800', fontVariant: ['tabular-nums'] },
    currencyCode: { color: palette.muted, fontSize: 12, lineHeight: 18, fontWeight: '800', letterSpacing: 0.5 },
    currencyHint: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 7 },
    amountError: { color: palette.negative, fontSize: 11, lineHeight: 16, marginTop: 7 },
    suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 15 },
    suggestion: { minWidth: 64, minHeight: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 13, borderRadius: 13, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface },
    suggestionSelected: { borderColor: palette.blue, backgroundColor: palette.blueWash },
    suggestionText: { color: palette.ink, fontSize: 12, lineHeight: 17, fontWeight: '700' },
    suggestionTextSelected: { color: palette.link },
    contactCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: palette.surface, borderColor: palette.line, borderWidth: 1, borderRadius: 18, padding: 15, marginBottom: 14 },
    contactMark: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: palette.blueWash },
    contactMarkText: { color: palette.link, fontSize: 22, lineHeight: 27, fontWeight: '700' },
    contactCopy: { flex: 1, gap: 2 },
    contactTitle: { color: palette.ink, fontSize: 13, lineHeight: 18, fontWeight: '800' },
    contactDescription: { color: palette.muted, fontSize: 11, lineHeight: 16 },
    primaryButton: { minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: palette.blue, paddingHorizontal: 16, paddingVertical: 12 },
    primaryButtonText: { color: palette.onBlue, fontSize: 14, lineHeight: 20, fontWeight: '800' },
    buttonDisabled: { opacity: 0.5 },
    pressed: { opacity: 0.75 },
    disclosure: { color: palette.muted, fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 10 },
  });
}
