import { StyleSheet, Text, View } from 'react-native';
import { useCustomerSession } from '@/lib/customer-session-context';
import type { Palette } from '@/lib/palette';
import { useThemedStyles } from '@/lib/theme-context';
import { NativeButton } from './native-button';

export function CustomerSessionPanel() {
  const styles = useThemedStyles(createStyles);
  const session = useCustomerSession();
  const signedIn = session.status === 'authenticated';
  const account = session.identity?.accountType;
  const title = signedIn
    ? account === 'business' ? 'Business account' : account === 'personal' ? 'Personal account' : 'Connected account'
    : session.status === 'holding' ? 'Confirming your session' : 'Your personal workspace';
  const detail = signedIn
    ? 'Saved information is kept separately for this account on this device.'
    : session.status === 'holding' ? 'Private information stays hidden until your session is confirmed.'
      : 'Holdings, contacts and lists stay on this device.';
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <View style={styles.heading}>
        <Text style={styles.eyebrow}>{signedIn ? 'CONNECTED WITH PAYPAL' : 'ACCOUNT'}</Text>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.detail}>{detail}</Text>
        {signedIn && account === 'unknown' && <Text style={styles.detail}>PayPal did not confirm an account type. The views below are previews.</Text>}
      </View>
      <View style={styles.actions}>
        {signedIn ? <NativeButton label="Sign out of this app" onPress={() => { void session.logout(); }} />
          : session.status === 'holding'
            ? <NativeButton label="Check session" onPress={() => { void session.retry(); }} />
            : session.loginAvailable ? <NativeButton label="Continue with PayPal" variant="filled" onPress={() => { void session.start(); }} />
              : <Text style={styles.note}>PayPal sign-in is not available in this preview.</Text>}
      </View>
    </View>
  );
}

function createStyles(palette: Palette) {
  return StyleSheet.create({
  card: { marginHorizontal: 20, marginTop: 12, marginBottom: 8, padding: 18, borderRadius: 20, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, gap: 12, maxWidth: 1120, width: 'auto', alignSelf: 'stretch' },
  heading: { gap: 5 },
  eyebrow: { color: palette.blue, fontWeight: '700', fontSize: 10, letterSpacing: 1.2 },
  title: { color: palette.ink, fontWeight: '700', fontSize: 20 },
  detail: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  note: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  });
}
