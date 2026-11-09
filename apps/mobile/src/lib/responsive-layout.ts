import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface ResponsiveLayout {
  contentWidth: number;
  wideCanvas: boolean;
  pairedPanels: boolean;
  shopGrid: boolean;
}

/** Use available window space, including large-text scale, rather than device type. */
export function resolveResponsiveLayout(width: number, fontScale: number, leftInset = 0, rightInset = 0): ResponsiveLayout {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const inset = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
  const scale = Number.isFinite(fontScale) ? Math.max(1, fontScale) : 1;
  const contentWidth = Math.min(1120, Math.max(0, safeWidth - inset(leftInset) - inset(rightInset) - 40));
  return {
    contentWidth,
    wideCanvas: contentWidth > 720,
    pairedPanels: contentWidth >= 860 * scale + 20,
    shopGrid: contentWidth >= 640 * scale + 12,
  };
}

/** Size the plot from its actual container rather than the device screen. */
export function responsiveChartHeight(width: number): number {
  if (!Number.isFinite(width) || width < 560) return 190;
  return Math.max(190, Math.min(300, Math.round(width * 0.42)));
}

/** Keep the allocation ring prominent while fitting within the measured card. */
export function responsiveAllocationSize(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 220;
  return Math.max(1, Math.min(300, Math.floor(width - 40)));
}

export function useResponsiveLayout(): ResponsiveLayout {
  const { width, fontScale } = useWindowDimensions();
  const { left, right } = useSafeAreaInsets();
  return resolveResponsiveLayout(width, fontScale, left, right);
}
