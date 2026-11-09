/** Accept only ordinary HTTPS hosts for images and retailer handoffs. */
export function safeChannel3Url(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character <= 0x1f || character === 0x7f) return null;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const isAddressLiteral = hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(hostname);
    const hasValidLabels = hostname.split('.').every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
    if (
      url.protocol !== 'https:' ||
      !hostname.includes('.') ||
      isAddressLiteral ||
      !hasValidLabels ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.localdomain') ||
      hostname.endsWith('.lan') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.home.arpa') ||
      url.username !== '' ||
      url.password !== '' ||
      (url.port !== '' && url.port !== '443')
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** An image may start only at Channel3's image host, never an arbitrary retailer. */
export function safeChannel3ImageUrl(value: unknown): string | null {
  const url = safeChannel3Url(value);
  if (!url) return null;
  return new URL(url).hostname.toLowerCase().replace(/\.$/, '') === 'cdn.trychannel3.com' ? url : null;
}

/** Prefer the marked main image, falling back to the next usable image. */
export function selectChannel3Image(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const candidates = value.slice(0, 6).filter((item): item is Record<string, unknown> =>
    typeof item === 'object' && item !== null && !Array.isArray(item));
  const ordered = [...candidates.filter((image) => image.is_main_image === true), ...candidates.filter((image) => image.is_main_image !== true)];
  for (const image of ordered) {
    for (const candidate of [image.cleaned_url, image.url]) {
      const url = safeChannel3ImageUrl(candidate);
      if (url) return url;
    }
  }
  return null;
}
