import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';

import { CustomerPrivateBoundary } from '@/components/customer-private-boundary';
import { useCustomerSession } from '@/lib/customer-session-context';
import { MarketHeader } from '@/components/market-header';
import { NativeButton } from '@/components/native-button';
import { PortfolioAllocation } from '@/components/portfolio-allocation';
import { formatCurrency, type DisplayCurrency } from '@/lib/currency';
import { useData, type PortfolioRecovery } from '@/lib/data-context';
import { hasHoldingInputIssue, hasUnsavedHoldingInputs, holdingQuantityForEstimate, parseHoldingInput, previewHoldingInputs, type HoldingInput } from '@/lib/holding-input';
import { ASSETS, formatProviderUpdate, formatTimestamp, type CoinId } from '@/lib/market';
import { estimateHoldingValue, estimatePortfolio } from '@/lib/portfolio-value';
import { palette } from '@/lib/palette';
import { useResponsiveLayout } from '@/lib/responsive-layout';
import { prepareVenmoDraft, VENMO_USERNAME_GUIDANCE, venmoUsernameNeedsReview, type VenmoDraftAmount, type VenmoDraftRecipient } from '@/lib/venmo-draft-amount';
import { consumeVenmoSendIntent } from '@/lib/venmo-send-intent';
import {
  createVenmoContactsRepository,
  MAX_CONTACT_DISPLAY_NAME_LENGTH,
  MAX_CONTACT_HANDLE_LENGTH,
  MAX_VENMO_CONTACTS,
  type VenmoContact,
  type VenmoContactsCorruptSnapshot,
  type VenmoContactsForgetBaseline,
  type VenmoContactsMutationResult,
} from '@/lib/venmo-contacts';
import { useAppearanceStyles, usePalette } from '@/lib/theme-context';

// A write started on an earlier screen must settle before any later draft is copied.
const draftClipboardGuard = { pending: false };
const isDraftCopyPending = () => draftClipboardGuard.pending;
const beginDraftCopy = () => {
  if (draftClipboardGuard.pending) return false;
  draftClipboardGuard.pending = true;
  return true;
};
const endDraftCopy = () => { draftClipboardGuard.pending = false; };

function HoldingsAssetMark({ coinId }: { coinId: CoinId }) {
  const styles = useAppearanceStyles(baseStyles);
  const asset = ASSETS.find((item) => item.id === coinId)!;
  return (
    <View style={[styles.assetMark, { backgroundColor: `${asset.color}15` }]} importantForAccessibility="no">
      <Text style={[styles.assetMarkText, { color: asset.color }]}>{asset.monogram}</Text>
    </View>
  );
}

function holdingInputMessage(input: HoldingInput): string | null {
  if (input.kind === 'incomplete') return 'Finish this quantity before saving.';
  if (input.kind === 'valid' && holdingQuantityForEstimate(input.value) === null) return 'Estimates support quantities up to 1 trillion and 15 significant digits. You can still save this quantity.';
  if (input.kind !== 'invalid') return null;
  if (input.reason === 'precision') return 'Use no more than 10 decimal places.';
  if (input.reason === 'length') return 'Use no more than 32 characters.';
  return 'Use digits and one decimal point or decimal comma. Scientific notation is not supported.';
}

const SMALLEST_DISPLAYED_PORTFOLIO_VALUE = 0.00000001;
const MAX_TRACKED_DRAFT_RECIPIENT_RISKS = 64;
const DRAFT_RECIPIENT_OVERFLOW_NOTICE = 'Saved contact history could not be fully verified. Your draft recipient may be outdated; review it before copying.';
const PORTFOLIO_SECTION_JUMP_INDEX = 2; // MarketHeader, title, then the sticky section controls.

/** Avoid presenting a nonzero estimate as zero at the display precision. */
function formatPortfolioValue(value: number, currency: DisplayCurrency, minimumFractionDigits?: number): string {
  return value > 0 && value < SMALLEST_DISPLAYED_PORTFOLIO_VALUE
    ? `< ${formatCurrency(SMALLEST_DISPLAYED_PORTFOLIO_VALUE, currency, false, minimumFractionDigits)}`
    : formatCurrency(value, currency, false, minimumFractionDigits);
}

function portfolioValueAccessibilityLabel(value: number, currency: DisplayCurrency): string | undefined {
  return value > 0 && value < SMALLEST_DISPLAYED_PORTFOLIO_VALUE
    ? `Less than ${formatCurrency(SMALLEST_DISPLAYED_PORTFOLIO_VALUE, currency)}`
    : undefined;
}

function venmoAmountMessage(amount: VenmoDraftAmount): string | null {
  if (amount.kind === 'incomplete') return 'Finish the amount or leave it blank before copying.';
  if (amount.kind !== 'invalid') return null;
  if (amount.reason === 'precision') return 'Use no more than two decimal places.';
  if (amount.reason === 'length') return 'Use no more than 32 characters for this draft.';
  if (amount.reason === 'zero') return 'Enter an amount greater than $0.00 or leave it blank.';
  return 'Use digits and one decimal point or comma. Signs and scientific notation are not supported.';
}

function venmoRecipientMessage(recipient: VenmoDraftRecipient): string | null {
  if (recipient.kind !== 'invalid') return null;
  if (recipient.reason === 'length') return 'Use a handle of no more than 40 characters for this draft.';
  return 'This draft accepts letters, numbers, dots, underscores or hyphens, with one optional @ at the start.';
}

export default function PortfolioScreen() {
  return <CustomerPrivateBoundary><PortfolioContent /></CustomerPrivateBoundary>;
}

