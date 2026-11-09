import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState, Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NativeButton } from '@/components/native-button';
import { CustomerPrivateBoundary } from '@/components/customer-private-boundary';
import { CustomerSessionPanel } from '@/components/customer-session-panel';
import { AppearancePicker } from '@/components/appearance-picker';
import { useCustomerSession } from '@/lib/customer-session-context';
import { PayPalActivityPanel } from '@/components/paypal-activity-panel';
import { BusinessPeriodComparison } from '@/components/business-period-comparison';
import { PersonalAccountingLite } from '@/components/personal-accounting-lite';
import { formatBusinessPercentage } from '@/lib/business-percentage';
import { adjustBusinessThreshold, DEFAULT_BUSINESS_THRESHOLDS, evaluateBusinessThresholds, isValidBusinessThresholds, MAX_REFUND_THRESHOLD_PCT, MIN_REFUND_THRESHOLD_PCT, type BusinessThresholdResult, type BusinessThresholds } from '@/lib/business-thresholds';
import { createBusinessThresholdPreferencesRepository } from '@/lib/business-threshold-preferences';
import { useData } from '@/lib/data-context';
import { hasHoldingInputIssue, previewHoldingInputs } from '@/lib/holding-input';
import { estimatePortfolio } from '@/lib/portfolio-value';
import { palette } from '@/lib/palette';
import { useResponsiveLayout } from '@/lib/responsive-layout';
import { watchReportLifecycle } from '@/lib/report-lifecycle';
import type { PayPalActivitySummary } from '@/lib/paypal-activity-import';
import {
  BUSINESS_SNAPSHOT_CHANNEL_LABELS,
  BUSINESS_SNAPSHOT_MAX_BYTES,
  createBusinessSnapshotReport,
  formatBusinessMinorAmount,
  parseBusinessSnapshot,
  type BusinessSnapshot,
  type BusinessSnapshotPeriodName,
  type BusinessSnapshotProvenance,
} from '@/lib/business-snapshot';
import { useAppearanceStyles, usePalette } from '@/lib/theme-context';

type Perspective = 'teams' | 'leadership';
type ThresholdStorageState = 'loading' | 'ready' | 'saving' | 'resetting' | 'unreadable' | 'unavailable';
type ThresholdStorageView = {
  preferences: ReturnType<typeof createBusinessThresholdPreferencesRepository> | null;
  state: ThresholdStorageState;
  notice: string;
};

const EXAMPLE = `window_days,period,start_date,end_exclusive,channel,currency,transactions,gross_minor,refund_minor,source_updated_at
7,previous,2026-10-23,2026-10-30,online,GBP,100,100000,2000,2026-11-06T00:00:00Z
7,current,2026-10-30,2026-11-06,online,GBP,120,120000,3000,2026-11-06T00:00:00Z`;

function amount(value: number, currency: string): string {
  return formatBusinessMinorAmount(value, currency);
}

function count(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  const styles = useAppearanceStyles(baseStyles);
  return (
    <View style={styles.statCard} accessible accessibilityLabel={`${label}: ${value}. ${detail}`}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statDetail}>{detail}</Text>
    </View>
  );
}

