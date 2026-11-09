import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, View, useWindowDimensions, type ColorValue } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { DataProvider } from '@/lib/data-context';
import { CustomerSessionProvider, useCustomerSession } from '@/lib/customer-session-context';
import { ThemeProvider, usePalette, useTheme } from '@/lib/theme-context';

function TabIcon({ name, color, focused }: { name: string; color: ColorValue; focused: boolean }) {
  const palette = usePalette();
  return (
    <View style={[styles.tabIcon, focused && { backgroundColor: palette.blueWash }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        {name === 'portfolio'
          ? <><Path d="M12 3a9 9 0 1 0 9 9h-9V3Z" /><Path d="M15 3.5A9 9 0 0 1 20.5 9H15V3.5Z" /></>
          : name === 'send'
            ? <><Path d="M12 4v16" /><Path d="m7 9 5-5 5 5" /><Path d="m7 15 5 5 5-5" /></>
            : name === 'shop'
              ? <><Path d="M5 8h14l1 12H4L5 8Z" /><Path d="M9 8V6a3 3 0 0 1 6 0v2" /></>
              : name === 'business'
                ? <><Path d="M3 20.5h18M5.5 20V9.5h13V20M3.5 9.5 12 4l8.5 5.5M9 12.5v5M12 12.5v5M15 12.5v5" /></>
                : <><Path d="M3.5 19.5h17" /><Path d="m5 15 4-4 4 3 6-7" /><Path d="M16 7h3v3" /></>}
      </Svg>
    </View>
  );
}

function TabsWithInsets() {
  const palette = usePalette();
  const { bottom, left, right } = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const bottomPadding = Math.max(8, bottom);
  const textScale = Number.isFinite(fontScale) ? Math.max(1, fontScale) : 1;
  const contentWidth = Number.isFinite(width) ? Math.max(0, width - left - right - 40) : 0;
  const useTabletRail = contentWidth >= 88 + 860 * textScale + 20;
  return (
        <Tabs
          screenOptions={({ route }) => ({
            headerShown: false,
            sceneStyle: { backgroundColor: palette.canvas },
            tabBarActiveTintColor: palette.blue,
            tabBarInactiveTintColor: palette.muted,
            tabBarPosition: useTabletRail ? 'left' : 'bottom',
            tabBarVariant: useTabletRail ? 'material' : 'uikit',
            tabBarLabelPosition: useTabletRail ? 'below-icon' : undefined,
            tabBarItemStyle: useTabletRail ? { minHeight: 64, marginVertical: 3, borderRadius: 14 } : undefined,
            tabBarStyle: useTabletRail
              ? {
                  width: 88,
                  paddingTop: 12,
                  paddingBottom: 12,
                  paddingHorizontal: 6,
                  backgroundColor: palette.surface,
                  borderRightColor: palette.line,
                  borderRightWidth: 1,
                  elevation: 8,
                }
              : {
                  height: 56 + bottomPadding,
                  paddingTop: 7,
                  paddingBottom: bottomPadding,
                  backgroundColor: palette.surface,
                  borderTopColor: palette.line,
                  elevation: 8,
                },
            tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
            tabBarIcon: ({ color, focused }) => <TabIcon name={route.name} color={color} focused={focused} />,
          })}>
          <Tabs.Screen name="index" options={{ title: 'Markets' }} />
          <Tabs.Screen name="send" options={{ title: 'Send' }} />
          <Tabs.Screen name="shop" options={{ title: 'Shop' }} />
          <Tabs.Screen name="portfolio" options={{ title: 'Portfolio' }} />
          <Tabs.Screen name="business" options={{ title: 'Account' }} />
        </Tabs>
  );
}

function CustomerWorkspace() {
  const { appearance } = useTheme();
  const { storageFence, revision } = useCustomerSession();
  return <DataProvider storageFence={storageFence} storageRevision={revision}>
    <StatusBar style={appearance === 'dark' ? 'light' : 'dark'} />
    <TabsWithInsets />
  </DataProvider>;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <CustomerSessionProvider>
          <CustomerWorkspace />
        </CustomerSessionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  tabIcon: { width: 38, height: 26, alignItems: 'center', justifyContent: 'center', borderRadius: 13 },
});
