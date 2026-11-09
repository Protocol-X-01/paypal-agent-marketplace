import "server-only";
import { createHash } from "node:crypto";
import { readNativeAuthConfig, type NativeAuthConfig } from "./native-config";
import { createNativeAuthController } from "./native-controller";
import { createNativePostgresStore } from "./native-store";
import { createPayPalProvider, type CustomerAuthProvider } from "./provider";

let storeCache: { key: string; value: ReturnType<typeof createNativePostgresStore> } | null = null;
function store(config: NativeAuthConfig) {
  const key = createHash("sha256").update(config.databaseUrl).digest("hex");
  if (!storeCache || storeCache.key !== key) {
    const old = storeCache;
    storeCache = { key, value: createNativePostgresStore({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: true } }) };
    if (old) void old.value.close().catch(() => {});
  }
  return storeCache.value;
}
let providerCache: { key: string; until: number; value: Promise<CustomerAuthProvider> } | null = null;
function provider(config: NativeAuthConfig) {
  const key = config.contextHash;
  if (providerCache?.key === key && providerCache.until > Date.now()) return providerCache.value;
  const entry = { key, until: Date.now() + 300000, value: Promise.resolve(createPayPalProvider(config)) };
  providerCache = entry;
  void entry.value.catch(() => { if (providerCache === entry) entry.until = Date.now() + 15000; });
  return entry.value;
}
export const nativeCustomerAuth = createNativeAuthController({ config: () => readNativeAuthConfig(process.env), store, provider });