export function PortfolioContent() {
  const styles = useAppearanceStyles(baseStyles);
  const colors = usePalette();
  const routeParams = useLocalSearchParams<{ sendIntent?: string | string[] }>();
  const sendIntent = typeof routeParams.sendIntent === 'string' ? routeParams.sendIntent : null;
  const { storageFence, revision } = useCustomerSession();
  const contactsRepository = useMemo(() => {
    // The fence object is stable; a session revision must bind a new generation.
    void revision;
    return createVenmoContactsRepository(storageFence);
  }, [storageFence, revision]);
  const { loadVenmoContacts, addVenmoContact, updateVenmoContact, removeVenmoContact, forgetVenmoContacts } = contactsRepository;
  const { overview, refreshOverview, showLatestOverviewResponse, currency, holdings, holdingDrafts, setHolding, commitHolding, commitAllHoldings, retryPortfolioSave, loadSavedPortfolio, forgetHoldings, portfolioRecovery, resolvePortfolioRecovery, portfolioReady, portfolioStatus } = useData();
  const layout = useResponsiveLayout();
  const portfolioScrollRef = useRef<ScrollView | null>(null);
  const sectionPositions = useRef<{ holdings: number | null; venmo: number | null }>({ holdings: null, venmo: null });
  const sectionNavigationHeight = useRef(0);
  const sectionLayoutReady = useRef({ navigation: false, holdings: false, venmo: false });
  const handledSendIntentRef = useRef<string | null>(null);
  const [sectionNavigationReady, setSectionNavigationReady] = useState(false);
  const [recipient, setRecipient] = useState('');
  const recipientRef = useRef('');
  const [draftAmount, setDraftAmount] = useState('');
  const draftAmountRef = useRef('');
  const [draftNote, setDraftNote] = useState('');
  const draftNoteRef = useRef('');
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [draftRecipientNotice, setDraftRecipientNotice] = useState<string | null>(null);
  const draftRecipientRisksRef = useRef({
    handles: new Map<string, string>(),
    overflow: false,
    acknowledgedHandle: null as string | null,
  });
  const [copyBusy, setCopyBusy] = useState(false);
  const copyGeneration = useRef(0);
  const copyMounted = useRef(true);
  const [portfolioRecoveryMessage, setPortfolioRecoveryMessage] = useState<string | null>(null);
  const [savedContacts, setSavedContacts] = useState<VenmoContact[]>([]);
  const verifiedContactsRef = useRef<VenmoContact[] | null>(null);
  const [contactsStatus, setContactsStatus] = useState<'loading' | 'ready' | 'corrupt' | 'unavailable'>('loading');
  const corruptContactsSnapshot = useRef<VenmoContactsCorruptSnapshot | null>(null);
  const [contactsBusy, setContactsBusy] = useState(false);
  const contactsBusyRef = useRef(false);
  const [contactDisplayName, setContactDisplayName] = useState('');
  const contactDisplayNameRef = useRef('');
  const [contactHandle, setContactHandle] = useState('');
  const contactHandleRef = useRef('');
  const [editingContact, setEditingContact] = useState<VenmoContact | null>(null);
  const editingContactRef = useRef<VenmoContact | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const editDisplayNameRef = useRef('');
  const [editHandle, setEditHandle] = useState('');
  const editHandleRef = useRef('');
  const [contactsMessage, setContactsMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    copyMounted.current = true;
    void loadVenmoContacts().then((result) => {
      if (!active || !contactsRepository.isCurrent()) return;
      if (result.status === 'ready') {
        verifiedContactsRef.current = result.contacts;
        corruptContactsSnapshot.current = null;
        setSavedContacts(result.contacts);
        setContactsStatus('ready');
        return;
      }
      setSavedContacts([]);
      verifiedContactsRef.current = null;
      corruptContactsSnapshot.current = result.status === 'corrupt' ? result.snapshot : null;
      setContactsStatus(result.status);
      setContactsMessage(result.status === 'corrupt'
        ? 'Saved contact data could not be read. It has been left untouched; you can explicitly forget it below.'
        : 'Secure contact storage is unavailable on this device. No contact data was changed.');
    });
    return () => {
      active = false;
      copyMounted.current = false;
      copyGeneration.current += 1;
    };
  }, [contactsRepository, loadVenmoContacts]);

  const inputState = useMemo(() => ({ holdings, drafts: holdingDrafts }), [holdings, holdingDrafts]);
  const inputIssue = portfolioReady && hasHoldingInputIssue(holdingDrafts);
  const unsavedInputs = portfolioReady && hasUnsavedHoldingInputs(inputState);
  const previewHoldings = useMemo(() => previewHoldingInputs(inputState), [inputState]);
  const estimate = useMemo(() => estimatePortfolio(previewHoldings, overview.data, portfolioReady), [previewHoldings, overview.data, portfolioReady]);
  const allocationPositions = useMemo(() => ASSETS.flatMap((asset) => {
    const value = previewHoldings[asset.id];
    if (!value) return [];
    const quantity = holdingQuantityForEstimate(value);
    if (quantity === null || quantity <= 0) return [];
    const price = overview.data?.coins.find((coin) => coin.id === asset.id)?.price;
    return [{ id: asset.id, name: asset.name, symbol: asset.symbol, color: asset.color, value: estimateHoldingValue(value, price) }];
  }), [previewHoldings, overview.data]);
  const allocationTotal = !inputIssue && estimate.state === 'ready' ? estimate.estimatedValue : null;
  const allocationMessage = inputIssue ? 'Complete or correct each quantity before viewing the allocation.'
    : estimate.state === 'empty' ? 'Add a quantity to see how your portfolio is divided.'
      : estimate.state === 'prices-unavailable' ? `Reference prices are needed for ${estimate.missingPriceCount} ${estimate.missingPriceCount === 1 ? 'holding' : 'holdings'} before the full allocation can be shown.`
        : estimate.state === 'calculation-unavailable' ? 'One or more quantities or values cannot be estimated for this view.'
          : estimate.state === 'holdings-unavailable' ? 'Your saved quantities need to be available before an allocation can be shown.'
            : 'The entered holdings have no positive estimated value to divide yet.';
  const preparedDraft = prepareVenmoDraft(recipient, draftNote, draftAmount);
  const amountMessage = venmoAmountMessage(preparedDraft.amount);
  const recipientMessage = venmoRecipientMessage(preparedDraft.recipient);

  const markSectionLayoutReady = (section: keyof typeof sectionLayoutReady.current) => {
    sectionLayoutReady.current[section] = true;
    if (sectionLayoutReady.current.navigation && sectionLayoutReady.current.holdings && sectionLayoutReady.current.venmo) {
      setSectionNavigationReady(true);
    }
  };

  const jumpToPortfolioSection = (section: keyof typeof sectionPositions.current) => {
    const position = sectionPositions.current[section];
    if (position === null) return;
    portfolioScrollRef.current?.scrollTo({
      y: Math.max(0, position - sectionNavigationHeight.current - 8),
      animated: true,
    });
  };

  useEffect(() => {
    if (!sectionNavigationReady || !sendIntent || sendIntent.length > 64) return;
    const frame = requestAnimationFrame(() => {
      if (handledSendIntentRef.current === sendIntent) return;
      const amount = consumeVenmoSendIntent(sendIntent);
      handledSendIntentRef.current = sendIntent;
      if (amount) {
        const applyAmount = () => {
          draftAmountRef.current = amount;
          setDraftAmount(amount);
          setCopyMessage('Draft amount updated. Nothing was sent.');
        };
        if (draftAmountRef.current && draftAmountRef.current !== amount) {
          const keepCurrentAmount = () => setCopyMessage('Your existing draft amount is unchanged.');
          const confirmReplacement = 'A different amount is already in your draft. Replace the amount? Nothing will be sent.';
          if (Platform.OS === 'web') {
            if (typeof window !== 'undefined' && window.confirm(confirmReplacement)) applyAmount();
            else keepCurrentAmount();
          } else {
            Alert.alert(
              'Replace draft amount?',
              confirmReplacement,
              [
                { text: 'Keep current', style: 'cancel', onPress: keepCurrentAmount },
                { text: 'Replace amount', onPress: applyAmount },
              ],
            );
          }
        } else {
          draftAmountRef.current = amount;
          setDraftAmount(amount);
          setCopyMessage(null);
        }
      } else {
        setCopyMessage('The amount handoff expired. Enter it again to continue.');
      }
      const position = sectionPositions.current.venmo;
      if (position !== null) {
        portfolioScrollRef.current?.scrollTo({
          y: Math.max(0, position - sectionNavigationHeight.current - 8),
          animated: true,
        });
      }
      router.setParams({ sendIntent: undefined });
    });
    return () => cancelAnimationFrame(frame);
  }, [sectionNavigationReady, sendIntent]);

  const copyDraft = async () => {
    if (!copyMounted.current || !contactsRepository.isCurrent()) return;
    const currentDraft = prepareVenmoDraft(recipientRef.current, draftNoteRef.current, draftAmountRef.current);
    if (!currentDraft.ok) return;
    if (!beginDraftCopy()) {
      setCopyMessage('A copy is in progress. Wait for it to finish, then copy the latest draft.');
      return;
    }
    const generation = ++copyGeneration.current;
    setCopyBusy(true);
    try {
      const copied = await Clipboard.setStringAsync(currentDraft.text);
      if (copyMounted.current && contactsRepository.isCurrent() && copyGeneration.current === generation) {
        setCopyMessage(copied ? 'Draft copied. Open Venmo yourself and review it before any action.' : 'Your clipboard is not available.');
      }
    } catch {
      if (copyMounted.current && contactsRepository.isCurrent() && copyGeneration.current === generation) setCopyMessage('Could not copy the draft. Try again on this device.');
    } finally {
      endDraftCopy();
      if (copyMounted.current && contactsRepository.isCurrent()) {
        setCopyBusy(false);
        if (copyGeneration.current !== generation) setCopyMessage('The earlier copy attempt finished. Copy the updated draft again and review it before using it.');
      }
    }
  };

  const markDraftEdited = () => {
    copyGeneration.current += 1;
    setCopyMessage(isDraftCopyPending()
      ? 'A copy is in progress and may contain earlier details. Wait for it to finish, then copy the updated draft again.'
      : null);
  };

  const canonicalDraftHandle = (value: string) => (value.startsWith('@') ? value.slice(1) : value).toLowerCase();

  const draftRecipientNoticeForHandle = (value: string) => {
    const handle = canonicalDraftHandle(value);
    if (!handle) return null;
    const risks = draftRecipientRisksRef.current;
    if (risks.acknowledgedHandle === handle) return null;
    return risks.handles.get(handle) ?? (risks.overflow ? DRAFT_RECIPIENT_OVERFLOW_NOTICE : null);
  };

  const recordDraftRecipientRisk = (value: string, message: string) => {
    const handle = canonicalDraftHandle(value);
    if (!handle) return;
    const risks = draftRecipientRisksRef.current;
    if (risks.acknowledgedHandle === handle) risks.acknowledgedHandle = null;
    if (risks.handles.has(handle) || risks.handles.size < MAX_TRACKED_DRAFT_RECIPIENT_RISKS) {
      risks.handles.set(handle, message);
    } else {
      if (!risks.overflow) risks.acknowledgedHandle = null;
      risks.overflow = true;
    }
  };

  const updateRecipient = (value: string) => {
    recipientRef.current = value;
    setRecipient(value);
    draftRecipientRisksRef.current.acknowledgedHandle = null;
    setDraftRecipientNotice(draftRecipientNoticeForHandle(value));
    markDraftEdited();
  };

  const updateDraftAmount = (value: string) => {
    draftAmountRef.current = value;
    setDraftAmount(value);
    markDraftEdited();
  };

  const updateDraftNote = (value: string) => {
    draftNoteRef.current = value;
    setDraftNote(value);
    markDraftEdited();
  };

  const updateContactDisplayName = (value: string) => {
    contactDisplayNameRef.current = value;
    setContactDisplayName(value);
  };

  const updateContactHandle = (value: string) => {
    contactHandleRef.current = value;
    setContactHandle(value);
  };

  const warnIfDraftContactChanged = (previous: VenmoContact[], current: VenmoContact[], elsewhere = false) => {
    const draftHandle = canonicalDraftHandle(recipientRef.current);
    const priorNotice = draftRecipientNoticeForHandle(draftHandle);
    const message = elsewhere
      ? 'The saved contact changed or was removed elsewhere. Your draft still uses the previous recipient; review it before copying.'
      : 'The saved contact changed or was removed. Your draft still uses the previous recipient; review it before copying.';
    let currentAffected = false;
    for (const original of previous) {
      const updated = current.find((contact) => contact.id === original.id);
      if (!updated || updated.handle.toLowerCase() !== original.handle.toLowerCase()) {
        recordDraftRecipientRisk(original.handle, message);
        if (canonicalDraftHandle(original.handle) === draftHandle) currentAffected = true;
      }
    }
    const notice = draftRecipientNoticeForHandle(draftHandle);
    setDraftRecipientNotice(notice);
    if (notice && (currentAffected || notice !== priorNotice)) markDraftEdited();
  };

  const warnIfDraftContactUnverified = (previous: VenmoContact[], unknownContacts = false) => {
    const draftHandle = canonicalDraftHandle(recipientRef.current);
    const priorNotice = draftRecipientNoticeForHandle(draftHandle);
    const message = 'The saved contact change could not be verified. Your draft recipient may be outdated; review it before copying.';
    for (const contact of previous) recordDraftRecipientRisk(contact.handle, message);
    if (unknownContacts) {
      draftRecipientRisksRef.current.overflow = true;
      draftRecipientRisksRef.current.acknowledgedHandle = null;
    }
    const notice = draftRecipientNoticeForHandle(draftHandle);
    setDraftRecipientNotice(notice);
    if (notice && (unknownContacts || previous.some((contact) => canonicalDraftHandle(contact.handle) === draftHandle) || notice !== priorNotice)) markDraftEdited();
  };

  const runContactMutation = async (
    operation: () => Promise<VenmoContactsMutationResult>,
    successMessage: string,
    afterSuccess?: (contacts: VenmoContact[]) => void,
    onConflict?: (contacts: VenmoContact[]) => void,
    onUnverified?: () => void,
  ) => {
    if (!copyMounted.current || !contactsRepository.isCurrent() || contactsBusyRef.current) return;
    const previouslyVerifiedContacts = (verifiedContactsRef.current ?? []).map((contact) => ({ ...contact }));
    contactsBusyRef.current = true;
    setContactsBusy(true);
    setContactsMessage(null);
    try {
      const result = await operation();
      if (!copyMounted.current || !contactsRepository.isCurrent()) return;
      if (result.status === 'ready') {
        warnIfDraftContactChanged(previouslyVerifiedContacts, result.contacts);
        verifiedContactsRef.current = result.contacts;
        corruptContactsSnapshot.current = null;
        setSavedContacts(result.contacts);
        setContactsStatus('ready');
        setContactsMessage(successMessage);
        afterSuccess?.(result.contacts);
      } else if (result.status === 'corrupt') {
        warnIfDraftContactUnverified(previouslyVerifiedContacts);
        onUnverified?.();
        verifiedContactsRef.current = null;
        corruptContactsSnapshot.current = result.snapshot;
        setSavedContacts([]);
        setContactsStatus('corrupt');
        setContactsMessage(result.changed
          ? 'Saved contact data changed and is still unreadable. Nothing was deleted; review and confirm again.'
          : 'Saved contact data could not be read and was left untouched. You can explicitly forget it below.');
      } else if (result.status === 'unavailable') {
        warnIfDraftContactUnverified(previouslyVerifiedContacts);
        onUnverified?.();
        verifiedContactsRef.current = null;
        setContactsStatus('unavailable');
        setContactsMessage('Secure contact storage is unavailable or could not verify the change. No further edits are enabled.');
      } else if (result.status === 'conflict' || result.status === 'duplicate' || result.status === 'limit') {
        warnIfDraftContactChanged(previouslyVerifiedContacts, result.contacts, true);
        verifiedContactsRef.current = result.contacts;
        corruptContactsSnapshot.current = null;
        setSavedContacts(result.contacts);
        setContactsStatus('ready');
        if (result.status === 'conflict') {
          if (onConflict) onConflict(result.contacts);
          else setContactsMessage('Saved contacts changed elsewhere. Review the updated list before trying again.');
        } else if (result.status === 'duplicate') {
          setContactsMessage('That Venmo handle is already saved.');
        } else {
          setContactsMessage(`You can save up to ${MAX_VENMO_CONTACTS} contacts. Remove one or shorten a display name to make room.`);
        }
      } else if (result.status === 'invalid-name') {
        setContactsMessage(`Enter a display name up to ${MAX_CONTACT_DISPLAY_NAME_LENGTH} characters.`);
      } else if (result.status === 'invalid-handle') {
        setContactsMessage(`The local contact field accepts a handle up to ${MAX_CONTACT_HANDLE_LENGTH} characters using letters, numbers, dots, underscores, or hyphens, with one optional @ at the start and no spaces.`);
      }
    } catch {
      if (!copyMounted.current || !contactsRepository.isCurrent()) return;
      warnIfDraftContactUnverified(previouslyVerifiedContacts);
      onUnverified?.();
      verifiedContactsRef.current = null;
      setContactsStatus('unavailable');
      setContactsMessage('Secure contact storage could not verify the change. No further edits are enabled.');
    } finally {
      contactsBusyRef.current = false;
      if (copyMounted.current && contactsRepository.isCurrent()) setContactsBusy(false);
    }
  };

  const addContact = () => {
    if (contactsStatus !== 'ready' || editingContactRef.current) return;
    const name = contactDisplayNameRef.current;
    const handle = contactHandleRef.current;
    void runContactMutation(
      () => addVenmoContact(name, handle),
      'Saved encrypted on this device.',
      () => {
        if (contactDisplayNameRef.current === name && contactHandleRef.current === handle) {
          updateContactDisplayName('');
          updateContactHandle('');
        }
      },
    );
  };

  const updateEditDisplayName = (value: string) => {
    editDisplayNameRef.current = value;
    setEditDisplayName(value);
  };

  const updateEditHandle = (value: string) => {
    editHandleRef.current = value;
    setEditHandle(value);
  };

  const clearContactEdit = () => {
    editingContactRef.current = null;
    setEditingContact(null);
    updateEditDisplayName('');
    updateEditHandle('');
  };

  const startContactEdit = (contact: VenmoContact) => {
    if (!copyMounted.current || !contactsRepository.isCurrent() || contactsStatus !== 'ready' || contactsBusyRef.current || editingContactRef.current) return;
    const original = { ...contact };
    editingContactRef.current = original;
    setEditingContact(original);
    updateEditDisplayName(original.displayName);
    updateEditHandle(original.handle);
    setContactsMessage(null);
  };

  const cancelContactEdit = () => {
    if (!copyMounted.current || !contactsRepository.isCurrent() || contactsBusyRef.current) return;
    clearContactEdit();
    setContactsMessage(null);
  };

  const saveContactEdit = () => {
    const original = editingContactRef.current;
    if (contactsStatus !== 'ready' || !original) return;
    const displayName = editDisplayNameRef.current;
    const handle = editHandleRef.current;
    void runContactMutation(
      () => updateVenmoContact(original, displayName, handle),
      'Contact updated on this device.',
      (contacts) => {
        if (editingContactRef.current?.id !== original.id) return;
        const saved = contacts.find((contact) => contact.id === original.id);
        if (!saved) return;
        warnIfDraftContactChanged([original], contacts);
        if (editDisplayNameRef.current === displayName && editHandleRef.current === handle) {
          clearContactEdit();
        } else {
          // A queued input event may arrive before the disabled fields rerender.
          // Keep those newer edits and use the verified saved row as their baseline.
          editingContactRef.current = saved;
          setEditingContact(saved);
          setContactsMessage('Contact updated. Newer edits are still unsaved.');
        }
      },
      (contacts) => {
        warnIfDraftContactChanged([original], contacts, true);
        setContactsMessage('This contact changed or was removed elsewhere. Cancel this edit and review the updated list before trying again.');
      },
      () => warnIfDraftContactUnverified([original]),
    );
  };

  const confirmRemoveContact = (contact: VenmoContact) => {
    if (!copyMounted.current || !contactsRepository.isCurrent() || editingContactRef.current) return;
    const original = { ...contact };
    Alert.alert(
      'Remove saved contact?',
      `${original.displayName}, @${original.handle}, will be removed from this device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            if (editingContactRef.current) return;
            void runContactMutation(
              () => removeVenmoContact(original),
              'Contact removed from this device.',
              (contacts) => warnIfDraftContactChanged([original], contacts),
              (contacts) => {
                warnIfDraftContactChanged([original], contacts, true);
                setContactsMessage('This contact changed or was removed elsewhere. Review the updated list before removing it.');
              },
              () => warnIfDraftContactUnverified([original]),
            );
          },
        },
      ],
    );
  };

  const confirmForgetContacts = () => {
    if (!copyMounted.current || !contactsRepository.isCurrent() || editingContactRef.current) return;
    const originalContacts = savedContacts.map((contact) => ({ ...contact }));
    const baseline: VenmoContactsForgetBaseline | null = contactsStatus === 'ready'
      ? { status: 'ready', contacts: originalContacts }
      : contactsStatus === 'corrupt' && corruptContactsSnapshot.current
        ? { status: 'corrupt', snapshot: corruptContactsSnapshot.current }
        : null;
    if (!baseline) return;
    Alert.alert(
      contactsStatus === 'corrupt' ? 'Forget unreadable contact data?' : 'Forget all saved contacts?',
      'This deletes the saved names and handles from secure storage on this device. It does not affect anything in Venmo.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: () => {
            if (editingContactRef.current) return;
            void runContactMutation(
              () => forgetVenmoContacts(baseline),
              'Saved contact data forgotten.',
              (contacts) => {
                if (baseline.status === 'corrupt') warnIfDraftContactUnverified([], true);
                else warnIfDraftContactChanged(originalContacts, contacts);
              },
              (contacts) => {
                if (baseline.status === 'corrupt') warnIfDraftContactUnverified([], true);
                else warnIfDraftContactChanged(originalContacts, contacts, true);
                setContactsMessage('Saved contacts changed elsewhere. Review the updated list before forgetting it.');
              },
              () => warnIfDraftContactUnverified(originalContacts, baseline.status === 'corrupt'),
            );
          },
        },
      ],
    );
  };

  const selectContactForDraft = (contact: VenmoContact) => {
    if (!copyMounted.current || !contactsRepository.isCurrent() || contactsBusyRef.current) return;
    const verified = verifiedContactsRef.current?.find((item) => item.id === contact.id && item.displayName === contact.displayName && item.handle === contact.handle);
    if (!verified) return;
    recipientRef.current = verified.handle;
    setRecipient(verified.handle);
    const risks = draftRecipientRisksRef.current;
    const selectedHandle = canonicalDraftHandle(verified.handle);
    risks.acknowledgedHandle = selectedHandle;
    setDraftRecipientNotice(null);
    markDraftEdited();
    if (!isDraftCopyPending()) setCopyMessage(`Draft recipient set to @${verified.handle}. Nothing was sent.`);
  };

  const confirmForgetHoldings = () => {
    if (!copyMounted.current || !contactsRepository.isCurrent()) return;
    const title = 'Forget saved quantities?';
    const message = 'This removes manual portfolio quantities from this device. It does not change anything in PayPal or Venmo.';
    const forget = () => { if (copyMounted.current && contactsRepository.isCurrent()) void forgetHoldings(); };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) forget();
      return;
    }
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: forget,
        },
      ],
    );
  };

  const confirmLoadSavedPortfolio = () => {
    if (!copyMounted.current || !contactsRepository.isCurrent()) return;
    const title = 'Discard these edits and load saved quantities?';
    const message = 'The quantities currently shown may not be saved. Loading the stored copy will discard these edits on this device.';
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) void loadSavedPortfolio();
      return;
    }
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Discard edits and load', style: 'destructive', onPress: () => { if (copyMounted.current && contactsRepository.isCurrent()) void loadSavedPortfolio(); } },
    ]);
  };

  const confirmPortfolioRecovery = (source: 'secure' | 'legacy') => {
    if (!copyMounted.current || !contactsRepository.isCurrent()) return;
    const restoreOlder = source === 'legacy';
    const secureCopyIsReadable = portfolioRecovery?.secure.state === 'readable';
    Alert.alert(
      restoreOlder ? 'Restore the older saved copy?' : 'Keep the encrypted device copy?',
      restoreOlder
        ? secureCopyIsReadable
          ? 'This replaces the current encrypted copy with the older copy. The new secure copy will be checked before the older copy is removed. If the check fails, the older copy will remain.'
          : 'The older copy will be written to encrypted device storage and checked before the older copy is removed. If the check fails, the older copy will remain.'
        : 'The encrypted device copy will be checked before the older copy is removed. No quantities will be changed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: restoreOlder ? 'Restore older copy' : 'Keep device copy',
          onPress: () => {
            if (!copyMounted.current || !contactsRepository.isCurrent()) return;
            setPortfolioRecoveryMessage(null);
            void resolvePortfolioRecovery(source).then((resolved) => {
              if (copyMounted.current && contactsRepository.isCurrent() && !resolved) setPortfolioRecoveryMessage('The copies were left in place because the choice could not be verified. Reopen the app when secure storage is available, then choose again.');
            });
          },
        },
      ],
    );
  };

  const portfolioCopySummary = (copy: PortfolioRecovery['secure']) => {
    if (copy.state === 'unavailable') return 'Secure storage is unavailable';
    if (copy.state === 'missing') return 'No copy found';
    if (copy.state === 'unreadable') return 'Copy could not be read';
    if (copy.state !== 'readable') return 'Copy status unknown';
    const count = Object.keys(copy.holdings).length;
    return `${count} saved ${count === 1 ? 'quantity' : 'quantities'}`;
  };

  const recoveryCopiesMatch = portfolioRecovery?.secure.state === 'readable' &&
    portfolioRecovery.legacy.state === 'readable' &&
    JSON.stringify(portfolioRecovery.secure.holdings) === JSON.stringify(portfolioRecovery.legacy.holdings);

  const statusText = portfolioStatus === 'loading'
    ? 'Loading your saved quantities…'
    : portfolioStatus === 'saving'
      ? Platform.OS === 'web' ? 'Saving in this browser…' : 'Saving securely…'
      : portfolioStatus === 'saved-web'
        ? 'Saved in this browser'
        : portfolioStatus === 'saved'
          ? 'Encrypted on this device'
        : portfolioStatus === 'save-unverified'
          ? 'Save not verified'
        : portfolioStatus === 'save-conflict'
          ? 'Saved quantities need review'
        : portfolioStatus === 'recovery'
          ? 'Choose a saved copy to continue'
          : portfolioStatus === 'corrupt'
            ? 'Saved data needs review'
            : 'Read-only until storage is ready';
  const holdingStatusText = unsavedInputs ? 'Unsaved edits' : statusText;

  const portfolioPrivacyText = Platform.OS === 'web'
    ? 'Stored only in this browser, unencrypted, and not sent to PayPal Markets. Never enter keys, credentials or recovery phrases.'
    : portfolioStatus === 'saved' || portfolioStatus === 'saving'
      ? 'Encrypted on this device; not sent to PayPal Markets. Never enter keys, credentials or recovery phrases.'
      : portfolioStatus === 'recovery'
        ? 'Multiple copies found. Editing is paused until you choose one.'
      : 'Device storage could not be verified; editing is paused. Never enter keys, credentials or recovery phrases.';

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={portfolioScrollRef}
          stickyHeaderIndices={[PORTFOLIO_SECTION_JUMP_INDEX]}
          contentContainerStyle={[styles.content, layout.wideCanvas && styles.contentWide]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <MarketHeader />

          <View style={styles.titleBlock}>
            <Text style={styles.kicker}>YOUR HOLDINGS</Text>
            <Text accessibilityRole="header" style={styles.pageTitle}>Portfolio</Text>
            <Text style={styles.subtitle}>Holdings at reference prices.</Text>
          </View>

          <View
            onLayout={({ nativeEvent }) => {
              sectionNavigationHeight.current = nativeEvent.layout.height;
              markSectionLayoutReady('navigation');
            }}
            style={styles.sectionJumpBar}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go to portfolio holdings"
              accessibilityHint="Scrolls to your manual crypto quantities. Entries remain on this screen."
              accessibilityState={{ disabled: !sectionNavigationReady }}
              disabled={!sectionNavigationReady}
              onPress={() => jumpToPortfolioSection('holdings')}
              style={({ pressed }) => [styles.sectionJumpButton, !sectionNavigationReady && styles.sectionJumpButtonDisabled, pressed && styles.sectionJumpButtonPressed]}
            >
              <Text style={styles.sectionJumpText}>Holdings</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go to saved contacts and Venmo draft"
              accessibilityHint="Scrolls to your saved contacts and copy-only Venmo note draft. Entries remain on this screen."
              accessibilityState={{ disabled: !sectionNavigationReady }}
              disabled={!sectionNavigationReady}
              onPress={() => jumpToPortfolioSection('venmo')}
              style={({ pressed }) => [styles.sectionJumpButton, !sectionNavigationReady && styles.sectionJumpButtonDisabled, pressed && styles.sectionJumpButtonPressed]}
            >
              <Text style={styles.sectionJumpText}>Contacts &amp; draft</Text>
            </Pressable>
          </View>

          <View style={layout.pairedPanels ? styles.summaryPanels : undefined}>
          <View style={layout.pairedPanels ? styles.summaryPanel : undefined}>
          <View style={styles.summaryCard}>
            <View style={styles.summaryAccent} importantForAccessibility="no" />
            <View style={styles.summaryHeading}>
              <Text style={styles.summaryLabel}>Estimated value</Text>
              <Text style={styles.summaryCurrency}>{currency} · reference</Text>
            </View>
            <Text style={styles.summaryValue} accessibilityLabel={!inputIssue && estimate.state === 'ready' && estimate.estimatedValue !== null ? portfolioValueAccessibilityLabel(estimate.estimatedValue, currency) : 'Portfolio estimate unavailable'}>
              {!inputIssue && estimate.estimatedValue !== null ? formatPortfolioValue(estimate.estimatedValue, currency) : '—'}
            </Text>
            {!inputIssue && estimate.state === 'empty' && <View style={styles.summaryEmptyState} accessibilityRole="summary">
              <View style={styles.summaryEmptyIcon} importantForAccessibility="no"><Text style={styles.summaryEmptyIconText}>＋</Text></View>
              <View style={styles.summaryEmptyCopy}>
                <Text style={styles.summaryEmptyTitle}>Start with one asset</Text>
                <Text style={styles.summaryEmptyText}>Add a quantity for an estimate and portfolio mix.</Text>
              </View>
            </View>}
            {(inputIssue || (estimate.state !== 'ready' && estimate.state !== 'empty')) && (
              <Text style={styles.summaryWarning} accessibilityRole="summary" accessibilityLiveRegion="polite">
                {inputIssue ? 'Complete or correct each quantity to see an estimate. Incomplete or unsupported entries are not saved.'
                  : estimate.state === 'prices-unavailable' ? 'Reference prices are needed for all entered holdings.'
                    : estimate.state === 'calculation-unavailable' ? `Estimates support up to 1 trillion ${currency} in value and quantities up to 1 trillion with 15 significant digits. Very small results may be unavailable.`
                    : portfolioStatus === 'loading' ? 'Loading your saved quantities…'
                      : portfolioStatus === 'recovery' ? 'Review your saved copies before calculating an estimate.'
                        : 'Saved quantities are unavailable. Review the storage message below.'}
              </Text>
            )}
            <View style={styles.summaryFooter}>
              <Text style={styles.summaryMeta}>{inputIssue ? 'Review quantities' : estimate.enteredAssetCount === null ? portfolioStatus === 'loading' ? 'Loading holdings…' : 'Holdings unavailable' : `${estimate.enteredAssetCount} ${estimate.enteredAssetCount === 1 ? 'asset' : 'assets'} entered`}</Text>
              <Text style={styles.summaryMeta}>{overview.data ? `${overview.stale ? 'Earlier prices' : 'Prices retrieved'} ${formatTimestamp(overview.data.retrievedAt)} · CoinGecko` : 'Waiting for prices'}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={overview.loading ? 'Refreshing reference prices' : 'Refresh reference prices'} accessibilityState={{ disabled: overview.loading }} disabled={overview.loading} onPress={refreshOverview} style={({ pressed }) => [styles.refreshPrices, (pressed || overview.loading) && styles.refreshPricesDimmed]}>
              <Text style={styles.refreshPricesText}>{overview.loading ? 'Refreshing prices…' : 'Refresh prices'}</Text>
            </Pressable>
          </View>
          </View>

          <View style={layout.pairedPanels ? styles.summaryPanel : undefined}>
          <PortfolioAllocation positions={allocationPositions} total={allocationTotal} currency={currency} unavailableMessage={allocationMessage} formatValue={(value) => formatPortfolioValue(value, currency)} stale={overview.stale} />
          </View>
          </View>

          <View style={styles.privacyNotice} accessibilityRole="summary">
            <Text style={styles.privacyTitle}>{Platform.OS === 'web' ? 'Browser-only storage' : 'Device-only secure storage'}</Text>
            <Text style={styles.privacyText}>{portfolioPrivacyText}</Text>
          </View>

          <View
            onLayout={({ nativeEvent }) => {
              sectionPositions.current.holdings = nativeEvent.layout.y;
              markSectionLayoutReady('holdings');
            }}
            style={styles.sectionHeader}
          >
            <View>
              <Text accessibilityRole="header" style={styles.sectionTitle}>Manual holdings</Text>
              <Text style={styles.sectionSubtitle}>No wallet connection or imports.</Text>
            </View>
            <Text style={styles.storageStatus} accessibilityLiveRegion="polite">{holdingStatusText}</Text>
          </View>

          <View style={styles.holdingsCard}>
            <Text style={styles.holdingHelp}>Enter a quantity; saves on blur or with Save valid quantities.</Text>
            {ASSETS.map((asset, index) => {
              const quote = overview.data?.coins.find((coin) => coin.id === asset.id);
              const quantity = holdingDrafts[asset.id] ?? holdings[asset.id] ?? '';
              const input = parseHoldingInput(quantity);
              const inputMessage = holdingInputMessage(input);
              const price = typeof quote?.price === 'number' && Number.isFinite(quote.price) && quote.price >= 0 ? quote.price : null;
              const rowValue = estimateHoldingValue(quantity, price);
              const estimatedQuantity = holdingQuantityForEstimate(quantity);
              return (
                <View key={asset.id}>
                  <View style={[styles.holdingRow, index === ASSETS.length - 1 && styles.lastHoldingRow]}>
                  <HoldingsAssetMark coinId={asset.id} />
                  <View style={styles.holdingInfo}>
                    <Text style={styles.holdingName}>{asset.name}</Text>
                    <Text style={styles.holdingSymbol} accessibilityLabel={price !== null && portfolioValueAccessibilityLabel(price, currency) ? `${asset.name} reference price: ${portfolioValueAccessibilityLabel(price, currency)}` : undefined}>{asset.symbol} · {price === null ? 'Price unavailable' : formatPortfolioValue(price, currency, asset.id === 'paypal-usd' ? 4 : undefined)}</Text>
                    {rowValue !== null && Number.isFinite(rowValue) ? <Text style={styles.holdingValue} accessibilityLabel={portfolioValueAccessibilityLabel(rowValue, currency)}>{formatPortfolioValue(rowValue, currency)}</Text> : null}
                    {price !== null && estimatedQuantity !== null && estimatedQuantity > 0 && (
                      <Text style={styles.holdingQuoteUpdate}>Provider update: {formatProviderUpdate(quote?.lastUpdated)}</Text>
                    )}
                  </View>
                  <View style={styles.inputWrap}>
                    <Text style={styles.inputCaption}>Quantity</Text>
                    <TextInput
                      accessibilityLabel={`${asset.name} holding quantity`}
                      accessibilityHint={inputMessage ?? 'Enter a quantity saved locally when you leave this field.'}
                      value={quantity}
                      onChangeText={(value) => setHolding(asset.id, value)}
                      onBlur={() => { commitHolding(asset.id); }}
                      onSubmitEditing={() => { commitHolding(asset.id); }}
                      editable={portfolioReady}
                      placeholder="0"
                      placeholderTextColor={colors.muted}
                      keyboardType="decimal-pad"
                      returnKeyType="done"
                      inputMode="decimal"
                      selectTextOnFocus={portfolioReady}
                      style={[styles.quantityInput, inputMessage && styles.quantityInputError]}
                    />
                  </View>
                  </View>
                  {inputMessage && <Text style={styles.holdingInputMessage} accessibilityLiveRegion="polite">{asset.symbol}: {inputMessage}</Text>}
                </View>
              );
            })}
            <View style={styles.holdingActions}>
              <NativeButton label="Save valid quantities" onPress={commitAllHoldings} disabled={!portfolioReady || !unsavedInputs} compact />
            </View>
          </View>

          {portfolioStatus === 'corrupt' && (
            <View style={styles.marketError} accessibilityRole="summary">
              <Text style={styles.marketErrorTitle}>Saved quantities could not be read</Text>
              <Text style={styles.marketErrorText}>The original data was left untouched and editing is paused. You can forget the unreadable quantities on this device if you want to start again.</Text>
              <View style={styles.contactsForgetButton}>
                <NativeButton label="Forget unreadable quantities" variant="text" onPress={confirmForgetHoldings} />
              </View>
            </View>
          )}
          {portfolioStatus === 'recovery' && portfolioRecovery && (
            <View style={styles.marketError} accessibilityRole="summary">
              <Text style={styles.marketErrorTitle}>Review saved copies</Text>
              <Text style={styles.marketErrorText}>Neither copy is edited automatically. Select a readable copy to keep it in encrypted device storage, or forget both copies.</Text>
              <Text style={styles.marketErrorText}>Encrypted device copy: {portfolioCopySummary(portfolioRecovery.secure)}</Text>
              <Text style={styles.marketErrorText}>Older local copy: {portfolioCopySummary(portfolioRecovery.legacy)}</Text>
              {portfolioRecovery.secure.state === 'readable' && (
                <View style={styles.contactsForgetButton}>
                  <NativeButton label="Keep encrypted device copy" variant="text" onPress={() => confirmPortfolioRecovery('secure')} />
                </View>
              )}
              {portfolioRecovery.legacy.state === 'readable' &&
                portfolioRecovery.secure.state !== 'unavailable' &&
                !recoveryCopiesMatch && (
                <View style={styles.contactsForgetButton}>
                  <NativeButton label="Restore older copy to secure storage" variant="text" onPress={() => confirmPortfolioRecovery('legacy')} />
                </View>
              )}
              {portfolioRecovery.secure.state === 'unavailable' && (
                <Text style={styles.marketErrorText}>Reopen the app when device secure storage is available to restore the older copy.</Text>
              )}
              {portfolioRecoveryMessage && <Text accessibilityLiveRegion="polite" style={styles.contactsWarning}>{portfolioRecoveryMessage}</Text>}
              <View style={styles.contactsForgetButton}>
                <NativeButton label="Forget all saved copies" variant="text" onPress={confirmForgetHoldings} />
              </View>
            </View>
          )}
          {portfolioStatus === 'storage-unavailable' && (
            <View style={styles.marketError} accessibilityRole="summary">
              <Text style={styles.marketErrorTitle}>{Platform.OS === 'web' ? 'Browser storage could not be verified' : 'Secure storage could not be verified'}</Text>
              <Text style={styles.marketErrorText}>Saved quantities could not be checked and editing is paused. Reopen the app when device storage is available.</Text>
            </View>
          )}
          {(portfolioStatus === 'save-unverified' || portfolioStatus === 'save-conflict') && (
            <View style={styles.marketError} accessibilityRole="summary">
              <Text style={styles.marketErrorTitle}>{portfolioStatus === 'save-conflict' ? 'Saved quantities need review' : 'The latest save could not be verified'}</Text>
              <Text style={styles.marketErrorText}>
                {portfolioStatus === 'save-conflict'
                  ? 'The stored copy changed or could not be read. Your edits remain visible here. Retry checks the saved copy again; simultaneous saves in another app window can still overlap.'
                  : 'Your edits remain visible here, but they may or may not already be stored. Keep the app open and retry; the saved copy will be checked first. Simultaneous saves in another app window can still overlap.'}
              </Text>
              <View style={styles.contactsForgetButton}>
                <NativeButton label="Retry saving quantities" variant="text" onPress={() => { void retryPortfolioSave(); }} />
              </View>
              {portfolioStatus === 'save-conflict' && (
                <View style={styles.contactsForgetButton}>
                  <NativeButton label="Discard edits and load saved quantities" variant="text" onPress={confirmLoadSavedPortfolio} />
                </View>
              )}
            </View>
          )}

          {overview.error && (
            <View style={styles.marketError} accessibilityRole="summary">
              <Text style={styles.marketErrorTitle}>{overview.stale ? 'Using earlier reference prices' : 'Reference prices are unavailable'}</Text>
              <Text style={styles.marketErrorText}>{overview.error}</Text>
              {overview.data?.retrievedAt && <Text style={styles.marketErrorText}>Retrieved {formatTimestamp(overview.data.retrievedAt)}</Text>}
              {overview.networkAlternative?.retrievedAt && <Text style={styles.marketErrorText}>Latest response retrieved {formatTimestamp(overview.networkAlternative.retrievedAt)}</Text>}
              {overview.networkAlternative && <NativeButton label="Show latest response" onPress={showLatestOverviewResponse} compact variant="text" />}
            </View>
          )}

          <View
            onLayout={({ nativeEvent }) => {
              sectionPositions.current.venmo = nativeEvent.layout.y;
              markSectionLayoutReady('venmo');
            }}
            style={styles.venmoCard}
          >
            <View style={styles.venmoHeading}>
              <View style={styles.venmoMark}><Text style={styles.venmoMarkText}>v</Text></View>
              <View style={styles.venmoTitleWrap}>
                <Text accessibilityRole="header" style={styles.venmoTitle}>Venmo note draft</Text>
                <Text style={styles.venmoSubtitle}>Prepare text to copy, then review it yourself.</Text>
              </View>
            </View>

            <View style={styles.draftOnlyNotice} accessibilityRole="summary">
              <Text style={styles.draftOnlyText}>Draft only · This app will not send, request, or open anything in Venmo.</Text>
              <Text style={styles.draftOnlyText}>Venmo requires users to be physically in the United States and to meet other eligibility requirements.</Text>
            </View>

            <View style={styles.contactsCard}>
              <Text accessibilityRole="header" style={styles.contactsTitle}>Saved Venmo contacts</Text>
              <Text style={styles.contactsIntro}>
                {Platform.OS === 'web'
                  ? 'Saved contacts require the mobile app’s secure device storage. You can type a recipient for a draft below.'
                  : 'Add names and handles yourself. They stay in encrypted device storage; no address book access or account sync.'}
              </Text>

              {contactsStatus === 'loading' && <Text style={styles.contactsStatus}>Loading secure contacts…</Text>}
              {contactsStatus === 'ready' && savedContacts.length === 0 && (
                <Text style={styles.contactsStatus}>No saved contacts yet.</Text>
              )}
              {contactsStatus === 'ready' && savedContacts.map((contact) => (
                <View key={contact.id} style={styles.contactRow}>
                  <View style={styles.contactInfo}>
                    <Text style={styles.contactName}>{contact.displayName}</Text>
                    <Text style={styles.contactHandle}>@{contact.handle}</Text>
                    {venmoUsernameNeedsReview(contact.handle) && <Text style={styles.contactsWarning}>Check this username in Venmo.</Text>}
                  </View>
                  <View style={styles.contactActions}>
                    <NativeButton
                      label="Use in draft"
                      accessibilityLabel={`Use ${contact.displayName}, @${contact.handle}, in draft`}
                      compact
                      disabled={contactsBusy}
                      onPress={() => selectContactForDraft(contact)}
                    />
                    <NativeButton
                      label="Edit"
                      accessibilityLabel={`Edit ${contact.displayName}, @${contact.handle}`}
                      compact
                      variant="text"
                      disabled={contactsBusy || Boolean(editingContact)}
                      onPress={() => startContactEdit(contact)}
                    />
                    <NativeButton
                      label="Remove"
                      accessibilityLabel={`Remove ${contact.displayName}, @${contact.handle}`}
                      compact
                      variant="text"
                      disabled={contactsBusy || Boolean(editingContact)}
                      onPress={() => confirmRemoveContact(contact)}
                    />
                  </View>
                </View>
              ))}
              {contactsStatus === 'corrupt' && (
                <Text style={styles.contactsWarning}>
                  Saved data is unreadable and has not been replaced. Use the forget control below only if you want it deleted.
                </Text>
              )}
              {contactsStatus === 'unavailable' && (
                <Text style={styles.contactsWarning}>{Platform.OS === 'web' ? 'Saved contacts are unavailable in this browser.' : 'Secure storage is unavailable. The contact list is read-only.'}</Text>
              )}

              {editingContact && (
                <View style={styles.contactEditCard}>
                  <Text accessibilityRole="header" style={styles.contactsTitle}>Edit {editingContact.displayName}</Text>
                  <Text style={styles.contactsIntro}>Editing a contact does not change a recipient already in your draft. Finish or cancel this edit before adding or removing another contact.</Text>
                  <Text style={styles.fieldLabel}>Display name</Text>
                  <TextInput
                    accessibilityLabel="Edit contact display name"
                    accessibilityHint={`A name you enter yourself, up to ${MAX_CONTACT_DISPLAY_NAME_LENGTH} characters.`}
                    value={editDisplayName}
                    onChangeText={updateEditDisplayName}
                    placeholder="Name you recognize"
                    placeholderTextColor={colors.muted}
                    editable={contactsStatus === 'ready' && !contactsBusy}
                    style={styles.textInput}
                  />
                  <Text style={styles.fieldLabel}>Venmo handle</Text>
                  <TextInput
                    accessibilityLabel="Edit saved Venmo handle"
                    accessibilityHint="Enter a handle manually. Phone numbers and email addresses are not accepted."
                    value={editHandle}
                    onChangeText={updateEditHandle}
                    placeholder="@username"
                    placeholderTextColor={colors.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={contactsStatus === 'ready' && !contactsBusy}
                    style={styles.textInput}
                  />
                  {venmoUsernameNeedsReview(editHandle) && <Text accessibilityLiveRegion="polite" style={styles.contactsWarning}>{VENMO_USERNAME_GUIDANCE}</Text>}
                  <View style={styles.contactEditActions}>
                    <NativeButton label={contactsBusy ? 'Saving…' : 'Save contact changes'} onPress={saveContactEdit} disabled={contactsStatus !== 'ready' || contactsBusy} compact />
                    <NativeButton label="Cancel edit" variant="text" onPress={cancelContactEdit} disabled={contactsBusy} compact />
                  </View>
                </View>
              )}

              <Text style={styles.fieldLabel}>Display name</Text>
              <TextInput
                accessibilityLabel="Saved contact display name"
                accessibilityHint={`A name you enter yourself, up to ${MAX_CONTACT_DISPLAY_NAME_LENGTH} characters.`}
                value={contactDisplayName}
                onChangeText={updateContactDisplayName}
                placeholder="Name you recognize"
                placeholderTextColor={colors.muted}
                editable={contactsStatus === 'ready' && !contactsBusy && !editingContact && savedContacts.length < MAX_VENMO_CONTACTS}
                style={styles.textInput}
              />

              <Text style={styles.fieldLabel}>Venmo handle</Text>
              <TextInput
                accessibilityLabel="Saved Venmo handle"
                accessibilityHint="Enter a handle manually. Phone numbers and email addresses are not accepted."
                value={contactHandle}
                onChangeText={updateContactHandle}
                placeholder="@username"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                editable={contactsStatus === 'ready' && !contactsBusy && !editingContact && savedContacts.length < MAX_VENMO_CONTACTS}
                style={styles.textInput}
              />
              {venmoUsernameNeedsReview(contactHandle) && <Text accessibilityLiveRegion="polite" style={styles.contactsWarning}>{VENMO_USERNAME_GUIDANCE}</Text>}

              <View style={styles.contactsSaveButton}>
                <NativeButton
                  label={contactsBusy ? 'Saving…' : 'Save contact on this device'}
                  onPress={addContact}
                  disabled={contactsStatus !== 'ready' || contactsBusy || Boolean(editingContact) || savedContacts.length >= MAX_VENMO_CONTACTS}
                />
              </View>
              {contactsMessage && (
                <Text accessibilityLiveRegion="polite" style={contactsStatus === 'corrupt' || contactsStatus === 'unavailable'
                  ? styles.contactsWarning
                  : styles.contactsMessage}>
                  {contactsMessage}
                </Text>
              )}
              {(contactsStatus === 'corrupt' || (contactsStatus === 'ready' && savedContacts.length > 0)) && (
                <View style={styles.contactsForgetButton}>
                  <NativeButton
                    label={contactsStatus === 'corrupt' ? 'Forget unreadable saved data' : 'Forget all saved contacts'}
                    variant="text"
                    onPress={confirmForgetContacts}
                    disabled={contactsBusy || Boolean(editingContact)}
                  />
                </View>
              )}
            </View>

            <Text style={styles.fieldLabel}>Recipient handle (optional)</Text>
            <TextInput
              accessibilityLabel="Venmo recipient handle, optional"
              accessibilityHint="Type a handle yourself, with an optional @ at the start. Contacts are not imported."
              value={recipient}
              onChangeText={updateRecipient}
              placeholder="@username"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.textInput, Boolean(recipientMessage) && styles.quantityInputError]}
            />
            {recipientMessage && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.draftAmountError}>{recipientMessage}</Text>}
            {venmoUsernameNeedsReview(recipient) && <Text accessibilityLiveRegion="polite" style={styles.contactsWarning}>{VENMO_USERNAME_GUIDANCE}</Text>}
            {draftRecipientNotice && <Text accessibilityLiveRegion="polite" style={styles.contactsWarning}>{draftRecipientNotice}</Text>}

            <Text style={styles.fieldLabel}>Amount in USD (optional)</Text>
            <TextInput
              accessibilityLabel="Draft amount in US dollars, optional"
              accessibilityHint="Use digits with one decimal point or comma and at most two decimal places."
              value={draftAmount}
              onChangeText={updateDraftAmount}
              placeholder="0.00"
              placeholderTextColor={colors.muted}
              keyboardType="decimal-pad"
              inputMode="decimal"
              style={[styles.textInput, Boolean(amountMessage) && styles.quantityInputError]}
            />
            {amountMessage && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.draftAmountError}>{amountMessage}</Text>}

            <Text style={styles.fieldLabel}>Message</Text>
            <TextInput
              accessibilityLabel="Venmo message draft"
              accessibilityHint="This text is only copied to your clipboard if you choose."
              value={draftNote}
              onChangeText={updateDraftNote}
              placeholder="Write a note…"
              placeholderTextColor={colors.muted}
              multiline
              textAlignVertical="top"
              style={[styles.textInput, styles.noteInput, preparedDraft.noteTooLong && styles.quantityInputError]}
            />
            <Text style={styles.characterCount}>{draftNote.length}/280</Text>
            {preparedDraft.noteTooLong && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.draftAmountError}>Use no more than 280 characters for this draft. Some symbols count as more than one.</Text>}

            {preparedDraft.ok && (
              <View style={styles.previewCard}>
                <Text style={styles.previewEyebrow}>PREVIEW</Text>
                <Text style={styles.previewText}>{preparedDraft.text}</Text>
              </View>
            )}

            <View style={styles.copyButton}>
              <NativeButton label={copyBusy ? 'Copying…' : 'Copy draft text'} onPress={() => void copyDraft()} disabled={!preparedDraft.ok || copyBusy} />
            </View>
            {copyMessage && <Text accessibilityLiveRegion="polite" style={styles.copyMessage}>{copyMessage}</Text>}
          </View>

          <Text style={styles.disclosure}>
            Portfolio values are estimates based on CoinGecko reference data. Venmo use is always manual and remains outside this app.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const baseStyles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  content: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 6, paddingBottom: 34 },
  contentWide: { maxWidth: 1160 },
  summaryPanels: { flexDirection: 'row', alignItems: 'flex-start', gap: 20 },
  summaryPanel: { flex: 1, minWidth: 320 },
  titleBlock: { marginBottom: 14 },
  kicker: { color: palette.blue, fontSize: 10, lineHeight: 15, fontWeight: '800', letterSpacing: 0.9, marginBottom: 3 },
  pageTitle: { color: palette.ink, fontSize: 30, lineHeight: 37, fontWeight: '800', letterSpacing: -0.4 },
  subtitle: { color: '#526B83', fontSize: 13, lineHeight: 19, marginTop: 4, maxWidth: 390 },
  summaryCard: { backgroundColor: palette.navy, borderRadius: 20, padding: 18, marginBottom: 12, shadowColor: palette.navy, shadowOpacity: 0.14, shadowRadius: 16, shadowOffset: { width: 0, height: 7 }, elevation: 4 },
  summaryAccent: { position: 'absolute', top: 0, left: 18, width: 42, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, backgroundColor: palette.aqua },
  summaryHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  summaryLabel: { color: '#D2E1F5', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  summaryCurrency: { color: '#D2E1F5', fontSize: 10, lineHeight: 15, fontWeight: '700' },
  summaryValue: { color: '#FFFFFF', fontSize: 32, lineHeight: 40, fontWeight: '800', letterSpacing: -0.4, fontVariant: ['tabular-nums'], marginTop: 8 },
  summaryEmptyState: { flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 8, padding: 11, borderRadius: 14, backgroundColor: '#12377C', borderWidth: 1, borderColor: '#28539B' },
  summaryEmptyIcon: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#00CCFF' },
  summaryEmptyIconText: { color: '#001C64', fontSize: 21, lineHeight: 25, fontWeight: '700' },
  summaryEmptyCopy: { flex: 1 },
  summaryEmptyTitle: { color: palette.surface, fontSize: 12, lineHeight: 17, fontWeight: '800' },
  summaryEmptyText: { color: palette.plotText, fontSize: 11, lineHeight: 16, marginTop: 2 },
  summaryWarning: { color: '#F9DBAA', fontSize: 11, lineHeight: 16, marginTop: 8 },
  summaryFooter: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6, marginTop: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: palette.plotGrid },
  summaryMeta: { color: '#D2E1F5', fontSize: 10, lineHeight: 15, fontWeight: '600' },
  refreshPrices: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingRight: 14, marginTop: 2 },
  refreshPricesDimmed: { opacity: 0.65 },
  refreshPricesText: { color: '#E4F2FF', fontSize: 12, fontWeight: '700' },
  privacyNotice: { backgroundColor: '#EDF5FD', borderWidth: 1, borderColor: '#DAE9F9', borderRadius: 15, padding: 12, marginBottom: 18 },
  privacyTitle: { color: '#2B5278', fontSize: 12, fontWeight: '800', marginBottom: 4 },
  privacyText: { color: '#425C74', fontSize: 11, lineHeight: 17 },
  sectionJumpBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-start', gap: 8, paddingTop: 7, paddingBottom: 8, marginBottom: 4, backgroundColor: palette.canvas, borderBottomWidth: 1, borderBottomColor: palette.line, zIndex: 2, elevation: 2 },
  sectionJumpButton: { flexBasis: 150, flexGrow: 0, flexShrink: 1, minWidth: 120, maxWidth: 280, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderColor: palette.line, borderRadius: 12, backgroundColor: palette.surface },
  sectionJumpButtonDisabled: { opacity: 0.55 },
  sectionJumpButtonPressed: { opacity: 0.72 },
  sectionJumpText: { color: '#315A83', fontSize: 12, lineHeight: 17, fontWeight: '800', textAlign: 'center' },
  sectionHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 9, marginBottom: 12 },
  sectionTitle: { color: '#142C4E', fontSize: 16, lineHeight: 22, fontWeight: '800' },
  sectionSubtitle: { color: '#526B83', fontSize: 12, lineHeight: 17, marginTop: 2 },
  storageStatus: { color: '#526B83', fontSize: 10, lineHeight: 15, textAlign: 'right', flexShrink: 1 },
  holdingsCard: { backgroundColor: palette.surface, borderRadius: 20, paddingHorizontal: 13, borderWidth: 1, borderColor: palette.line, marginBottom: 16 },
  holdingRow: { minHeight: 84, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: palette.line, paddingVertical: 10 },
  lastHoldingRow: { borderBottomWidth: 0 },
  assetMark: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  assetMarkText: { fontSize: 20, fontWeight: '800' },
  holdingInfo: { flex: 1, minWidth: 90 },
  holdingName: { color: palette.ink, fontSize: 13, fontWeight: '800' },
  holdingSymbol: { color: palette.muted, fontSize: 11, fontWeight: '600', marginTop: 3 },
  holdingValue: { color: palette.blue, fontSize: 11, fontWeight: '700', marginTop: 3, fontVariant: ['tabular-nums'] },
  holdingQuoteUpdate: { color: '#526B83', fontSize: 10, lineHeight: 14, marginTop: 3 },
  holdingHelp: { color: '#526B83', fontSize: 11, lineHeight: 16, paddingTop: 12 },
  holdingInputMessage: { color: '#9A312C', fontSize: 11, lineHeight: 16, paddingBottom: 10 },
  holdingActions: { alignItems: 'flex-end', paddingTop: 8, paddingBottom: 10 },
  inputWrap: { alignItems: 'flex-end', width: 96 },
  inputCaption: { color: '#526B83', fontSize: 10, fontWeight: '700', marginBottom: 3 },
  quantityInput: { width: 94, minHeight: 48, borderWidth: 1, borderColor: palette.line, borderRadius: 12, backgroundColor: palette.ice, color: palette.ink, paddingHorizontal: 9, paddingVertical: 8, textAlign: 'right', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  quantityInputError: { borderColor: '#A6322D' },
  marketError: { borderRadius: 14, backgroundColor: '#FFF7E8', padding: 12, marginBottom: 18, borderWidth: 1, borderColor: '#F3DFB9' },
  marketErrorTitle: { color: '#725623', fontSize: 11, fontWeight: '800' },
  marketErrorText: { color: '#6C5122', fontSize: 11, lineHeight: 16, marginTop: 4 },
  venmoCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 17, borderWidth: 1, borderColor: '#DFE8F2', marginTop: 4, marginBottom: 17 },
  venmoHeading: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 15 },
  venmoMark: { width: 41, height: 41, borderRadius: 14, backgroundColor: '#E6F4F3', alignItems: 'center', justifyContent: 'center' },
  venmoMarkText: { color: '#168C83', fontSize: 24, fontWeight: '800', fontStyle: 'italic' },
  venmoTitleWrap: { flex: 1 },
  venmoTitle: { color: '#142C4E', fontSize: 16, fontWeight: '800' },
  venmoSubtitle: { color: '#526B83', fontSize: 11, lineHeight: 16, marginTop: 3 },
  draftOnlyNotice: { padding: 10, backgroundColor: '#F0F8F7', borderRadius: 12, marginBottom: 15 },
  draftOnlyText: { color: '#3F6C69', fontSize: 10, fontWeight: '700', lineHeight: 15 },
  contactsCard: { backgroundColor: '#F8FAFC', borderRadius: 16, padding: 12, borderWidth: 1, borderColor: '#E5ECF3', marginBottom: 15 },
  contactsTitle: { color: '#264660', fontSize: 13, fontWeight: '800' },
  contactsIntro: { color: '#526B83', fontSize: 11, lineHeight: 16, marginTop: 5, marginBottom: 7 },
  contactsStatus: { color: '#526B83', fontSize: 11, lineHeight: 16, paddingVertical: 7 },
  contactsWarning: { color: '#815E28', fontSize: 10, lineHeight: 15, marginVertical: 7 },
  contactsMessage: { color: '#3F6C69', fontSize: 10, lineHeight: 15, marginTop: 7 },
  contactRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#E8EEF4' },
  contactInfo: { flex: 1, minWidth: 75 },
  contactName: { color: '#24425E', fontSize: 11, fontWeight: '800' },
  contactHandle: { color: '#526B83', fontSize: 11, marginTop: 3 },
  contactActions: { flexDirection: 'row', flexWrap: 'wrap', flexShrink: 1, justifyContent: 'flex-end', alignItems: 'center', gap: 3 },
  contactEditCard: { backgroundColor: '#FFFFFF', borderColor: '#D9E7F4', borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 8, marginBottom: 4 },
  contactEditActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8 },
  contactsSaveButton: { marginTop: 3 },
  contactsForgetButton: { alignSelf: 'flex-start', marginTop: 7 },
  fieldLabel: { color: '#456079', fontSize: 11, fontWeight: '800', marginBottom: 6, marginTop: 4 },
  textInput: { minHeight: 48, borderWidth: 1, borderColor: '#CAD8E7', borderRadius: 13, backgroundColor: '#FBFCFE', color: '#142C4E', paddingHorizontal: 12, fontSize: 13, marginBottom: 11 },
  draftAmountError: { color: '#9A312C', fontSize: 11, lineHeight: 16, marginTop: -5, marginBottom: 10 },
  noteInput: { minHeight: 93, paddingTop: 11 },
  characterCount: { color: '#526B83', fontSize: 10, textAlign: 'right', marginTop: -5, marginBottom: 8 },
  previewCard: { backgroundColor: '#F5F8FB', borderRadius: 14, padding: 12, borderWidth: 1, borderColor: '#E8EEF4', marginTop: 4 },
  previewEyebrow: { color: '#526B83', fontSize: 10, fontWeight: '800', letterSpacing: 1, marginBottom: 6 },
  previewText: { color: '#405872', fontSize: 12, lineHeight: 18 },
  copyButton: { marginTop: 15 },
  copyMessage: { color: '#2F6B4B', fontSize: 11, lineHeight: 16, marginTop: 8 },
  disclosure: { color: '#526B83', fontSize: 11, lineHeight: 17, paddingHorizontal: 3 },
});
