import "server-only";

import { createHmac } from "node:crypto";
import { authContextFingerprint, readAuthConfig, type AuthConfig } from "./config";
import { validateNativeLinkPolicy, type NativeLinkPolicy } from "./native-protocol";

export type NativeAuthConfig = AuthConfig & {
  links: NativeLinkPolicy;
  callback: string;
  contextHash: string;
};

/** Operator acknowledgements gate enablement; they do not verify deployed links or edge controls. */
export function readNativeAuthConfig(env: NodeJS.ProcessEnv): NativeAuthConfig | null {
  if (env.PAYPAL_NATIVE_LOGIN_ENABLED !== "true" ||
      env.PAYPAL_NATIVE_LINKS_VERIFIED !== "true" ||
      env.PAYPAL_NATIVE_EDGE_CONTROLS_VERIFIED !== "true") return null;
  const base = readAuthConfig(env);
  if (!base) return null;
  try {
    const links = validateNativeLinkPolicy({
      origin: base.origin,
      android: env.AUTH_NATIVE_ANDROID_RETURN_URL ?? "",
      ios: env.AUTH_NATIVE_IOS_RETURN_URL ?? "",
    });
    const callback = `${base.origin}/api/auth/native/paypal/callback`;
    const contextHash = createHmac("sha256", Buffer.from(base.subjectHmacKey, "base64url"))
      .update(JSON.stringify(["paypal-markets-native-context-v1", authContextFingerprint(base), callback, links.android, links.ios]))
      .digest("hex");
    return { ...base, links, callback, contextHash };
  } catch {
    return null;
  }
}