function BusinessThresholdControl({
  label,
  description,
  value,
  min,
  max,
  disabled,
  onDecrease,
  onIncrease,
  onSet,
}: {
  label: string;
  description: string;
  value: number | null;
  min: number;
  max: number;
  disabled: boolean;
  onDecrease: () => void;
  onIncrease: () => void;
  onSet: (value: number) => void;
}) {
  const styles = useAppearanceStyles(baseStyles);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const valueLabel = value === null ? 'unavailable' : `${value}%`;
  function commitValue(text: string) {
    setEditing(false);
    const parsed = Number(text.trim());
    if (Number.isInteger(parsed) && parsed >= min && parsed <= max && parsed !== value) onSet(parsed);
  }
  return (
    <View style={styles.thresholdControlRow}>
      <View style={styles.thresholdControlCopy}>
        <Text style={styles.thresholdControlLabel}>{label}</Text>
        <Text style={styles.thresholdControlDescription}>{description}</Text>
      </View>
      <View style={styles.thresholdStepper}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Decrease ${label} threshold`} accessibilityHint="Changes the saved threshold by one step." accessibilityState={{ disabled }} disabled={disabled} onPress={onDecrease} style={({ pressed }) => [styles.thresholdStepButton, disabled && styles.thresholdStepButtonDisabled, pressed && styles.pressed]}>
          <Text style={styles.thresholdStepText}>−</Text>
        </Pressable>
        {value === null ? <Text style={styles.thresholdValue} accessibilityLabel={`${label} threshold: ${valueLabel}`}>—</Text> : <>
          <TextInput
            style={styles.thresholdValueInput}
            accessibilityLabel={`${label} threshold percentage`}
        accessibilityHint={`Enter a whole percentage from ${min} to ${max}.`}
            value={editing ? draft : String(value)}
            editable={!disabled}
            keyboardType="number-pad"
            returnKeyType="done"
            selectTextOnFocus
            onFocus={() => { setEditing(true); setDraft(String(value)); }}
            onChangeText={(text) => setDraft(text.replace(/[^0-9]/g, '').slice(0, String(max).length))}
            onEndEditing={(event) => commitValue(event.nativeEvent.text)}
          />
          <Text style={styles.thresholdPercent}>%</Text>
        </>}
        <Pressable accessibilityRole="button" accessibilityLabel={`Increase ${label} threshold`} accessibilityHint="Changes the saved threshold by one step." accessibilityState={{ disabled }} disabled={disabled} onPress={onIncrease} style={({ pressed }) => [styles.thresholdStepButton, disabled && styles.thresholdStepButtonDisabled, pressed && styles.pressed]}>
          <Text style={styles.thresholdStepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function thresholdOutcomeLabel(signal: 'activity' | 'refund', result: BusinessThresholdResult) {
  if (result.status === 'unavailable') return 'Unavailable';
  if (signal === 'activity') return result.status === 'notice' ? 'Drop threshold reached' : 'No drop at selected level';
  return result.status === 'notice' ? 'Refund threshold reached' : 'Below refund threshold';
}

function BusinessThresholdResultCard({ signal, label, result, detail }: { signal: 'activity' | 'refund'; label: string; result: BusinessThresholdResult; detail: string }) {
  const styles = useAppearanceStyles(baseStyles);
  const statusText = thresholdOutcomeLabel(signal, result);
  const statusStyle = result.status === 'notice' ? styles.thresholdStatusNotice : result.status === 'clear' ? styles.thresholdStatusClear : styles.thresholdStatusUnavailable;
  return (
    <View style={styles.thresholdResultCard} accessible accessibilityLiveRegion="polite" accessibilityLabel={`${label}: ${statusText}. ${detail}`}>
      <Text style={styles.thresholdResultLabel}>{label}</Text>
      <Text style={statusStyle}>{statusText}</Text>
      <Text style={styles.thresholdResultDetail}>{detail}</Text>
    </View>
  );
}

function PeriodRows({ snapshot, period }: { snapshot: BusinessSnapshot; period: BusinessSnapshotPeriodName }) {
  const styles = useAppearanceStyles(baseStyles);
  const range = snapshot.periods[period];
  const rows = snapshot.rows.filter((row) => row.period === period);
  const periodLabel = period === 'current' ? 'Current period' : 'Previous period';
  return (
    <View style={styles.periodBlock}>
      <View style={styles.periodHeading}>
        <Text style={styles.periodTitle} accessibilityRole="header">{periodLabel}</Text>
        <Text style={styles.periodDates}>{range.startDate} to before {range.endExclusive} UTC</Text>
      </View>
      {rows.map((row) => (
        <View key={`${period}-${row.channel}`} style={styles.channelRow} accessible accessibilityLabel={`${BUSINESS_SNAPSHOT_CHANNEL_LABELS[row.channel]}. ${count(row.transactions)} transactions. Gross ${amount(row.grossMinor, snapshot.currency)}. Refunds ${amount(row.refundMinor, snapshot.currency)}.`}>
          <View style={styles.channelHeading}>
            <Text style={styles.channelTitle}>{BUSINESS_SNAPSHOT_CHANNEL_LABELS[row.channel]}</Text>
            <Text style={styles.channelCount}>{count(row.transactions)} transactions</Text>
          </View>
          <View style={styles.channelAmounts}>
            <Text style={styles.channelDetail}>Gross <Text style={styles.channelAmount}>{amount(row.grossMinor, snapshot.currency)}</Text></Text>
            <Text style={styles.channelDetail}>Refunds <Text style={styles.channelAmount}>{amount(row.refundMinor, snapshot.currency)}</Text></Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export function BusinessContent() {
  const styles = useAppearanceStyles(baseStyles);
  const colors = usePalette();
  const layout = useResponsiveLayout();
  const customerSession = useCustomerSession();
  const thresholdPreferences = useMemo(
    () => createBusinessThresholdPreferencesRepository(customerSession.storageFence),
    [customerSession.storageFence],
  );
  const [perspective, setPerspective] = useState<Perspective>('teams');
  const [csv, setCsv] = useState('');
  const [snapshot, setSnapshot] = useState<BusinessSnapshot | null>(null);
  const [reportProvenance, setReportProvenance] = useState<BusinessSnapshotProvenance | null>(null);
  const [reportAttestedAt, setReportAttestedAt] = useState<string | null>(null);
  const reportAttestationAccepted = reportAttestedAt !== null;
  const [reportKind, setReportKind] = useState<'self' | 'example' | null>(null);
  const reportKindRef = useRef<'self' | 'example' | null>(null);
  const [paypalReport, setPayPalReport] = useState<PayPalActivitySummary | null>(null);
  const paypalReportRef = useRef<PayPalActivitySummary | null>(null);
  const [error, setError] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const [sourceAfterDeviceClock, setSourceAfterDeviceClock] = useState(false);
  const [pointOfSaleError, setPointOfSaleError] = useState('');
  const [businessThresholds, setBusinessThresholds] = useState<BusinessThresholds>(DEFAULT_BUSINESS_THRESHOLDS);
  const businessThresholdsRef = useRef<BusinessThresholds>(DEFAULT_BUSINESS_THRESHOLDS);
  const [thresholdStorage, setThresholdStorage] = useState<ThresholdStorageView>({ preferences: null, state: 'loading', notice: '' });
  const [resetThresholdsArmed, setResetThresholdsArmed] = useState(false);
  const thresholdWriteRevisionRef = useRef(0);

  const applyThresholdRead = useCallback((result: Awaited<ReturnType<typeof thresholdPreferences.read>>) => {
    if (result.status === 'ready') {
      businessThresholdsRef.current = result.thresholds;
      setBusinessThresholds(result.thresholds);
      setResetThresholdsArmed(false);
      setThresholdStorage({
        preferences: thresholdPreferences,
        state: 'ready',
        notice: result.source === 'saved'
          ? 'Saved thresholds loaded from this device for the current workspace.'
          : 'Using default thresholds. Changes are saved on this device for the current workspace.',
      });
    } else if (result.status === 'unreadable') {
      setThresholdStorage({ preferences: thresholdPreferences, state: 'unreadable', notice: 'Saved threshold preferences could not be read and were left unchanged. Checks are unavailable.' });
    } else {
      setThresholdStorage({ preferences: thresholdPreferences, state: 'unavailable', notice: 'Threshold storage is unavailable. No report checks are shown.' });
    }
  }, [thresholdPreferences]);

  const loadThresholdPreferences = useCallback(async (isActive: () => boolean, showLoading = false) => {
    const revision = ++thresholdWriteRevisionRef.current;
    if (showLoading) {
      setResetThresholdsArmed(false);
      setThresholdStorage({ preferences: thresholdPreferences, state: 'loading', notice: 'Checking what is saved on this device…' });
    }
    try {
      const result = await thresholdPreferences.read();
      if (!isActive() || !thresholdPreferences.isCurrent() || revision !== thresholdWriteRevisionRef.current) return;
      applyThresholdRead(result);
    } catch {
      if (isActive() && thresholdPreferences.isCurrent() && revision === thresholdWriteRevisionRef.current) {
        setThresholdStorage({ preferences: thresholdPreferences, state: 'unavailable', notice: 'Threshold storage is unavailable. No report checks are shown.' });
      }
    }
  }, [applyThresholdRead, thresholdPreferences]);

  useEffect(() => {
    let active = true;
    const revision = ++thresholdWriteRevisionRef.current;
    void thresholdPreferences.read().then((result) => {
      if (!active || !thresholdPreferences.isCurrent() || revision !== thresholdWriteRevisionRef.current) return;
      applyThresholdRead(result);
    }).catch(() => {
      if (active && thresholdPreferences.isCurrent() && revision === thresholdWriteRevisionRef.current) {
        setThresholdStorage({ preferences: thresholdPreferences, state: 'unavailable', notice: 'Threshold storage is unavailable. No report checks are shown.' });
      }
    });
    return () => { active = false; };
  }, [applyThresholdRead, thresholdPreferences]);

  const clearReport = useCallback(() => {
    setCsv('');
    setSnapshot(null);
    setReportProvenance(null);
    setReportAttestedAt(null);
    setReportKind(null);
    reportKindRef.current = null;
    setError('');
    setSourceAfterDeviceClock(false);
    Keyboard.dismiss();
  }, []);

  const onPayPalReportChange = useCallback((summary: PayPalActivitySummary | null) => {
    paypalReportRef.current = summary;
    setPayPalReport(summary);
    if (summary && reportKindRef.current === 'example') {
      reportKindRef.current = null;
      setSnapshot(null);
      setReportProvenance(null);
      setReportAttestedAt(null);
      setReportKind(null);
      setSourceAfterDeviceClock(false);
    }
  }, []);

  // Expo Router tabs may remain mounted after navigation. Clear screen state
  // on blur rather than relying on unmount for report privacy.
  useFocusEffect(useCallback(() => () => {
    clearReport();
    paypalReportRef.current = null;
    setPayPalReport(null);
    setGuideOpen(false);
  }, [clearReport]));

  useEffect(() => {
    if (Platform.OS === 'web') return;
    return watchReportLifecycle(
      (listener) => AppState.addEventListener('change', listener),
      () => { clearReport(); paypalReportRef.current = null; setPayPalReport(null); setGuideOpen(false); },
    );
  }, [clearReport]);

  const stats = snapshot ? {
      transactions: { label: 'Transactions', value: count(snapshot.periods.current.transactions), detail: 'Current period · not unique customers' },
      change: { label: 'Activity change', value: formatBusinessPercentage(snapshot.summary.transactionChangePct, true), detail: snapshot.summary.transactionChangePct === null ? 'Previous count is zero' : 'Compared with the previous period' },
      gross: { label: 'Gross volume', value: amount(snapshot.periods.current.grossMinor, snapshot.currency), detail: `Current period · ${snapshot.currency}` },
      refunds: { label: 'Refund ratio', value: formatBusinessPercentage(snapshot.summary.refundRatioPct), detail: snapshot.summary.refundRatioPct === null ? 'Current gross volume is zero' : 'Refund amount divided by gross volume' },
    } : null;
  const paypalOnly = !snapshot && paypalReport !== null;
  const activityLabel = paypalOnly ? 'Included checkout rows' : 'Report activity';
  const activityValue = paypalOnly ? count(paypalReport.current.included) : stats?.transactions.value ?? '—';
  const activityDetail = paypalOnly ? 'Completed credit rows · current period' : stats ? 'Current period' : 'Choose a report';
  const grossDetail = snapshot ? snapshot.currency : paypalOnly ? 'Not calculated from this export' : 'Not a balance';
  const refundDetail = stats ? 'Refunds ÷ gross' : paypalOnly ? 'Not calculated from this export' : 'Choose a report';
  const order = perspective === 'teams' ? ['transactions', 'gross', 'refunds', 'change'] as const : ['change', 'refunds', 'gross', 'transactions'] as const;
  const currentThresholdStorage = thresholdStorage.preferences === thresholdPreferences ? thresholdStorage : null;
  const thresholdStorageState = currentThresholdStorage?.state ?? 'loading';
  const thresholdStorageNotice = currentThresholdStorage?.notice ?? '';
  const thresholdStorageReady = thresholdStorageState === 'ready' || thresholdStorageState === 'saving';
  const thresholdEvaluation = snapshot && thresholdStorageReady
    ? evaluateBusinessThresholds(snapshot.summary, businessThresholds)
    : null;
  const sampleDisabled = reportKind === 'self' || paypalReport !== null;
  const sampleHelp = reportKind === 'self' && paypalReport ? 'Clear both reports first.'
    : reportKind === 'self' ? 'Clear the aggregate report first.'
      : paypalReport ? 'Clear the PayPal preview first.'
        : 'Fictional figures · no account access.';

  function viewReport() {
    if (!reportAttestationAccepted || !reportAttestedAt) {
      setError('Confirm that you are authorized to use this report and have checked its period coverage before viewing it.');
      return;
    }
    const result = parseBusinessSnapshot(csv);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const clock = Platform.OS === 'web' ? 'browser-device-clock' : 'native-device-clock';
    const importedReport = createBusinessSnapshotReport(result.snapshot, reportAttestedAt, new Date().toISOString(), clock);
    setSnapshot(importedReport.snapshot);
    setReportProvenance(importedReport.provenance);
    setReportAttestedAt(null);
    reportKindRef.current = 'self';
    setReportKind('self');
    setSourceAfterDeviceClock(Date.parse(result.snapshot.sourceUpdatedAt) > Date.now());
    setCsv('');
    setError('');
    Keyboard.dismiss();
  }

  function viewExample() {
    if (paypalReportRef.current || reportKindRef.current === 'self') return;
    const result = parseBusinessSnapshot(EXAMPLE);
    if (!result.ok) {
      setError('The fictional example is unavailable on this device.');
      return;
    }
    setSnapshot(result.snapshot);
    setReportProvenance(null);
    setReportAttestedAt(null);
    reportKindRef.current = 'example';
    setReportKind('example');
    setSourceAfterDeviceClock(Date.parse(result.snapshot.sourceUpdatedAt) > Date.now());
    setError('');
    Keyboard.dismiss();
  }

  function saveBusinessThresholds(next: BusinessThresholds) {
    if ((thresholdStorageState !== 'ready' && thresholdStorageState !== 'saving') || !isValidBusinessThresholds(next)) return;
    if (next.activityDropPct === businessThresholdsRef.current.activityDropPct && next.refundSharePct === businessThresholdsRef.current.refundSharePct) return;
    businessThresholdsRef.current = next;
    setBusinessThresholds(next);
    setThresholdStorage({ preferences: thresholdPreferences, state: 'saving', notice: 'Saving these device-only thresholds…' });
    const revision = ++thresholdWriteRevisionRef.current;
    void thresholdPreferences.save(next).then((result) => {
      if (!thresholdPreferences.isCurrent() || revision !== thresholdWriteRevisionRef.current) return;
      if (result.status === 'saved') {
        setThresholdStorage({ preferences: thresholdPreferences, state: 'ready', notice: 'Threshold preferences saved on this device for the current workspace.' });
      } else {
        // A failed write may have reached storage. Read back before enabling
        // edits so the displayed values match the persisted values again.
        void loadThresholdPreferences(() => true, true);
      }
    }).catch(() => {
      if (thresholdPreferences.isCurrent() && revision === thresholdWriteRevisionRef.current) {
        void loadThresholdPreferences(() => true, true);
      }
    });
  }

  function setBusinessThreshold(field: keyof BusinessThresholds, value: number) {
    if (thresholdStorageState !== 'ready' && thresholdStorageState !== 'saving') return;
    const next = { ...businessThresholdsRef.current, [field]: value };
    if (!isValidBusinessThresholds(next)) return;
    saveBusinessThresholds(next);
  }

  function changeBusinessThreshold(field: keyof BusinessThresholds, direction: -1 | 1) {
    if (thresholdStorageState !== 'ready' && thresholdStorageState !== 'saving') return;
    saveBusinessThresholds(adjustBusinessThreshold(businessThresholdsRef.current, field, direction));
  }

  async function resetUnreadableThresholds() {
    if (thresholdStorageState !== 'unreadable') return;
    const revision = ++thresholdWriteRevisionRef.current;
    setThresholdStorage({ preferences: thresholdPreferences, state: 'resetting', notice: 'Removing only the unreadable threshold setting…' });
    try {
      await thresholdPreferences.resetIfUnreadable();
      if (!thresholdPreferences.isCurrent() || revision !== thresholdWriteRevisionRef.current) return;
      await loadThresholdPreferences(() => true, true);
    } catch {
      if (thresholdPreferences.isCurrent() && revision === thresholdWriteRevisionRef.current) {
        await loadThresholdPreferences(() => true, true);
      }
    }
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={[]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[styles.content, layout.wideCanvas && styles.contentWide]} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.brandRow}>
            <View style={styles.brand} accessible accessibilityLabel="PayPal Markets concept">
              <View style={styles.brandMark}><Text style={styles.brandMarkText}>P</Text></View>
              <View><Text style={styles.brandName}>PayPal</Text><Text style={styles.brandProduct}>MARKETS · CONCEPT</Text></View>
            </View>
            <Text style={styles.topBadge}>BUSINESS</Text>
          </View>

          <View style={styles.intro}>
            <Text style={styles.eyebrow}>PAYPAL BUSINESS</Text>
            <Text style={styles.pageTitle} accessibilityRole="header">Your business, in view.</Text>
            <Text style={styles.pageSubtitle}>Activity reports · preview only.</Text>
          </View>

          <View style={layout.pairedPanels ? styles.businessHeroPanels : undefined}>
          <View style={layout.pairedPanels ? styles.businessNoticePanel : undefined}>
          <View style={styles.connectionCard}>
            <View style={styles.connectionIcon}><Text style={styles.connectionIconText}>i</Text></View>
            <View style={styles.connectionCopy}>
              <Text style={styles.connectionTitle}>No PayPal business account connected</Text>
              <Text style={styles.connectionText}>{reportKind === 'self' || paypalReport ? 'Self-provided · unverified · not a live balance.' : reportKind === 'example' ? 'Fictional sample data.' : 'Fictional or authorized reports only.'}</Text>
            </View>
          </View>
          </View>

          <View style={layout.pairedPanels ? styles.businessOverviewPanel : undefined}>
          <View style={styles.businessOverview}>
            <View style={styles.businessOverviewTop}>
              <View><Text style={styles.businessBalanceLabel}>PAYPAL BALANCE</Text><Text style={styles.businessBalance} accessibilityLabel="Balance unavailable">—</Text></View>
              <Text style={styles.businessSource}>{reportKind === 'example' ? 'FICTIONAL EXAMPLE' : reportKind === 'self' ? 'AGGREGATE CSV · UNVERIFIED' : paypalOnly ? 'PAYPAL EXPORT · UNVERIFIED' : 'ACCOUNT PREVIEW'}</Text>
            </View>
            <View style={styles.businessMetrics}>
              <View style={styles.businessMetric} accessible accessibilityLabel={`${activityLabel}: ${activityValue === '—' ? 'unavailable' : activityValue}. ${activityDetail}.`}><Text style={styles.businessMetricLabel}>{activityLabel}</Text><Text style={styles.businessMetricValue}>{activityValue}</Text><Text style={styles.businessMetricNote}>{activityDetail}</Text></View>
              <View style={styles.businessMetric} accessible accessibilityLabel={`Gross activity: ${stats?.gross.value ?? 'unavailable'}. ${grossDetail}.`}><Text style={styles.businessMetricLabel}>Gross activity</Text><Text style={styles.businessMetricValue}>{stats?.gross.value ?? '—'}</Text><Text style={styles.businessMetricNote}>{grossDetail}</Text></View>
              <View style={styles.businessMetric} accessible accessibilityLabel={`Refund ratio: ${stats?.refunds.value ?? 'unavailable'}. ${refundDetail}.`}><Text style={styles.businessMetricLabel}>Refund ratio</Text><Text style={styles.businessMetricValue}>{stats?.refunds.value ?? '—'}</Text><Text style={styles.businessMetricNote}>{refundDetail}</Text></View>
            </View>
          </View>
          </View>
          </View>

          <Pressable accessibilityRole="link" accessibilityLabel="Explore PayPal Business tools, US information" accessibilityHint="Opens PayPal's website" onPress={() => { setPointOfSaleError(''); void Linking.openURL('https://www.paypal.com/us/business').catch(() => setPointOfSaleError('Could not open PayPal Business information.')); }} style={({ pressed }) => [styles.posLink, pressed && styles.pressed]}>
            <View style={styles.posCopy}><Text style={styles.posTitle}>Get paid</Text><Text style={styles.posSubtitle}>Business tools · US</Text></View><Text style={styles.posArrow} aria-hidden>↗</Text>
          </Pressable>
          <Pressable accessibilityRole="link" accessibilityLabel="Explore PayPal Point of Sale, US information" accessibilityHint="Opens PayPal's website" onPress={() => { setPointOfSaleError(''); void Linking.openURL('https://www.paypal.com/us/business/pos').catch(() => setPointOfSaleError('Could not open PayPal Point of Sale information.')); }} style={({ pressed }) => [styles.posLink, pressed && styles.pressed]}>
            <View style={styles.posCopy}><Text style={styles.posTitle}>In-person sales</Text><Text style={styles.posSubtitle}>Point of Sale · US</Text></View><Text style={styles.posArrow} aria-hidden>↗</Text>
          </Pressable>
          {pointOfSaleError ? <Text style={styles.errorText} accessibilityRole="alert">{pointOfSaleError}</Text> : null}

          <View style={styles.audienceSection}>
            <Text style={styles.perspectiveLabel}>Report view</Text>
            <View style={styles.perspectiveRow}>
              <Pressable accessibilityRole="button" accessibilityLabel="Activity" accessibilityState={{ selected: perspective === 'teams' }} onPress={() => setPerspective('teams')} style={({ pressed }) => [styles.perspectiveButton, perspective === 'teams' && styles.perspectiveSelected, pressed && styles.pressed]}><Text style={[styles.perspectiveText, perspective === 'teams' && styles.perspectiveTextSelected]}>Activity</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Summary" accessibilityState={{ selected: perspective === 'leadership' }} onPress={() => setPerspective('leadership')} style={({ pressed }) => [styles.perspectiveButton, perspective === 'leadership' && styles.perspectiveSelected, pressed && styles.pressed]}><Text style={[styles.perspectiveText, perspective === 'leadership' && styles.perspectiveTextSelected]}>Summary</Text></Pressable>
            </View>
            <Text style={styles.perspectiveHelp}>{perspective === 'teams' ? 'Activity first.' : 'Changes and refunds first.'}</Text>
          </View>

          <View style={styles.exampleAction}>
            <NativeButton label="Try fictional example" accessibilityLabel={sampleDisabled ? `Try fictional example. ${sampleHelp}` : undefined} onPress={viewExample} disabled={sampleDisabled} />
            <Text style={styles.exampleHelp}>{sampleHelp}</Text>
          </View>

          <View style={styles.sectionHeading}>
            <View style={styles.sectionCopy}><Text style={styles.eyebrow}>BUSINESS REPORTS</Text><Text style={styles.sectionTitle} accessibilityRole="header">Review an activity report.</Text></View>
            <Text style={styles.localBadge}>LOCAL ONLY</Text>
          </View>
          <Text style={styles.sectionSubtitle}>Two complete periods · broad channels only · no identifiers or small groups. Not live balances or customer counts.</Text>

          <View style={styles.entryCard}>
            <Text style={styles.entryTitle}>Aggregate CSV</Text>
            <Text style={styles.entryHelp}>Read on device, not uploaded or saved. Cleared on leaving Business or when the app backgrounds. Keyboard, clipboard or system snapshots may retain copies.</Text>
            <TextInput
              style={styles.csvInput}
              accessibilityLabel="Aggregate CSV report"
              accessibilityHint="Paste the header and matching previous and current aggregate rows. The text clears when you leave this screen."
              value={csv}
              onChangeText={(value) => { setCsv(value); setReportAttestedAt(null); setError(''); }}
              placeholder="Paste the CSV header and rows"
              placeholderTextColor={colors.muted}
              multiline
              textAlignVertical="top"
              autoCorrect={false}
              autoCapitalize="none"
              autoComplete="off"
              importantForAutofill="no"
              spellCheck={false}
              maxLength={BUSINESS_SNAPSHOT_MAX_BYTES + 1}
            />
            <Text style={styles.inputCaption}>Up to 16 KB · One currency · 7 or 30 day periods</Text>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel="I am authorized to use this aggregate CSV and have checked that it covers both complete periods. The app cannot verify the source, account, population, or actual coverage."
              accessibilityHint="Required to view the report. Editing the CSV clears this confirmation."
              accessibilityState={{ checked: reportAttestationAccepted }}
              onPress={() => { setReportAttestedAt((attestedAt) => attestedAt ? null : new Date().toISOString()); setError(''); }}
              style={({ pressed }) => [styles.attestation, reportAttestationAccepted && styles.attestationAccepted, pressed && styles.pressed]}
            >
              <View style={[styles.attestationBox, reportAttestationAccepted && styles.attestationBoxAccepted]}>
                {reportAttestationAccepted && <Text style={styles.attestationCheck} aria-hidden>✓</Text>}
              </View>
              <Text style={styles.attestationText}>I’m authorized to use this aggregate CSV and have checked that it covers both complete periods. The app cannot verify its source, account, population or actual coverage.</Text>
            </Pressable>
            {error ? <View style={styles.errorBox} accessibilityRole="alert" accessibilityLiveRegion="polite"><Text style={styles.errorText}>{error}{snapshot ? reportKind === 'example' ? ' The fictional example remains displayed.' : ' The previous report remains displayed.' : ''}</Text></View> : null}
            <View style={styles.actionRow}>
              <NativeButton label="View report" variant="filled" onPress={viewReport} disabled={!csv.trim() || !reportAttestationAccepted} />
              <NativeButton label={snapshot ? 'Clear report' : 'Clear text'} onPress={clearReport} disabled={!snapshot && !csv} />
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={guideOpen ? 'Hide report format' : 'Show report format'} accessibilityState={{ expanded: guideOpen }} onPress={() => setGuideOpen((open) => !open)} style={({ pressed }) => [styles.guideToggle, pressed && styles.pressed]}>
              <Text style={styles.guideToggleText}>{guideOpen ? '−  Hide report format' : '+  How to prepare a report'}</Text>
            </Pressable>
            {guideOpen && <View style={styles.guide}>
              <Text style={styles.guideText}>Include the exact columns shown below, with one previous and one current row for each included channel: online, in_person, or other. Periods must be consecutive and complete; end_exclusive is the first UTC day outside the period.</Text>
              <Text style={styles.guideText}>Amounts are whole minor units: 1250 is £12.50 in GBP. Use one ISO 4217 currency with a defined minor unit from the app’s September 2026 list and the same UTC source timestamp for every row, at or after the end of the current period. Each row supports up to one billion transactions and one trillion minor units.</Text>
              <Text style={styles.guideExampleLabel}>EXAMPLE FORMAT · FICTIONAL FIGURES</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled>
                <Text style={styles.guideExample} selectable>{EXAMPLE}</Text>
              </ScrollView>
            </View>}
          </View>

          {snapshot && stats && <View style={styles.report}>
            <View style={styles.reportTop}>
              <View style={styles.reportTopCopy}><Text style={styles.eyebrow}>{reportKind === 'example' ? 'FICTIONAL EXAMPLE · NOT LIVE' : 'SELF-PROVIDED · UNVERIFIED · NOT LIVE'}</Text><Text style={styles.reportTitle} accessibilityRole="header">{reportKind === 'example' ? 'Example: ' : ''}{perspective === 'teams' ? 'Activity report' : 'Report summary'}</Text></View>
              <Text style={styles.reportBadge}>{snapshot.windowDays}D · {snapshot.currency}</Text>
            </View>
            <Text style={styles.provenance}>{reportKind === 'example' ? 'Fictional source timestamp' : 'CSV-stated timestamp (not authenticated)'}: {snapshot.sourceUpdatedAt}. Dates use UTC; the end date is excluded.</Text>
            {reportKind === 'self' && reportProvenance && <>
              <View style={styles.trustGrid}>
                <View style={styles.trustItem}><Text style={styles.trustLabel}>Use permission</Text><Text style={styles.trustValue}>User-attested · not independently verified</Text></View>
                <View style={styles.trustItem}><Text style={styles.trustLabel}>Attested at</Text><Text style={styles.trustValue}>{reportProvenance.authorization.attestedAt} · {reportProvenance.authorization.clock === 'browser-device-clock' ? 'browser clock' : 'device clock'}</Text></View>
                <View style={styles.trustItem}><Text style={styles.trustLabel}>Source and account</Text><Text style={styles.trustValue}>Not authenticated</Text></View>
                <View style={styles.trustItem}><Text style={styles.trustLabel}>Population</Text><Text style={styles.trustValue}>Uploader-defined · not established</Text></View>
                <View style={styles.trustItem}><Text style={styles.trustLabel}>Period coverage</Text><Text style={styles.trustValue}>User-attested · source coverage unverified</Text></View>
                <View style={styles.trustItem}><Text style={styles.trustLabel}>Freshness</Text><Text style={styles.trustValue}>Unknown · source timestamp is unauthenticated</Text></View>
                <View style={styles.trustItem}><Text style={styles.trustLabel}>{reportProvenance.processedAt.basis === 'browser-device-clock' ? 'Processed in browser' : 'Processed on device'}</Text><Text style={styles.trustValue}>{reportProvenance.processedAt.value} · {reportProvenance.processedAt.basis === 'browser-device-clock' ? 'browser clock' : 'device clock'}</Text></View>
              </View>
            </>}
            {sourceAfterDeviceClock && <View style={styles.clockBox} accessibilityRole="alert"><Text style={styles.clockText}>The timestamp supplied in the CSV is later than the local {Platform.OS === 'web' ? 'browser' : 'device'} clock. It is unauthenticated; check the report and local time.</Text></View>}

            <View style={styles.statGrid}>{order.map((key) => <StatCard key={key} {...stats[key]} />)}</View>
            <BusinessPeriodComparison snapshot={snapshot} />
            <Text style={styles.reportNote}>{reportKind === 'example' ? 'These are fictional figures for exploring the layout.' : 'Amounts and dates are supplied by you and are not verified.'} Refunds can exceed gross volume. Transactions do not measure unique customers or retention.</Text>
            <PeriodRows snapshot={snapshot} period="current" />
            <PeriodRows snapshot={snapshot} period="previous" />
          </View>}

          <View style={styles.thresholdPanel}>
            <View style={styles.thresholdHeader}>
              <View style={styles.thresholdHeaderCopy}>
                <Text style={styles.eyebrow}>LOCAL REPORT CHECK</Text>
                <Text style={styles.thresholdTitle} accessibilityRole="header">Thresholds for this report</Text>
              </View>
              <Text style={styles.localBadge}>DEVICE ONLY</Text>
            </View>
            <Text style={styles.thresholdIntro}>Aggregate report checks only · no live monitoring or alerts.</Text>
            <View style={styles.thresholdControls}>
              <BusinessThresholdControl
                label="Activity drop"
                description="Transaction decrease between periods · 5-point steps"
                value={thresholdStorageReady ? businessThresholds.activityDropPct : null}
                min={5}
                max={50}
                disabled={!thresholdStorageReady}
                onDecrease={() => changeBusinessThreshold('activityDropPct', -1)}
                onIncrease={() => changeBusinessThreshold('activityDropPct', 1)}
                onSet={(value) => setBusinessThreshold('activityDropPct', value)}
              />
              <BusinessThresholdControl
                label="Refund ratio"
                description="Refunds ÷ gross · 5-point steps; can exceed 100%"
                value={thresholdStorageReady ? businessThresholds.refundSharePct : null}
                min={MIN_REFUND_THRESHOLD_PCT}
                max={MAX_REFUND_THRESHOLD_PCT}
                disabled={!thresholdStorageReady}
                onDecrease={() => changeBusinessThreshold('refundSharePct', -1)}
                onIncrease={() => changeBusinessThreshold('refundSharePct', 1)}
                onSet={(value) => setBusinessThreshold('refundSharePct', value)}
              />
            </View>
            <Text style={styles.thresholdStorageNotice} accessibilityLiveRegion="polite">{thresholdStorageNotice}</Text>
            {(thresholdStorageState === 'unreadable' || thresholdStorageState === 'unavailable') && (
              <View style={styles.thresholdRecoveryActions}>
                <Pressable accessibilityRole="button" accessibilityLabel="Retry reading local thresholds" onPress={() => void loadThresholdPreferences(() => true, true)} style={({ pressed }) => [styles.thresholdRecoveryButton, pressed && styles.pressed]}>
                  <Text style={styles.thresholdRecoveryButtonText}>Retry reading</Text>
                </Pressable>
                {thresholdStorageState === 'unreadable' && (resetThresholdsArmed ? (
                  <View style={styles.thresholdResetConfirmation}>
                    <Text style={styles.thresholdControlDescription}>This removes only the unreadable threshold preference for this workspace. Reports and other saved data stay untouched.</Text>
                    <View style={styles.thresholdResetButtons}>
                      <Pressable accessibilityRole="button" accessibilityLabel="Confirm reset of unreadable thresholds" onPress={() => void resetUnreadableThresholds()} style={({ pressed }) => [styles.thresholdRecoveryButton, styles.thresholdResetConfirm, pressed && styles.pressed]}>
                        <Text style={styles.thresholdResetConfirmText}>Reset threshold</Text>
                      </Pressable>
                      <Pressable accessibilityRole="button" accessibilityLabel="Cancel threshold reset" onPress={() => setResetThresholdsArmed(false)} style={({ pressed }) => [styles.thresholdRecoveryButton, pressed && styles.pressed]}>
                        <Text style={styles.thresholdRecoveryButtonText}>Keep it</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <Pressable accessibilityRole="button" accessibilityLabel="Review reset for unreadable threshold preference" onPress={() => setResetThresholdsArmed(true)} style={({ pressed }) => [styles.thresholdRecoveryButton, pressed && styles.pressed]}>
                    <Text style={styles.thresholdRecoveryButtonText}>Reset unreadable value…</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {thresholdEvaluation ? (
              <View style={styles.thresholdResults}>
                <BusinessThresholdResultCard
                  signal="activity"
                  label="Activity drop"
                  result={thresholdEvaluation.activityDrop}
                  detail={thresholdEvaluation.activityDrop.status === 'unavailable'
                    ? 'No change can be calculated because the previous period has zero transactions.'
                    : `Report change: ${formatBusinessPercentage(thresholdEvaluation.activityDrop.observedPct, true)} · threshold: ${businessThresholds.activityDropPct}% drop.`}
                />
                <BusinessThresholdResultCard
                  signal="refund"
                  label="Refund ratio"
                  result={thresholdEvaluation.refundShare}
                  detail={thresholdEvaluation.refundShare.status === 'unavailable'
                    ? 'No ratio can be calculated because current gross volume is zero.'
                    : `Report ratio: ${formatBusinessPercentage(thresholdEvaluation.refundShare.observedPct)} · threshold: ${businessThresholds.refundSharePct}%.`}
                />
              </View>
            ) : snapshot ? (
              <Text style={styles.thresholdEmpty}>Report checks are unavailable until this device can read the saved thresholds.</Text>
            ) : paypalReport ? (
              <Text style={styles.thresholdEmpty}>The PayPal Activity preview counts selected checkout rows only; it does not contain the gross and refund metrics needed for these checks. Use the aggregate report above.</Text>
            ) : (
              <Text style={styles.thresholdEmpty}>Choose an aggregate CSV report above to compare these limits with two periods of activity.</Text>
            )}
            {snapshot && <Text style={styles.thresholdFootnote}>{reportKind === 'example' ? 'Fictional report.' : 'Self-provided · unverified · cleared on leaving Business or when the app backgrounds.'} No customer counts or retention.</Text>}
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerTitle} accessibilityRole="header">Customer insights</Text>
            <View style={styles.customerSignal} accessible accessibilityLabel="Active customer accounts: unavailable">
              <Text style={styles.customerSignalLabel}>Active customer accounts</Text><Text style={styles.customerSignalStatus}>Unavailable</Text>
            </View>
            <View style={styles.customerSignal} accessible accessibilityLabel="Customer retention: unavailable">
              <Text style={styles.customerSignalLabel}>Customer retention</Text><Text style={styles.customerSignalStatus}>Unavailable</Text>
            </View>
            <Text style={styles.footerText}>Requires authorized data and approved definitions. No alerts.</Text>
          </View>

          <PayPalActivityPanel onReportChange={onPayPalReportChange} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default function AccountScreen() {
  const styles = useAppearanceStyles(baseStyles);
  return <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
    <CustomerSessionPanel />
    <View style={styles.appearanceSlot}><AppearancePicker /></View>
    <CustomerPrivateBoundary><AccountWorkspace /></CustomerPrivateBoundary>
  </SafeAreaView>;
}

export function AccountWorkspace() {
  const styles = useAppearanceStyles(baseStyles);
  const session = useCustomerSession();
  const layout = useResponsiveLayout();
  const [experience, setExperience] = useState<'personal' | 'business'>(() => session.identity?.accountType === 'business' ? 'business' : 'personal');
  const [sessionRevision, setSessionRevision] = useState(0);
  const { currency, holdings, holdingDrafts, overview, portfolioReady } = useData();
  useFocusEffect(useCallback(() => () => setSessionRevision((current) => current + 1), []));
  const preview = previewHoldingInputs({ holdings, drafts: holdingDrafts });
  const estimate = estimatePortfolio(preview, overview.data, portfolioReady);
  const portfolioAvailable = portfolioReady && !hasHoldingInputIssue(holdingDrafts) && estimate.state === 'ready' && estimate.estimatedValue !== null;

  return <View style={styles.flex}>
    <View style={[styles.accountChoice, experience === 'business' && layout.wideCanvas && styles.accountChoiceWide]}>
      <Text style={styles.accountChoiceLabel}>{session.status === 'authenticated' ? 'ACCOUNT TOOLS · PREVIEW VIEWS' : 'EXPLORE ACCOUNT PREVIEWS'}</Text>
      <View style={styles.accountChoiceOptions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Personal Lite view" accessibilityState={{ selected: experience === 'personal' }} onPress={() => setExperience('personal')} style={[styles.accountChoiceButton, experience === 'personal' && styles.accountChoiceSelected]}><Text style={styles.accountChoiceText}>Personal Lite</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Business preview" accessibilityHint="Uses fictional or self-provided reports; no PayPal business account is connected." accessibilityState={{ selected: experience === 'business' }} onPress={() => setExperience('business')} style={[styles.accountChoiceButton, experience === 'business' && styles.accountChoiceSelected]}><Text style={styles.accountChoiceText}>Business preview</Text></Pressable>
      </View>
      <Text style={styles.accountChoiceHint}>Fictional or self-provided reports · no PayPal connection.</Text>
    </View>
    {experience === 'personal' ? <PersonalAccountingLite key={`${currency}-${sessionRevision}`} currency={currency} portfolioTotal={portfolioAvailable ? estimate.estimatedValue : null} portfolioAvailable={portfolioAvailable} /> : <BusinessContent />}
  </View>;
}

const baseStyles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  flex: { flex: 1 },
  appearanceSlot: { width: '100%', alignItems: 'center', paddingHorizontal: 20 },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 36 },
  contentWide: { maxWidth: 1160 },
  accountChoice: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 10 },
  accountChoiceWide: { maxWidth: 1160 },
  businessHeroPanels: { flexDirection: 'row', alignItems: 'flex-start', gap: 20 },
  businessNoticePanel: { flex: 3, minWidth: 300, maxWidth: 380 },
  businessOverviewPanel: { flex: 6, minWidth: 540 },
  accountChoiceLabel: { color: '#526B83', fontSize: 10, lineHeight: 15, fontWeight: '800', letterSpacing: 0.7 },
  accountChoiceOptions: { flexDirection: 'row', gap: 5, backgroundColor: palette.blueWash, borderRadius: 12, padding: 4, marginTop: 5 },
  accountChoiceButton: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  accountChoiceSelected: { backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line },
  accountChoiceText: { color: '#315A83', fontSize: 12, lineHeight: 18, fontWeight: '800' },
  accountChoiceHint: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 5 },
  brandRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 18 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9, flexShrink: 1 },
  brandMark: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.blue },
  brandMarkText: { color: palette.surface, fontSize: 21, fontWeight: '800', fontStyle: 'italic' },
  brandName: { color: palette.navy, fontSize: 15, lineHeight: 18, fontWeight: '800' },
  brandProduct: { color: palette.muted, fontSize: 10, lineHeight: 14, fontWeight: '800', letterSpacing: 0.6 },
  topBadge: { color: '#315A83', backgroundColor: '#E7EFF9', overflow: 'hidden', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 7, fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  intro: { marginBottom: 18 },
  eyebrow: { color: '#496789', fontSize: 10, lineHeight: 15, fontWeight: '800', letterSpacing: 1 },
  pageTitle: { color: palette.navy, fontSize: 28, lineHeight: 34, fontWeight: '800', letterSpacing: -0.7, marginTop: 5 },
  pageSubtitle: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 7 },
  connectionCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, padding: 15, borderRadius: 16, backgroundColor: palette.blueWash, borderWidth: 1, borderColor: palette.line, marginBottom: 24 },
  connectionIcon: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#D7E8FB' },
  connectionIconText: { color: '#1C5BA4', fontSize: 15, fontWeight: '800' },
  connectionCopy: { flex: 1 },
  connectionTitle: { color: '#1B426C', fontSize: 13, lineHeight: 19, fontWeight: '800' },
  connectionText: { color: '#4D6581', fontSize: 12, lineHeight: 18, marginTop: 3 },
  businessOverview: { padding: 18, borderRadius: 18, backgroundColor: palette.navy, marginBottom: 24 },
  businessOverviewTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 },
  businessBalanceLabel: { color: '#D4E8FF', fontSize: 10, lineHeight: 15, fontWeight: '800', letterSpacing: 0.8 },
  businessBalance: { color: '#FFFFFF', fontSize: 31, lineHeight: 37, fontWeight: '800', marginTop: 4 },
  businessSource: { flexShrink: 1, color: '#FFFFFF', borderWidth: 1, borderColor: '#6B9AD0', borderRadius: 12, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 6, fontSize: 9, fontWeight: '800' },
  businessMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 18 },
  businessMetric: { flexGrow: 1, flexBasis: '29%', minWidth: 88, padding: 10, borderWidth: 1, borderColor: '#4679B7', borderRadius: 11, backgroundColor: '#164F9A' },
  businessMetricLabel: { color: '#D4E8FF', fontSize: 10, lineHeight: 15 },
  businessMetricValue: { color: '#FFFFFF', fontSize: 16, lineHeight: 22, fontWeight: '800', fontVariant: ['tabular-nums'], marginTop: 5 },
  businessMetricNote: { color: '#D4E8FF', fontSize: 10, lineHeight: 15, marginTop: 2 },
  posLink: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderWidth: 1, borderColor: '#DCE8F5', borderRadius: 13, backgroundColor: '#F8FBFF', marginBottom: 10 },
  posCopy: { flex: 1 },
  posTitle: { color: '#173F70', fontSize: 13, lineHeight: 19, fontWeight: '800' },
  posSubtitle: { color: '#526B83', fontSize: 11, lineHeight: 16, marginTop: 2 },
  posArrow: { color: '#175DAA', fontSize: 19, lineHeight: 24, fontWeight: '700' },
  sectionHeading: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  sectionCopy: { flex: 1 },
  sectionTitle: { color: '#16365A', fontSize: 20, lineHeight: 25, fontWeight: '800', letterSpacing: -0.3, marginTop: 3 },
  localBadge: { color: '#315A83', fontSize: 9, fontWeight: '800', letterSpacing: 0.5, paddingVertical: 6, paddingHorizontal: 8, backgroundColor: '#E5EFFB', borderRadius: 12, overflow: 'hidden' },
  sectionSubtitle: { color: '#526B83', fontSize: 13, lineHeight: 20, marginTop: 7, marginBottom: 14 },
  entryCard: { backgroundColor: palette.surface, borderColor: palette.line, borderWidth: 1, borderRadius: 18, padding: 16 },
  entryTitle: { color: '#17395D', fontSize: 15, lineHeight: 21, fontWeight: '800' },
  entryHelp: { color: '#526B83', fontSize: 12, lineHeight: 18, marginTop: 5, marginBottom: 12 },
  csvInput: { minHeight: 132, maxHeight: 240, paddingHorizontal: 12, paddingVertical: 12, color: '#17395D', backgroundColor: '#F8FAFD', borderColor: '#C7D8E9', borderWidth: 1, borderRadius: 12, fontSize: 13, lineHeight: 19 },
  inputCaption: { color: '#526B83', fontSize: 11, lineHeight: 16, marginTop: 7 },
  attestation: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 48, padding: 12, marginTop: 12, borderRadius: 12, borderWidth: 1, borderColor: '#C7D8E9', backgroundColor: '#F8FAFD' },
  attestationAccepted: { borderColor: '#5E9AD4', backgroundColor: '#F0F7FF' },
  attestationBox: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 5, borderWidth: 1.5, borderColor: '#7591AE', backgroundColor: '#FFFFFF' },
  attestationBoxAccepted: { borderColor: '#1763B2', backgroundColor: '#1763B2' },
  attestationCheck: { color: '#FFFFFF', fontSize: 14, lineHeight: 17, fontWeight: '800' },
  attestationText: { flex: 1, color: '#375878', fontSize: 12, lineHeight: 18 },
  errorBox: { marginTop: 11, padding: 11, borderRadius: 10, backgroundColor: '#FFF2EF', borderWidth: 1, borderColor: '#EAC2B9' },
  errorText: { color: '#873E34', fontSize: 12, lineHeight: 18 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 14 },
  guideToggle: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start', marginTop: 5, paddingRight: 12 },
  guideToggleText: { color: '#1158AE', fontSize: 12, lineHeight: 18, fontWeight: '800' },
  guide: { gap: 10, paddingTop: 3 },
  guideText: { color: '#4D6581', fontSize: 12, lineHeight: 18 },
  guideExampleLabel: { color: '#496789', fontSize: 10, lineHeight: 14, fontWeight: '800', letterSpacing: 0.6 },
  guideExample: { color: '#23496E', backgroundColor: '#EFF5FC', overflow: 'hidden', borderRadius: 10, padding: 10, fontSize: 11, lineHeight: 18, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  report: { marginTop: 22, padding: 16, borderRadius: 18, backgroundColor: palette.surface, borderColor: palette.line, borderWidth: 1 },
  reportTop: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  reportTopCopy: { flex: 1, minWidth: 180 },
  reportTitle: { color: '#15385D', fontSize: 20, lineHeight: 26, fontWeight: '800', letterSpacing: -0.3, marginTop: 4 },
  reportBadge: { color: '#315A83', backgroundColor: '#EDF4FC', overflow: 'hidden', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 7, fontSize: 10, fontWeight: '800' },
  provenance: { color: '#526B83', fontSize: 11, lineHeight: 17, marginTop: 8 },
  trustGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: '#DCE8F5', backgroundColor: '#F7FAFD' },
  trustItem: { flexGrow: 1, flexBasis: '44%', minWidth: 130, gap: 3 },
  trustLabel: { color: '#526B83', fontSize: 10, lineHeight: 15, fontWeight: '700' },
  trustValue: { color: '#274B6F', fontSize: 11, lineHeight: 16 },
  clockBox: { marginTop: 10, padding: 10, borderRadius: 9, backgroundColor: '#FFF6E7', borderWidth: 1, borderColor: '#EAD2A8' },
  clockText: { color: '#795419', fontSize: 12, lineHeight: 18 },
  thresholdPanel: { marginTop: 22, padding: 16, borderRadius: 18, backgroundColor: palette.surface, borderColor: palette.line, borderWidth: 1 },
  thresholdHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  thresholdHeaderCopy: { flex: 1 },
  thresholdTitle: { color: '#15385D', fontSize: 18, lineHeight: 24, fontWeight: '800', letterSpacing: -0.2, marginTop: 3 },
  thresholdIntro: { color: '#526B83', fontSize: 12, lineHeight: 18, marginTop: 7 },
  thresholdControls: { gap: 8, marginTop: 13 },
  thresholdControlRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: 11, borderRadius: 12, borderWidth: 1, borderColor: '#E0EAF4', backgroundColor: '#F8FBFF' },
  thresholdControlCopy: { flex: 1, minWidth: 0 },
  thresholdControlLabel: { color: '#17395D', fontSize: 12, lineHeight: 17, fontWeight: '800' },
  thresholdControlDescription: { color: '#526B83', fontSize: 10, lineHeight: 15, marginTop: 3 },
  thresholdStepper: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  thresholdStepButton: { width: 40, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: '#BCD0E6', backgroundColor: '#FFFFFF' },
  thresholdStepButtonDisabled: { opacity: 0.45 },
  thresholdStepText: { color: '#1559A8', fontSize: 22, lineHeight: 26, fontWeight: '700' },
  thresholdValue: { minWidth: 46, color: '#15385D', fontSize: 13, lineHeight: 20, fontWeight: '800', textAlign: 'center', fontVariant: ['tabular-nums'] },
  thresholdValueInput: { width: 48, minHeight: 42, paddingHorizontal: 3, color: '#15385D', fontSize: 13, lineHeight: 20, fontWeight: '800', textAlign: 'center', fontVariant: ['tabular-nums'] },
  thresholdPercent: { color: '#526B83', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  thresholdStorageNotice: { color: '#526B83', fontSize: 10, lineHeight: 15, marginTop: 9 },
  thresholdRecoveryActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8, marginTop: 9 },
  thresholdRecoveryButton: { minHeight: 38, justifyContent: 'center', paddingHorizontal: 11, paddingVertical: 8, borderRadius: 9, borderWidth: 1, borderColor: '#BCD0E6', backgroundColor: '#FFFFFF' },
  thresholdRecoveryButtonText: { color: '#1559A8', fontSize: 11, lineHeight: 16, fontWeight: '800' },
  thresholdResetConfirmation: { flexBasis: '100%', gap: 8, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: '#E8C98D', backgroundColor: '#FFFBF1' },
  thresholdResetButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thresholdResetConfirm: { borderColor: '#B96D22', backgroundColor: '#FFF6E7' },
  thresholdResetConfirmText: { color: '#80540A', fontSize: 11, lineHeight: 16, fontWeight: '800' },
  thresholdResults: { gap: 8, marginTop: 12 },
  thresholdResultCard: { gap: 4, padding: 11, borderRadius: 11, borderWidth: 1, borderColor: '#E0EAF4', backgroundColor: '#F8FBFF' },
  thresholdResultLabel: { color: '#17395D', fontSize: 11, lineHeight: 16, fontWeight: '800' },
  thresholdStatusNotice: { alignSelf: 'flex-start', color: '#80540A', backgroundColor: '#FFF3D6', overflow: 'hidden', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, fontSize: 10, lineHeight: 15, fontWeight: '800' },
  thresholdStatusClear: { alignSelf: 'flex-start', color: '#236347', backgroundColor: '#E8F6EE', overflow: 'hidden', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, fontSize: 10, lineHeight: 15, fontWeight: '800' },
  thresholdStatusUnavailable: { alignSelf: 'flex-start', color: '#526B83', backgroundColor: '#EDF2F7', overflow: 'hidden', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, fontSize: 10, lineHeight: 15, fontWeight: '800' },
  thresholdResultDetail: { color: '#526B83', fontSize: 10, lineHeight: 15 },
  thresholdEmpty: { color: '#526B83', fontSize: 11, lineHeight: 17, marginTop: 12, padding: 11, borderRadius: 10, backgroundColor: '#F6F9FD' },
  thresholdFootnote: { color: '#667B93', fontSize: 10, lineHeight: 15, marginTop: 10 },
  audienceSection: { marginBottom: 24 },
  exampleAction: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 24 },
  exampleHelp: { flexShrink: 1, color: '#526B83', fontSize: 11, lineHeight: 17 },
  perspectiveLabel: { color: '#526B83', fontSize: 11, lineHeight: 16, fontWeight: '700' },
  perspectiveRow: { flexDirection: 'row', gap: 5, backgroundColor: '#F0F4F9', borderRadius: 12, padding: 4, marginTop: 6 },
  perspectiveButton: { flex: 1, minHeight: 44, paddingHorizontal: 8, paddingVertical: 9, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  perspectiveSelected: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D7E3F0' },
  perspectiveText: { color: '#526B83', fontSize: 12, lineHeight: 18, fontWeight: '700', textAlign: 'center' },
  perspectiveTextSelected: { color: '#14549E' },
  perspectiveHelp: { color: '#526B83', fontSize: 11, lineHeight: 17, marginTop: 7 },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  statCard: { flexGrow: 1, flexBasis: '46%', minWidth: 132, padding: 13, backgroundColor: '#F6F9FD', borderColor: '#E0EAF4', borderWidth: 1, borderRadius: 12 },
  statLabel: { color: '#526B83', fontSize: 11, lineHeight: 15, fontWeight: '700' },
  statValue: { color: '#12365C', fontSize: 20, lineHeight: 25, fontWeight: '800', marginTop: 6, fontVariant: ['tabular-nums'] },
  statDetail: { color: '#526B83', fontSize: 10, lineHeight: 15, marginTop: 4 },
  reportNote: { color: '#526B83', fontSize: 11, lineHeight: 17, marginTop: 13 },
  periodBlock: { marginTop: 16, borderTopWidth: 1, borderTopColor: '#E5EDF5', paddingTop: 15 },
  periodHeading: { marginBottom: 8 },
  periodTitle: { color: '#17395D', fontSize: 14, lineHeight: 20, fontWeight: '800' },
  periodDates: { color: '#526B83', fontSize: 11, lineHeight: 16, marginTop: 2 },
  channelRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#EDF2F7', gap: 5 },
  channelHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 },
  channelTitle: { color: '#17395D', fontSize: 13, lineHeight: 19, fontWeight: '800' },
  channelCount: { color: '#315A83', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  channelAmounts: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  channelDetail: { color: '#526B83', fontSize: 11, lineHeight: 17 },
  channelAmount: { color: '#294F77', fontWeight: '700' },
  footer: { marginTop: 22, padding: 16, borderRadius: 16, backgroundColor: '#EAF2FC' },
  footerTitle: { color: '#17395D', fontSize: 13, lineHeight: 19, fontWeight: '800' },
  customerSignal: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6, marginTop: 10 },
  customerSignalLabel: { color: '#294F77', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  customerSignalStatus: { color: '#526B83', fontSize: 12, lineHeight: 18 },
  footerText: { color: '#526B83', fontSize: 12, lineHeight: 18, marginTop: 10 },
  pressed: { opacity: 0.72 },
});
