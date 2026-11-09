import { useCallback, useEffect, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import { AppState, Keyboard, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { NativeButton } from '@/components/native-button';
import { formatBusinessPercentage } from '@/lib/business-percentage';
import { palette } from '@/lib/palette';
import { canReadActivityClipboard, readActivityClipboard, usableEndDate } from '@/lib/paypal-activity-clipboard';
import { watchReportLifecycle } from '@/lib/report-lifecycle';
import {
  type PayPalActivityOptions,
  type PayPalActivityPeriod,
  type PayPalActivitySummary,
} from '@/lib/paypal-activity-import';
import { useAppearanceStyles, usePalette } from '@/lib/theme-context';

type DateOrder = '' | PayPalActivityOptions['dateOrder'];
type TimeZone = '' | PayPalActivityOptions['timeZone'];
type WindowDays = 0 | 7 | 30;

const timeZones = [
  { value: 'utc', label: 'UTC / GMT', detail: 'UTC or GMT' },
  { value: 'london', label: 'UK', detail: 'GMT or BST' },
  { value: 'eastern', label: 'Eastern', detail: 'EST or EDT' },
  { value: 'central', label: 'Central', detail: 'CST or CDT' },
  { value: 'mountain', label: 'Mountain', detail: 'MST or MDT' },
  { value: 'arizona', label: 'Arizona', detail: 'MST (Phoenix)' },
  { value: 'pacific', label: 'Pacific', detail: 'PST or PDT' },
  { value: 'alaska', label: 'Alaska', detail: 'AKST or AKDT (Anchorage)' },
  { value: 'hawaii', label: 'Hawaii', detail: 'HST' },
] as const;

function count(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function PeriodCard({ title, period }: { title: string; period: PayPalActivityPeriod }) {
  const styles = useAppearanceStyles(baseStyles);
  const excluded = period.otherEvent + period.notCompleted + period.notCredit;
  return <View style={styles.period} accessible accessibilityLabel={`${title}. ${count(period.included)} included checkout credit rows. ${period.startDate} to before ${period.endExclusive} UTC. ${count(excluded)} other rows excluded.`}>
    <Text style={styles.periodTitle}>{title}</Text>
    <Text style={styles.periodCount}>{count(period.included)}</Text>
    <Text style={styles.periodDetail}>Included checkout credit rows</Text>
    <Text style={styles.periodDetail}>{period.startDate} to before {period.endExclusive} UTC</Text>
    <Text style={styles.periodDetail}>{count(excluded)} other rows excluded</Text>
  </View>;
}

export function PayPalActivityPanel({ onReportChange }: { onReportChange: (summary: PayPalActivitySummary | null) => void }) {
  const styles = useAppearanceStyles(baseStyles);
  const colors = usePalette();
  const [open, setOpen] = useState(false);
  const [dateOrder, setDateOrder] = useState<DateOrder>('');
  const [timeZone, setTimeZone] = useState<TimeZone>('');
  const [windowDays, setWindowDays] = useState<WindowDays>(0);
  const [endExclusive, setEndExclusive] = useState('');
  const [privacyConfirmed, setPrivacyConfirmed] = useState(false);
  const [coverageConfirmed, setCoverageConfirmed] = useState(false);
  const [summary, setSummary] = useState<PayPalActivitySummary | null>(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [todayUtc, setTodayUtc] = useState('');
  const revision = useRef(0);
  const readingRef = useRef(false);

  const clearPreview = useCallback(() => {
    revision.current += 1;
    readingRef.current = false;
    setReading(false);
    setSummary(null);
    setError('');
    setCoverageConfirmed(false);
    onReportChange(null);
  }, [onReportChange]);

  const resetPanel = useCallback(() => {
    clearPreview();
    setOpen(false);
    setDateOrder('');
    setTimeZone('');
    setWindowDays(0);
    setEndExclusive('');
    setPrivacyConfirmed(false);
    setCoverageConfirmed(false);
    setTodayUtc('');
  }, [clearPreview]);

  useFocusEffect(useCallback(() => {
    setTodayUtc(new Date().toISOString().slice(0, 10));
    return resetPanel;
  }, [resetPanel]));

  useEffect(() => {
    if (Platform.OS === 'web') return;
    return watchReportLifecycle(
      (listener) => AppState.addEventListener('change', listener),
      resetPanel,
      () => setTodayUtc(new Date().toISOString().slice(0, 10)),
    );
  }, [resetPanel]);

  const isNative = Platform.OS === 'android' || Platform.OS === 'ios';
  const endDateValid = usableEndDate(endExclusive, todayUtc);
  const choices = { native: isNative, dateOrder, timeZone, windowDays, endExclusive, privacyConfirmed, coverageConfirmed };
  const ready = canReadActivityClipboard(choices, todayUtc);

  async function readCopiedText() {
    if (!ready || readingRef.current) return;
    const current = ++revision.current;
    readingRef.current = true;
    setReading(true);
    setError('');
    // A coverage confirmation applies to this copy only, even if reading is cancelled.
    setCoverageConfirmed(false);
    Keyboard.dismiss();
    try {
      // The reader is called only after this explicit action and confirmations.
      const result = await readActivityClipboard(choices, Clipboard.getStringAsync, () => current === revision.current, Date.now);
      if (current !== revision.current) return;
      if (result.kind === 'error') setError(result.message);
      else if (result.kind === 'success') {
        setSummary(result.summary);
        onReportChange(result.summary);
      }
    } catch {
      if (current === revision.current) setError('The copied text could not be read. Your device may not support a clipboard this large.');
    } finally {
      if (current === revision.current) {
        readingRef.current = false;
        setReading(false);
      }
    }
  }

  function changeOption(action: () => void) {
    clearPreview();
    action();
  }
  function changeCriteria(action: () => void) {
    clearPreview();
    setCoverageConfirmed(false);
    action();
  }

  return <View style={styles.panel}>
    <Pressable accessibilityRole="button" accessibilityLabel={open ? 'Hide PayPal activity preview' : 'Show PayPal activity preview'} accessibilityState={{ expanded: open }} onPress={() => { if (open) clearPreview(); setOpen(!open); }} style={({ pressed }) => [styles.heading, pressed && styles.pressed]}>
      <View style={styles.headingCopy}>
        <Text style={styles.eyebrow}>OPTIONAL · SEPARATE PREVIEW</Text>
        <Text style={styles.title} accessibilityRole="header">Review PayPal activity.</Text>
        <Text style={styles.subtitle}>A narrow checkout-count preview from text you choose to copy.</Text>
      </View>
      <Text style={styles.toggle} aria-hidden>{open ? '−' : '+'}</Text>
    </Pressable>

    {open && <View style={styles.content}>
      {!isNative ? <Text style={styles.copy}>The pasted-text preview is available in the mobile app. On the website, use the separate PayPal activity file preview.</Text> : <>
        <Text style={styles.copy}>This self-provided, unverified preview covers one PayPal account. It is not a connected account or complete sales report. The app reads copied text on this device and does not upload or save the pasted report.</Text>
        <View style={styles.privacy}>
          <Text style={styles.privacyTitle}>Your export may contain personal information.</Text>
          <Text style={styles.copy}>Names, email addresses and transaction IDs may be present. The clipboard, operating system, keyboard or other apps may retain or expose copied text. The app does not clear your clipboard. Only continue if you are authorized and accept these risks.</Text>
          <Text style={styles.copy}>The app cannot verify the original file’s UTF-8 bytes or whether every row was copied. Copy the complete text from one unsplit export you have checked. The clipboard is read before its size can be checked and large copies may fail; use the website file preview for larger reports.</Text>
        </View>
        <Text style={styles.copy}>Use a PayPal Activity Download with Date, Time, TimeZone, Status, Transaction Event Code, Balance Impact and Transaction ID. Use two-digit dates, 24-hour HH:MM:SS times and English statuses and impact values. ZIP and split exports are unsupported.</Text>
        <Text style={styles.copy}>Only T0006 and T0007 rows marked Completed and Credit are counted. Other rows are excluded. Amounts, refunds, unique customers and retention are not calculated.</Text>

        <Text style={styles.label}>Date format in the copied export</Text>
        <View style={styles.optionRow}>
          {([['dmy', 'Day / month / year (UK)'], ['mdy', 'Month / day / year (US)']] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: dateOrder === value, disabled: reading }} disabled={reading} onPress={() => changeCriteria(() => setDateOrder(value))} style={({ pressed }) => [styles.option, dateOrder === value && styles.optionSelected, pressed && styles.pressed]}><Text style={[styles.optionText, dateOrder === value && styles.optionTextSelected]}>{label}</Text></Pressable>)}
        </View>

        <Text style={styles.label}>Time zone used by the export</Text>
        <View style={styles.optionRow}>
          {timeZones.map(({ value, label, detail }) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`${label}: ${detail}`} accessibilityState={{ checked: timeZone === value, disabled: reading }} disabled={reading} onPress={() => changeCriteria(() => setTimeZone(value))} style={({ pressed }) => [styles.option, timeZone === value && styles.optionSelected, pressed && styles.pressed]}><Text style={[styles.optionText, timeZone === value && styles.optionTextSelected]}>{label}</Text></Pressable>)}
        </View>
        <Text style={styles.hint}>Select the actual report time zone, not your device time zone. {timeZone ? `Rows must use ${timeZones.find((zone) => zone.value === timeZone)?.detail}. ` : ''}Regional times before 2007, and ambiguous or missing daylight-saving times, are rejected.</Text>

        <Text style={styles.label}>Length of each period</Text>
        <View style={styles.optionRow}>
          {([7, 30] as const).map((days) => <Pressable key={days} accessibilityRole="radio" accessibilityLabel={`${days} days`} accessibilityState={{ checked: windowDays === days, disabled: reading }} disabled={reading} onPress={() => changeCriteria(() => setWindowDays(days))} style={({ pressed }) => [styles.option, windowDays === days && styles.optionSelected, pressed && styles.pressed]}><Text style={[styles.optionText, windowDays === days && styles.optionTextSelected]}>{days} days</Text></Pressable>)}
        </View>

        <Text style={styles.label}>First day after the current period, in UTC</Text>
        <TextInput
          accessibilityLabel="First day after the current period, in UTC"
          accessibilityHint="Enter the date as year, month, day. It must be today or earlier in UTC."
          value={endExclusive}
          onChangeText={(value) => changeCriteria(() => setEndExclusive(value))}
          editable={!reading}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          maxLength={10}
          style={styles.dateInput}
        />
        <Text style={styles.hint}>The current period ends just before this day; the previous period is the same length immediately before it. A local-time export may need extra dates at either end to cover both full UTC periods. Check your device clock.</Text>
        {endExclusive && !endDateValid ? <Text style={styles.errorText} accessibilityRole="alert">Enter a valid date no later than today in UTC.</Text> : null}

        <View style={styles.confirmation}>
          <Switch value={privacyConfirmed} disabled={reading} onValueChange={(value) => changeOption(() => setPrivacyConfirmed(value))} accessibilityLabel="I am authorized to use this report and understand the clipboard may retain or expose personal information" />
          <Text style={styles.confirmationText}>I am authorized to use this report and understand the clipboard may retain or expose personal information.</Text>
        </View>
        <View style={styles.confirmation}>
          <Switch value={coverageConfirmed} disabled={reading} onValueChange={setCoverageConfirmed} accessibilityLabel="I copied every row from one unsplit export covering both complete UTC periods" />
          <Text style={styles.confirmationText}>I copied every row from one unsplit export covering both complete UTC periods.</Text>
        </View>

        <View style={styles.actions}>
          <NativeButton label={reading ? 'Reading copied text…' : 'Read copied text'} variant="filled" onPress={() => void readCopiedText()} disabled={!ready || reading} />
          {summary && <NativeButton label="Clear PayPal preview" onPress={clearPreview} disabled={reading} />}
        </View>
        <Text style={styles.hint}>One copied CSV · Up to 4 MiB and 50,000 rows · No raw rows shown. Device limits may be lower. Confirm coverage before each read.</Text>
        {reading ? <Text style={styles.hint} accessibilityLiveRegion="polite">Reading copied text…</Text> : null}
        {error ? <View style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite"><Text style={styles.errorText}>{error}{summary ? ' The previous preview remains displayed.' : ''}</Text></View> : null}

        {summary && <View style={styles.report}>
          <Text style={styles.eyebrow}>SELF-PROVIDED · UNVERIFIED · NOT LIVE</Text>
          <Text style={styles.reportTitle} accessibilityRole="header">Selected PayPal checkout activity</Text>
          <Text style={styles.copy}>These are matching report rows, not unique customers or complete sales. Coverage and copy completeness rely on your confirmation.</Text>
          <PeriodCard title="Previous period" period={summary.previous} />
          <PeriodCard title="Current period" period={summary.current} />
          <Text style={styles.change}>Included row change: {summary.changePct === null ? 'Unavailable — previous included count is zero' : formatBusinessPercentage(summary.changePct, true)}</Text>
          <Text style={styles.hint}>{count(summary.rowsInFile)} rows read; {count(summary.outsidePeriods)} outside the selected periods. Exclusions include other event types, statuses and non-credit rows. No individual rows, names, email addresses, IDs or amounts are shown.</Text>
          <Text style={styles.hint}>The preview clears when you leave Business, the app receives a background notification, or you choose Clear PayPal preview. The clipboard is not cleared; system snapshots may retain a copy.</Text>
        </View>}
      </>}
    </View>}
  </View>;
}

const baseStyles = StyleSheet.create({
  panel: { marginTop: 20, borderRadius: 18, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, overflow: 'hidden' },
  heading: { minHeight: 92, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 12 },
  headingCopy: { flex: 1 },
  eyebrow: { color: '#486A8F', fontSize: 10, lineHeight: 15, fontWeight: '800', letterSpacing: 0.8 },
  title: { color: '#16365A', fontSize: 19, lineHeight: 25, fontWeight: '800', marginTop: 4 },
  subtitle: { color: '#526B83', fontSize: 13, lineHeight: 19, marginTop: 5 },
  toggle: { color: '#1765B7', fontSize: 25, lineHeight: 30, fontWeight: '500' },
  content: { paddingHorizontal: 18, paddingBottom: 20, gap: 12 },
  copy: { color: '#3E5874', fontSize: 13, lineHeight: 20 },
  privacy: { padding: 14, borderRadius: 12, borderWidth: 1, borderColor: '#E8D2AD', backgroundColor: '#FFF9EF', gap: 8 },
  privacyTitle: { color: '#694720', fontSize: 14, lineHeight: 20, fontWeight: '800' },
  label: { color: '#183D65', fontSize: 13, lineHeight: 19, fontWeight: '700', marginTop: 4 },
  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: { minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: '#C9D9EA', backgroundColor: '#FFFFFF', paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center' },
  optionSelected: { borderColor: palette.blue, backgroundColor: palette.blueWash },
  optionText: { color: '#375B7E', fontSize: 13, lineHeight: 19, fontWeight: '600' },
  optionTextSelected: { color: '#0055A6', fontWeight: '800' },
  dateInput: { minHeight: 48, borderWidth: 1, borderColor: '#C7D8E9', borderRadius: 10, backgroundColor: '#F8FAFD', paddingHorizontal: 12, paddingVertical: 9, color: '#17395D', fontSize: 15 },
  hint: { color: '#61758C', fontSize: 12, lineHeight: 18 },
  confirmation: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  confirmationText: { flex: 1, color: '#294967', fontSize: 13, lineHeight: 19 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  error: { padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#EBC2BB', backgroundColor: '#FFF3F0' },
  errorText: { color: '#923E35', fontSize: 12, lineHeight: 18 },
  report: { marginTop: 4, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#E3EBF5', gap: 11 },
  reportTitle: { color: '#16365A', fontSize: 18, lineHeight: 24, fontWeight: '800' },
  period: { padding: 14, borderRadius: 12, borderWidth: 1, borderColor: '#DBE7F4', backgroundColor: '#F7FAFE', gap: 3 },
  periodTitle: { color: '#416280', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  periodCount: { color: '#123A68', fontSize: 26, lineHeight: 31, fontWeight: '800' },
  periodDetail: { color: '#536B84', fontSize: 12, lineHeight: 18 },
  change: { color: '#234C75', fontSize: 13, lineHeight: 20, fontWeight: '700' },
  pressed: { opacity: 0.72 },
});
