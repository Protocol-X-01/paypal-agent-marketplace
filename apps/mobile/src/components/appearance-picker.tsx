import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Palette } from '@/lib/palette';
import { usePalette, useTheme, useThemedStyles } from '@/lib/theme-context';

export function AppearancePicker() {
  const colors = usePalette();
  const { appearance, setAppearance } = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={[styles.container, { backgroundColor: colors.surface, borderColor: colors.line }]}>
      <Text style={styles.title}>Appearance</Text>
      <View style={styles.options}>
        {(['dark', 'light'] as const).map((option) => {
          const selected = appearance === option;
          const label = option === 'dark' ? 'Dark' : 'Light';
          return <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityLabel={`${label} appearance`}
            accessibilityState={{ selected }}
            onPress={() => setAppearance(option)}
            style={({ pressed }) => [styles.option, selected ? { backgroundColor: colors.blue, borderColor: colors.blue } : { borderColor: colors.line }, pressed && styles.pressed]}>
            <Text style={[styles.optionText, selected && { color: colors.onBlue }]}>{label}</Text>
          </Pressable>;
        })}
      </View>
    </View>
  );
}

function createStyles(colors: Palette) {
  return StyleSheet.create({
    container: { maxWidth: 920, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: 14, marginBottom: 12, borderRadius: 18, borderWidth: 1 },
    title: { color: colors.ink, fontSize: 14, lineHeight: 19, fontWeight: '800' },
    options: { flexDirection: 'row', gap: 7 },
    option: { minWidth: 68, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 13, borderWidth: 1, paddingHorizontal: 12 },
    optionText: { color: colors.ink, fontSize: 12, lineHeight: 17, fontWeight: '800' },
    pressed: { opacity: 0.72 },
  });
}
