import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { paletteForAppearance, type Appearance, type Palette } from '@/lib/palette';

export const APPEARANCE_STORAGE_KEY = 'paypal-markets-appearance-v1';

type ThemeState = {
  appearance: Appearance;
  palette: Palette;
  setAppearance: (appearance: Appearance) => void;
};

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<Appearance>('dark');
  const revision = useRef(0);
  const writes = useRef(Promise.resolve());

  useEffect(() => {
    const initialRevision = revision.current;
    let active = true;
    void AsyncStorage.getItem(APPEARANCE_STORAGE_KEY).then((stored) => {
      if (!active || revision.current !== initialRevision) return;
      if (stored === 'light' || stored === 'dark') setAppearanceState(stored);
    }).catch(() => {
      // Keep the dark default when the local preference cannot be read.
    });
    return () => { active = false; };
  }, []);

  const setAppearance = useCallback((next: Appearance) => {
    revision.current += 1;
    setAppearanceState(next);
    writes.current = writes.current.catch(() => undefined)
      .then(() => AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, next))
      .catch(() => undefined);
  }, []);

  const value = useMemo(() => ({ appearance, palette: paletteForAppearance(appearance), setAppearance }), [appearance, setAppearance]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('ThemeProvider is missing');
  return theme;
}

export function usePalette(): Palette {
  return useTheme().palette;
}

export function useThemedStyles<T>(create: (palette: Palette) => T): T {
  const { palette } = useTheme();
  return useMemo(() => create(palette), [create, palette]);
}

type StyleValue = string | number | boolean | null | undefined | StyleValue[] | { [key: string]: StyleValue };

const FEATURE_TEXT_STYLES = /^(selected|summary|businessBalance|businessMetric|businessSource|assetName$|assetSymbol$|mainValue$|valueCaption$)/i;
const PRODUCT_IMAGE_STYLES = /product.*(glyph|image|thumbnail)|^(productGlyph|productImage|productThumbnail)$/i;

function channels(value: string): [number, number, number] | null {
  const match = /^#([\da-f]{6})$/i.exec(value);
  if (!match) return null;
  return [0, 2, 4].map((index) => Number.parseInt(match[1]!.slice(index, index + 2), 16)) as [number, number, number];
}

function colorStats([red, green, blue]: [number, number, number]) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { hue, saturation, lightness };
}

function legacyColor(value: string, property: string, styleName: string, colors: Palette): string {
  const normalized = value.trim().toLowerCase();
  const dark = paletteForAppearance('dark');
  const semanticTokens: [keyof Palette, string][] = (Object.keys(dark) as (keyof Palette)[])
    .map((key) => [key, dark[key]]);
  const token = semanticTokens.find(([, tokenValue]) => tokenValue.toLowerCase() === normalized)?.[0];
  if (token) {
    const isFeatureText = FEATURE_TEXT_STYLES.test(styleName);
    if (token === 'onBlue' && property === 'backgroundColor') {
      return PRODUCT_IMAGE_STYLES.test(styleName) ? value : colors.surface;
    }
    if (token === 'onBlue' && property === 'color' && isFeatureText) return colors.featureInk;
    if (token === 'ink' && isFeatureText) return colors.featureInk;
    if ((token === 'muted' || token === 'plotText') && isFeatureText) return colors.featureMuted;
    if (token === 'navy') return property === 'color' ? colors.ink : property === 'backgroundColor' ? colors.featureSurface : colors.featureSurface;
    if (token === 'surface' && property === 'color') return colors.onBlue;
    if (token === 'blue' && property === 'color') return colors.link;
    return colors[token];
  }

  const rgb = channels(normalized);
  if (!rgb) {
    if (normalized === 'rgba(255, 255, 255, 0.14)' || normalized === 'rgba(16, 42, 76, 0.14)') return colors.line;
    return value;
  }

  const { hue, saturation, lightness } = colorStats(rgb);
  const isFeatureText = FEATURE_TEXT_STYLES.test(styleName);
  const isImageTile = PRODUCT_IMAGE_STYLES.test(styleName);
  const isColorProperty = property === 'color' || property === 'tintColor';
  const isBackground = property === 'backgroundColor';

  if (isColorProperty) {
    if (isFeatureText && lightness >= 0.72) return normalized === '#ffffff' ? colors.featureInk : colors.featureMuted;
    if (lightness >= 0.96 && saturation < 0.12) return colors.onBlue;
    if ((hue < 16 || hue > 344) && saturation > 0.35) return colors.negative;
    if (hue >= 78 && hue <= 165 && saturation > 0.25) return colors.positive;
    if (hue >= 18 && hue <= 62 && saturation > 0.35) return colors.warning;
    if (saturation > 0.24 && hue >= 175 && hue <= 270) return colors.link;
    return lightness < 0.42 ? colors.ink : colors.muted;
  }

  if (property === 'shadowColor') {
    return lightness < 0.45 ? colors.featureSurface : value;
  }

  if (isBackground) {
    if (styleName === 'plotSurface') return colors.canvas;
    if (styleName === 'businessOverview' || styleName === 'selectedCard' || styleName === 'summaryCard') return colors.featureSurface;
    if (styleName === 'businessMetric') return colors.featureInset;
    if (isImageTile && lightness >= 0.86) return value;
    if (lightness >= 0.96 && saturation < 0.12) return colors.surface;
    if (lightness >= 0.76) {
      if ((hue < 16 || hue > 344) && saturation > 0.16) return colors.negativeWash;
      if (hue >= 78 && hue <= 165 && saturation > 0.16) return colors.positiveWash;
      if (hue >= 18 && hue <= 62 && saturation > 0.18) return colors.warningWash;
      if (saturation > 0.12 && hue >= 175 && hue <= 270) return colors.blueWash;
      return colors.ice;
    }
    if (lightness >= 0.36 && saturation > 0.35 && hue >= 175 && hue <= 270) return colors.blue;
    return value;
  }

  if (property.toLowerCase().includes('border') || property === 'outlineColor') {
    if ((hue < 16 || hue > 344) && saturation > 0.2) return colors.negativeWash;
    if (hue >= 18 && hue <= 62 && saturation > 0.2) return colors.warningLine;
    if (saturation > 0.16 && hue >= 175 && hue <= 270) return colors.featureLine;
    return lightness >= 0.55 ? colors.line : value;
  }

  return value;
}

function adaptStyleValue(value: StyleValue, property: string, styleName: string, colors: Palette): StyleValue {
  if (typeof value === 'string') return legacyColor(value, property, styleName, colors);
  if (Array.isArray(value)) return value.map((entry) => adaptStyleValue(entry, property, styleName, colors));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, adaptStyleValue(child, key, styleName, colors)]));
}

/** Adapts the earlier light palette's static StyleSheet colors to the active theme. */
export function useAppearanceStyles<T extends Record<string, StyleValue>>(styles: T): T {
  const { palette } = useTheme();
  return useMemo(() => Object.fromEntries(
    Object.entries(styles).map(([name, value]) => [name, adaptStyleValue(value, '', name, palette)]),
  ) as T, [palette, styles]);
}
