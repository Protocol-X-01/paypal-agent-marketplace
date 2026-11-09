import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { encodeCustomerHandle, isCanonicalCustomerHandle } from './customer-session-links';

/** Native-only secrets; never use the synchronous development random fallback. */
export async function createCustomerSignInSecrets(): Promise<Readonly<{
  state: string; codeVerifier: string; codeChallenge: string; codeChallengeMethod: 'S256';
}>> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') throw new Error('Native sign-in is unavailable.');
  try {
    const state = encodeCustomerHandle(await Crypto.getRandomBytesAsync(32));
    const codeVerifier = encodeCustomerHandle(await Crypto.getRandomBytesAsync(32));
    if (state === codeVerifier) throw new Error('Random generation failed.');
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, codeVerifier, { encoding: Crypto.CryptoEncoding.BASE64 });
    if (typeof digest !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(digest)) throw new Error('Digest unavailable.');
    const codeChallenge = digest.slice(0, -1).replace(/\+/g, '-').replace(/\//g, '_');
    if (!isCanonicalCustomerHandle(codeChallenge)) throw new Error('Digest unavailable.');
    return Object.freeze({ state, codeVerifier, codeChallenge, codeChallengeMethod: 'S256' as const });
  } catch {
    throw new Error('Native sign-in secrets could not be prepared.');
  }
}
