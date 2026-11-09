import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatLiteMoney, liteClosingAmount, liteCurrencyDigits, liteMonthsToTarget, parseLiteMoney, roundedPortfolioMinor } from '@/lib/personal-accounting-lite';
import type { DisplayCurrency } from '@/lib/currency';
import { palette } from '@/lib/palette';
import { useAppearanceStyles, usePalette } from '@/lib/theme-context';

type Props = { currency: DisplayCurrency; portfolioTotal: number | null; portfolioAvailable: boolean };

function MoneyField({ label, value, onChange, currency }: { label: string; value: string; onChange: (value: string) => void; currency: string }) {
  const styles = useAppearanceStyles(baseStyles);
  const colors = usePalette();
  const parsed = parseLiteMoney(value, currency);
  const error = value.length > 32 ? 'Enter no more than 32 characters.' : parsed.kind === 'invalid' ? 'Use a non-negative amount with a decimal point and this currency’s precision.' : parsed.kind === 'incomplete' ? 'Finish the amount.' : '';
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label} · {currency}</Text><TextInput accessibilityLabel={`${label} in ${currency}`} accessibilityHint={error || 'Use digits and a decimal point; do not use thousands separators.'} value={value} onChangeText={onChange} keyboardType="decimal-pad" inputMode="decimal" autoCorrect={false} autoComplete="off" placeholder="0" placeholderTextColor={colors.muted} style={[styles.input, parsed.kind === 'invalid' && styles.invalid]} />{error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}</View>;
}

function Session({ currency, portfolioTotal, portfolioAvailable }: Props) {
  const styles = useAppearanceStyles(baseStyles);
  const [source, setSource] = useState<'manual' | 'portfolio'>('manual');
  const [startText, setStartText] = useState('');
  const [incomeText, setIncomeText] = useState('');
  const [spendingText, setSpendingText] = useState('');
  const [targetText, setTargetText] = useState('');
  const [monthlyText, setMonthlyText] = useState('');
  const portfolio = portfolioAvailable ? roundedPortfolioMinor(portfolioTotal, currency) : null;
  const digits = liteCurrencyDigits(currency);
  const manual = parseLiteMoney(startText, currency);
  const start = source === 'manual' ? manual.kind === 'valid' ? manual.minor : null : portfolio;
  const income = parseLiteMoney(incomeText, currency);
  const spending = parseLiteMoney(spendingText, currency);
  const target = parseLiteMoney(targetText, currency);
  const monthly = parseLiteMoney(monthlyText, currency);
  const closing = start !== null && income.kind === 'valid' && spending.kind === 'valid' ? liteClosingAmount(start, income.minor, spending.minor) : null;
  const months = start !== null && target.kind === 'valid' && monthly.kind === 'valid' ? liteMonthsToTarget(start, target.minor, monthly.minor) : null;
  const needsContribution = start !== null && target.kind === 'valid' && monthly.kind === 'valid' && target.minor > start && months === null;
  const duration = months === null ? '—' : months === BigInt(0) ? 'Target reached' : `${months.toString()} ${months === BigInt(1) ? 'month' : 'months'}`;

  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.eyebrow}>PERSONAL · PLAYGROUND</Text><Text style={styles.title} accessibilityRole="header">Explore a simple plan.</Text><Text style={styles.subtitle}>Try hypothetical amounts without changing your money or your portfolio.</Text>
    <View style={styles.source}><Text style={styles.sourceTitle}>Choose a starting amount</Text><Text style={styles.help}>No connected cash balance is available in this preview.</Text><Text style={styles.help}>{currency}: {digits === null ? 'currency precision unavailable' : digits === 0 ? 'whole units only' : `up to ${digits} decimal places`}. Use a decimal point without thousands separators.</Text><View style={styles.options}>
      <Pressable accessibilityRole="button" accessibilityLabel="Enter a starting amount" accessibilityState={{ selected: source === 'manual' }} onPress={() => setSource('manual')} style={[styles.option, source === 'manual' && styles.optionSelected]}><Text style={styles.optionText}>Enter an amount</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Use portfolio estimate as a hypothetical starting amount" accessibilityState={{ selected: source === 'portfolio', disabled: portfolio === null }} disabled={portfolio === null} onPress={() => setSource('portfolio')} style={[styles.option, source === 'portfolio' && styles.optionSelected, portfolio === null && styles.optionDisabled]}><Text style={styles.optionText}>Use portfolio estimate</Text></Pressable>
    </View>{source === 'manual' ? <MoneyField label="Starting amount" value={startText} onChange={setStartText} currency={currency} /> : <Text style={styles.help}>{portfolio === null ? 'The complete portfolio estimate is unavailable.' : `Rounded estimate: ${formatLiteMoney(portfolio, currency)}. This is not a cash balance.`}</Text>}<Text style={styles.help}>A portfolio estimate is optional and may include crypto value; it is not cash.</Text></View>
    <View style={styles.calculator}><Text style={styles.eyebrow}>CASH FLOW SCENARIO</Text><Text style={styles.sectionTitle} accessibilityRole="header">Plan what remains.</Text><Text style={styles.help}>Add expected income and spending for one period.</Text><MoneyField label="Planned income" value={incomeText} onChange={setIncomeText} currency={currency} /><MoneyField label="Planned spending" value={spendingText} onChange={setSpendingText} currency={currency} /><View style={styles.result} accessibilityLiveRegion="polite"><Text style={styles.resultLabel}>Scenario closing amount</Text><Text style={styles.resultValue}>{closing === null ? '—' : formatLiteMoney(closing, currency)}</Text><Text style={styles.help}>{closing === null ? 'Complete all three amounts to calculate.' : 'Starting amount + income − spending'}</Text></View></View>
    <View style={styles.calculator}><Text style={styles.eyebrow}>SAVINGS SCENARIO</Text><Text style={styles.sectionTitle} accessibilityRole="header">Set a target.</Text><Text style={styles.help}>See how long a fixed monthly contribution could take.</Text><MoneyField label="Savings target" value={targetText} onChange={setTargetText} currency={currency} /><MoneyField label="Monthly contribution" value={monthlyText} onChange={setMonthlyText} currency={currency} /><View style={styles.result} accessibilityLiveRegion="polite"><Text style={styles.resultLabel}>Estimated time</Text><Text style={styles.resultValue}>{duration}</Text><Text style={styles.help}>{needsContribution ? 'Enter a monthly contribution greater than zero.' : 'Assumes a fixed contribution, with no interest or returns.'}</Text></View></View>
    <Text style={styles.footnote}>Scenarios are hypothetical, not investment advice. Values reset when you leave Account, switch views, or change currency.</Text>
  </ScrollView></KeyboardAvoidingView>;
}

