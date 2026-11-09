import AsyncStorage from "@react-native-async-storage/async-storage";
import type { createCustomerStorageFence, CustomerStorageLease } from "./customer-storage-scope";
import {
  DEFAULT_BUSINESS_THRESHOLDS,
  encodeBusinessThresholds,
  parseBusinessThresholds,
  type BusinessThresholds,
} from "./business-thresholds";

type Fence = Pick<ReturnType<typeof createCustomerStorageFence>, "capture" | "isCurrent">;
type ReadResult =
  | { status: "ready"; thresholds: BusinessThresholds; source: "default" | "saved" }
  | { status: "unreadable" | "unavailable" };
type SaveResult = { status: "saved" } | { status: "unreadable" | "unavailable" };
type ResetResult = { status: "reset" | "unchanged" | "unavailable" };

// Keep one queue per captured destination. BusinessContent can unmount when a
// customer switches account views, so a repository-local queue is not enough.
const storageQueues = new Map<string, Promise<void>>();

function serializeByKey<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = storageQueues.get(key) ?? Promise.resolve();
  const operation = previous.then(task, task);
  const settled = operation.then(() => undefined, () => undefined);
  storageQueues.set(key, settled);
  void settled.then(() => {
    if (storageQueues.get(key) === settled) storageQueues.delete(key);
  });
  return operation;
}

/** Store numeric preferences only, under the current guest or verified owner scope. */
export function createBusinessThresholdPreferencesRepository(fence: Fence) {
  const anchor = fence.capture("businessThresholds");
  const current = (lease: CustomerStorageLease | null): lease is CustomerStorageLease =>
    Boolean(anchor && lease && fence.isCurrent(anchor) && fence.isCurrent(lease));
  const capture = () => fence.isCurrent(anchor) ? fence.capture("businessThresholds") : null;

  async function readWith(lease: CustomerStorageLease | null): Promise<ReadResult> {
    if (!current(lease)) return { status: "unavailable" };
    try {
      const raw = await AsyncStorage.getItem(lease.key);
      if (!current(lease)) return { status: "unavailable" };
      if (raw === null) return { status: "ready", thresholds: DEFAULT_BUSINESS_THRESHOLDS, source: "default" };
      const thresholds = parseBusinessThresholds(raw);
      return thresholds ? { status: "ready", thresholds, source: "saved" } : { status: "unreadable" };
    } catch {
      return { status: "unavailable" };
    }
  }

  return {
    isCurrent: () => fence.isCurrent(anchor),
    read(): Promise<ReadResult> {
      const lease = capture();
      return lease ? serializeByKey(lease.key, () => readWith(lease)) : Promise.resolve({ status: "unavailable" });
    },
    save(thresholds: BusinessThresholds): Promise<SaveResult> {
      const lease = capture();
      const encoded = encodeBusinessThresholds(thresholds);
      const run = async (): Promise<SaveResult> => {
        if (!current(lease) || encoded === null) return { status: "unavailable" };
        const before = await readWith(lease);
        if (!current(lease)) return { status: "unavailable" };
        if (before.status !== "ready") return before;
        try {
          if (!current(lease)) return { status: "unavailable" };
          await AsyncStorage.setItem(lease.key, encoded);
          if (!current(lease)) return { status: "unavailable" };
          const stored = await AsyncStorage.getItem(lease.key);
          if (!current(lease) || stored !== encoded) return { status: "unavailable" };
          return { status: "saved" };
        } catch {
          return { status: "unavailable" };
        }
      };
      return lease ? serializeByKey(lease.key, run) : Promise.resolve({ status: "unavailable" });
    },
    resetIfUnreadable(): Promise<ResetResult> {
      const lease = capture();
      if (!lease) return Promise.resolve({ status: "unavailable" });
      return serializeByKey(lease.key, async () => {
        if (!current(lease)) return { status: "unavailable" };
        const before = await readWith(lease);
        if (!current(lease)) return { status: "unavailable" };
        if (before.status === "unavailable") return { status: "unavailable" };
        if (before.status === "ready") return { status: "unchanged" };
        try {
          await AsyncStorage.removeItem(lease.key);
          if (!current(lease)) return { status: "unavailable" };
          const stored = await AsyncStorage.getItem(lease.key);
          if (!current(lease) || stored !== null) return { status: "unavailable" };
          return { status: "reset" };
        } catch {
          return { status: "unavailable" };
        }
      });
    },
  };
}
