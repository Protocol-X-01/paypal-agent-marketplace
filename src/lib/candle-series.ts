/** A provider candle, timestamped at the close of its interval in UTC milliseconds. */
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function checkedPeriod(period: number): number {
  if (!Number.isSafeInteger(period) || period < 1) throw new RangeError('Indicator period must be a positive integer.');
  return period;
}

/** Values align to the original candles; invalid values restart the warmup. */
export function calculateSma(closes: readonly number[], period = 20): (number | null)[] {
  checkedPeriod(period);
  const result: (number | null)[] = Array(closes.length).fill(null);
  let sum = 0;
  let runStart = 0;
  closes.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      sum = 0;
      runStart = index + 1;
      return;
    }
    sum += value;
    if (index - runStart >= period) sum -= closes[index - period]!;
    if (!Number.isFinite(sum)) {
      sum = 0;
      runStart = index + 1;
    } else if (index - runStart + 1 >= period) {
      result[index] = sum / period;
    }
  });
  return result;
}

/** EMA starts at the simple average of the first complete period. */
export function calculateEma(closes: readonly number[], period = 20): (number | null)[] {
  checkedPeriod(period);
  const result: (number | null)[] = Array(closes.length).fill(null);
  const alpha = 2 / (period + 1);
  let count = 0;
  let sum = 0;
  let average: number | null = null;
  closes.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      count = 0;
      sum = 0;
      average = null;
      return;
    }
    if (average === null) {
      count += 1;
      sum += value;
      if (!Number.isFinite(sum)) {
        count = 0;
        sum = 0;
      } else if (count === period) {
        average = sum / period;
        result[index] = average;
      }
      return;
    }
    average += alpha * (value - average);
    if (Number.isFinite(average)) result[index] = average;
    else {
      count = 0;
      sum = 0;
      average = null;
    }
  });
  return result;
}

/** Wilder RSI needs one more close than its period to observe that many changes. */
export function calculateRsi(closes: readonly number[], period = 14): (number | null)[] {
  checkedPeriod(period);
  const result: (number | null)[] = Array(closes.length).fill(null);
  let previous: number | null = null;
  let count = 0;
  let averageGain = 0;
  let averageLoss = 0;
  closes.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      previous = null;
      count = 0;
      averageGain = 0;
      averageLoss = 0;
      return;
    }
    if (previous === null) {
      previous = value;
      return;
    }
    const change = value - previous;
    previous = value;
    if (!Number.isFinite(change)) {
      previous = null;
      count = 0;
      averageGain = 0;
      averageLoss = 0;
      return;
    }
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (count < period) {
      averageGain += gain / period;
      averageLoss += loss / period;
      count += 1;
    } else {
      averageGain += (gain - averageGain) / period;
      averageLoss += (loss - averageLoss) / period;
    }
    if (count === period) {
      result[index] = averageGain === 0 && averageLoss === 0 ? 50
        : averageLoss === 0 ? 100
          : averageGain === 0 ? 0
            : 100 - 100 / (1 + averageGain / averageLoss);
    }
  });
  return result;
}

/** Map a horizontal fraction to equal-width candle slots in [start, end). */
export function candleIndexAtRatio(ratio: number, start: number, end: number): number | null {
  if (!Number.isFinite(ratio) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
  const width = end - start;
  return start + Math.min(width - 1, Math.floor(Math.max(0, Math.min(1, ratio)) * width));
}
