import type { CoinId } from './market';

export const MAX_HOLDING_INPUT_LENGTH = 32;
export const MAX_HOLDING_DECIMALS = 10;
export const MAX_ESTIMATED_HOLDING = 1_000_000_000_000;
export const MAX_ESTIMATED_SIGNIFICANT_DIGITS = 15;

export type HoldingAmounts = Partial<Record<CoinId, string>>;
export type HoldingDrafts = Partial<Record<CoinId, string>>;
export type HoldingInput =
  | { kind: 'empty' }
  | { kind: 'incomplete' }
  | { kind: 'invalid'; reason: 'length' | 'format' | 'precision' }
  | { kind: 'valid'; value: string };

export type HoldingInputState = { holdings: HoldingAmounts; drafts: HoldingDrafts };

/** Classify the text without discarding or changing unsupported input. */
export function parseHoldingInput(value: string): HoldingInput {
  if (value === '') return { kind: 'empty' };
  if (value.length > MAX_HOLDING_INPUT_LENGTH) return { kind: 'invalid', reason: 'length' };
  if (value === '.' || value === ',' || /^\d+[.,]$/.test(value)) return { kind: 'incomplete' };
  if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(value)) return { kind: 'invalid', reason: 'format' };
  const fraction = value.split(/[.,]/)[1];
  if (fraction && fraction.length > MAX_HOLDING_DECIMALS) return { kind: 'invalid', reason: 'precision' };
  return { kind: 'valid', value: value.replace(',', '.') };
}

/** Keep strings intact in storage, but bound the precision of Number-based estimates. */
export function holdingQuantityForEstimate(value: string): number | null {
  const input = parseHoldingInput(value);
  if (input.kind !== 'valid') return null;
  const significant = input.value.replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  const quantity = Number(input.value);
  if (significant.length > MAX_ESTIMATED_SIGNIFICANT_DIGITS || !Number.isFinite(quantity) || quantity > MAX_ESTIMATED_HOLDING) return null;
  return quantity;
}

export function replaceHoldingInputs(holdings: HoldingAmounts): HoldingInputState {
  return { holdings, drafts: { ...holdings } };
}

export function editHoldingInput(state: HoldingInputState, id: CoinId, value: string): HoldingInputState {
  return { holdings: state.holdings, drafts: { ...state.drafts, [id]: value } };
}

/** Only complete supported text can change the quantity queued for storage. */
export function commitHoldingInput(state: HoldingInputState, id: CoinId): { state: HoldingInputState; accepted: boolean; changed: boolean } {
  const draft = parseHoldingInput(state.drafts[id] ?? '');
  if (draft.kind === 'invalid' || draft.kind === 'incomplete') return { state, accepted: false, changed: false };
  const nextValue = draft.kind === 'valid' ? draft.value : undefined;
  const previous = state.holdings[id] || undefined;
  if (nextValue === previous) return { state, accepted: true, changed: false };
  const holdings = { ...state.holdings };
  if (nextValue === undefined) delete holdings[id];
  else holdings[id] = nextValue;
  return { state: { holdings, drafts: state.drafts }, accepted: true, changed: true };
}

export function previewHoldingInputs(state: HoldingInputState): HoldingAmounts {
  const preview = { ...state.holdings };
  for (const [id, value] of Object.entries(state.drafts) as [CoinId, string][]) {
    const draft = parseHoldingInput(value);
    if (draft.kind === 'valid') preview[id] = draft.value;
    else delete preview[id];
  }
  return preview;
}

export function hasHoldingInputIssue(drafts: HoldingDrafts): boolean {
  return Object.values(drafts).some((value) => {
    const draft = parseHoldingInput(value);
    return draft.kind === 'invalid' || draft.kind === 'incomplete';
  });
}

export function hasUnsavedHoldingInputs(state: HoldingInputState): boolean {
  return Object.entries(state.drafts).some(([id, value]) => {
    const draft = parseHoldingInput(value);
    if (draft.kind === 'invalid' || draft.kind === 'incomplete') return true;
    const nextValue = draft.kind === 'valid' ? draft.value : undefined;
    return nextValue !== (state.holdings[id as CoinId] || undefined);
  });
}
