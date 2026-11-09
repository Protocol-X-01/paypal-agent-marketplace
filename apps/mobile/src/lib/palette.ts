const darkPalette = {
  navy: '#0A1422',
  blue: '#0070E0',
  aqua: '#5AD7F4',
  canvas: '#05070B',
  ink: '#F7FAFC',
  muted: '#AAB5C1',
  line: 'rgba(255, 255, 255, 0.14)',
  surface: '#151A20',
  blueWash: '#10243A',
  ice: '#20262E',
  plotGrid: '#394550',
  plotText: '#AAB5C1',
  chartGuide: '#73808D',
  sma: '#F2C461',
  ema: '#BCA7FF',
  rsi: '#91A6FF',
  link: '#63BBFF',
  positive: '#55D6A1',
  negative: '#FF808A',
  warning: '#F9DBAA',
  onBlue: '#FFFFFF',
  featureSurface: '#0A1422',
  featureInk: '#F7FAFC',
  featureMuted: '#D2E1F5',
  featureLine: '#37538C',
  featureInset: '#12377C',
  featureInsetLine: '#28539B',
  warningWash: '#2E2718',
  warningLine: '#70552A',
  negativeWash: '#2E1C20',
  positiveWash: '#142A22',
  overlay: 'rgba(0, 0, 0, 0.72)',
} as const;

const lightPalette = {
  navy: '#E8F1FC',
  blue: '#0067C5',
  aqua: '#008EAF',
  canvas: '#F4F7FB',
  ink: '#102A4C',
  muted: '#52657D',
  line: 'rgba(16, 42, 76, 0.14)',
  surface: '#FFFFFF',
  blueWash: '#E4F1FF',
  ice: '#EEF3F8',
  plotGrid: '#D7E1EC',
  plotText: '#52657D',
  chartGuide: '#8393A6',
  sma: '#936300',
  ema: '#6F4BB8',
  rsi: '#315BC5',
  link: '#005DB8',
  positive: '#087A52',
  negative: '#B32637',
  warning: '#8B5100',
  onBlue: '#FFFFFF',
  featureSurface: '#0A1422',
  featureInk: '#FFFFFF',
  featureMuted: '#D2E1F5',
  featureLine: '#37538C',
  featureInset: '#12377C',
  featureInsetLine: '#28539B',
  warningWash: '#FFF4DD',
  warningLine: '#E5C47A',
  negativeWash: '#FFF1F0',
  positiveWash: '#E9F6F0',
  overlay: 'rgba(12, 28, 48, 0.56)',
} as const;

export type Palette = { [Key in keyof typeof darkPalette]: string };
export type Appearance = 'light' | 'dark';

export function paletteForAppearance(appearance: Appearance): Palette {
  return appearance === 'light' ? lightPalette : darkPalette;
}

/** Dark is the product default; use paletteForAppearance in reactive screens. */
export const palette: Palette = darkPalette;