export function PersonalAccountingLite(props: Props) { return <Session key={props.currency} {...props} />; }

const baseStyles = StyleSheet.create({
  flex: { flex: 1 },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 36 },
  eyebrow: { color: '#41658E', fontSize: 10, lineHeight: 15, fontWeight: '800', letterSpacing: 0.8 },
  title: { color: palette.navy, fontSize: 27, lineHeight: 33, fontWeight: '800', marginTop: 5 },
  subtitle: { color: '#526B83', fontSize: 13, lineHeight: 20, marginTop: 6 },
  source: { padding: 16, borderRadius: 16, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.ice, marginTop: 20 },
  sourceTitle: { color: '#15385D', fontSize: 14, lineHeight: 20, fontWeight: '800' },
  help: { color: '#526B83', fontSize: 12, lineHeight: 18, marginTop: 5 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 13 },
  option: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: palette.line, borderRadius: 10, backgroundColor: palette.surface },
  optionSelected: { borderColor: palette.blue, backgroundColor: palette.blueWash },
  optionDisabled: { opacity: 0.45 },
  optionText: { color: '#315981', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  calculator: { padding: 16, borderRadius: 16, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, marginTop: 14 },
  sectionTitle: { color: '#15385D', fontSize: 17, lineHeight: 23, fontWeight: '800', marginTop: 3 },
  field: { marginTop: 12 },
  fieldLabel: { color: '#31536F', fontSize: 11, lineHeight: 17, fontWeight: '700', marginBottom: 5 },
  input: { minHeight: 46, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderColor: '#C9D9EA', borderRadius: 10, backgroundColor: '#FFFFFF', color: '#15385D', fontSize: 15 },
  invalid: { borderColor: '#B95543' },
  error: { color: '#963E32', fontSize: 11, lineHeight: 16, marginTop: 4 },
  result: { padding: 14, borderRadius: 11, backgroundColor: palette.blueWash, marginTop: 15 },
  resultLabel: { color: '#526B83', fontSize: 11, lineHeight: 16 },
  resultValue: { color: '#123D71', fontSize: 20, lineHeight: 26, fontWeight: '800', fontVariant: ['tabular-nums'], marginTop: 4 },
  footnote: { color: '#526B83', fontSize: 11, lineHeight: 17, marginTop: 15 },
});
