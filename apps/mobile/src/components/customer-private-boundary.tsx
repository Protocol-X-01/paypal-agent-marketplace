import { Fragment, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useCustomerSession } from '@/lib/customer-session-context';
import type { Palette } from '@/lib/palette';
import { useThemedStyles } from '@/lib/theme-context';
import { NativeButton } from './native-button';

/** Remount private forms on every identity revision, including A -> B -> A. */
export function CustomerPrivateBoundary({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  const session = useCustomerSession();
  if (session.status === 'holding') return (
    <View style={styles.hold} accessibilityLiveRegion="polite">
      <Text style={styles.title}>Your private workspace is protected</Text>
      <Text style={styles.detail}>We need to confirm your session before showing saved information. You can still browse Markets and Shop.</Text>
      <NativeButton label="Check session" onPress={() => { void session.retry(); }} />
    </View>
  );
  return <Fragment key={session.revision}>{children}</Fragment>;
}

function createStyles(palette: Palette) {
  return StyleSheet.create({
  hold: { padding: 24, gap: 14, width: '100%', maxWidth: 720, alignSelf: 'center' },
  title: { color: palette.ink, fontSize: 22, fontWeight: '700' },
  detail: { color: palette.muted, fontSize: 15, lineHeight: 23 },
  });
}
