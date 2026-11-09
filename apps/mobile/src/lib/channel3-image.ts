import { safeChannel3ImageUrl } from './channel3-url';

export const CHANNEL3_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const CHANNEL3_IMAGE_MAX_CONCURRENT = 3;
export const CHANNEL3_IMAGE_MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const CHANNEL3_IMAGE_MAX_QUEUED = 32;
const CHANNEL3_IMAGE_TIMEOUT_MS = 10_000;
const IMAGE_TYPES = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

type ImageRequest = (url: string, options: RequestInit) => Promise<Response>;
type ImageLoaderOptions = { maxBytes?: number; maxConcurrent?: number; maxQueued?: number; maxRetainedBytes?: number; timeoutMs?: number };
export type Channel3ImageLease = { uri: string; release: () => void };
type PendingImage = {
  url: string;
  signal: AbortSignal;
  resolve: (lease: Channel3ImageLease) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
};

function canceled(): Error {
  return new Error('Product image request was canceled.');
}

/** Encode bounded binary bytes without Node globals or a native Blob provider. */
function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let part = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    const combined = (first << 16) | (second << 8) | third;
    part += BASE64[(combined >>> 18) & 63] + BASE64[(combined >>> 12) & 63]
      + (hasSecond ? BASE64[(combined >>> 6) & 63] : '=') + (hasThird ? BASE64[combined & 63] : '=');
    if (part.length >= 8192) { parts.push(part); part = ''; }
  }
  if (part) parts.push(part);
  return parts.join('');
}

/**
 * Fetch a bounded number of public Channel3 thumbnails at once.
 * Expo's native transport may buffer or queue bytes before JS can cancel;
 * the limit bounds accepted image data, not peak native memory usage.
 */
export function createChannel3ImageLoader(request: ImageRequest, options: ImageLoaderOptions = {}) {
  const maxBytes = options.maxBytes ?? CHANNEL3_IMAGE_MAX_BYTES;
  const maxConcurrent = options.maxConcurrent ?? CHANNEL3_IMAGE_MAX_CONCURRENT;
  const maxQueued = options.maxQueued ?? CHANNEL3_IMAGE_MAX_QUEUED;
  const maxRetainedBytes = options.maxRetainedBytes ?? CHANNEL3_IMAGE_MAX_RETAINED_BYTES;
  const timeoutMs = options.timeoutMs ?? CHANNEL3_IMAGE_TIMEOUT_MS;
  const queue: PendingImage[] = [];
  let active = 0;
  let retainedBytes = 0;

  async function readImage(url: string, signal: AbortSignal): Promise<Channel3ImageLease> {
    if (signal.aborted) throw canceled();
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    signal.addEventListener('abort', onExternalAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(canceled());
      if (controller.signal.aborted) onAbort();
      else {
        controller.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
      }
    });
    let body: ReadableStream<Uint8Array> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let complete = false;

    try {
      const response = await Promise.race([request(url, {
        method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', signal: controller.signal,
      }), aborted]);
      body = response.body;
      if (!response.ok || response.redirected || (response.url && !safeChannel3ImageUrl(response.url))) {
        throw new Error('Product image is unavailable.');
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
      if (!IMAGE_TYPES.has(contentType)) throw new Error('Unsupported product image type.');
      const declaredLength = response.headers.get('content-length');
      if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength)) || Number(declaredLength) > maxBytes)) {
        throw new Error('Product image is too large or has an invalid length.');
      }
      if (!body) throw new Error('Product image is empty.');
      reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) { complete = true; break; }
        size += value.byteLength;
        if (size > maxBytes) throw new Error('Product image is too large.');
        chunks.push(value);
      }
      if (!size) throw new Error('Product image is empty.');
      if (retainedBytes + size > maxRetainedBytes) throw new Error('Product image memory limit reached.');
      retainedBytes += size;
      let released = false;
      const release = () => {
        if (!released) { released = true; retainedBytes -= size; }
      };
      try {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        if (controller.signal.aborted || signal.aborted) throw canceled();
        const encoded = encodeBase64(bytes);
        if (controller.signal.aborted || signal.aborted) throw canceled();
        return { uri: `data:${contentType};base64,${encoded}`, release };
      } catch (error) {
        release();
        throw error;
      }
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onExternalAbort);
      removeAbortListener();
      if (!complete) controller.abort();
      if (reader) {
        if (!complete) { try { void reader.cancel().catch(() => undefined); } catch { /* Already canceled. */ } }
        try { reader.releaseLock(); } catch { /* Already released. */ }
      } else if (body) {
        try { void body.cancel().catch(() => undefined); } catch { /* Already canceled. */ }
      }
    }
  }

  function drain() {
    while (active < maxConcurrent && queue.length) {
      const pending = queue.shift()!;
      pending.signal.removeEventListener('abort', pending.onAbort);
      if (pending.signal.aborted) { pending.reject(canceled()); continue; }
      active += 1;
      void readImage(pending.url, pending.signal).then(pending.resolve, pending.reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  }

  function load(value: unknown, signal: AbortSignal): Promise<Channel3ImageLease> {
    const url = safeChannel3ImageUrl(value);
    if (!url) return Promise.reject(new Error('Unsupported product image URL.'));
    if (signal.aborted) return Promise.reject(canceled());
    if (queue.length >= maxQueued) return Promise.reject(new Error('Product image queue is full.'));
    return new Promise((resolve, reject) => {
      const pending: PendingImage = {
        url, signal, resolve, reject,
        onAbort: () => {
          const index = queue.indexOf(pending);
          if (index !== -1) { queue.splice(index, 1); reject(canceled()); }
        },
      };
      signal.addEventListener('abort', pending.onAbort, { once: true });
      queue.push(pending);
      drain();
    });
  }

  return { load };
}
