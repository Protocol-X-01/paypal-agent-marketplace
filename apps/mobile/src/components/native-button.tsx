import { Pressable, StyleSheet, Text } from 'react-native';
import type { Palette } from '@/lib/palette';
import { useThemedStyles } from '@/lib/theme-context';

interface NativeButtonProps {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  selected?: boolean;
  variant?: 'filled' | 'outlined' | 'text';
  disabled?: boolean;
  compact?: boolean;
}

export function NativeButton({
  label,
  accessibilityLabel,
  onPress,
  selected = false,
  variant,
  disabled = false,
  compact = false,
}: NativeButtonProps) {
  const styles = useThemedStyles(createStyles);
  const appearance = variant ?? (selected ? 'filled' : 'outlined');
  const filled = appearance === 'filled';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact ? styles.compact : styles.regular,
        filled ? styles.filled : appearance === 'text' ? styles.textButton : styles.outlined,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}>
      <Text style={[styles.label, compact && styles.compactLabel, filled && styles.filledLabel]}>{label}</Text>
    </Pressable>
  );
}

function createStyles(palette: Palette) {
  return StyleSheet.create({
  button: { minHeight: 48, maxWidth: '100%', alignSelf: 'flex-start', alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1 },
  compact: { paddingHorizontal: 10, paddingVertical: 8 },
  regular: { paddingHorizontal: 16, paddingVertical: 10 },
  filled: { backgroundColor: palette.blue, borderColor: palette.blue },
  outlined: { backgroundColor: palette.surface, borderColor: palette.line },
  textButton: { backgroundColor: 'transparent', borderColor: 'transparent' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.72 },
  label: { color: palette.ink, fontSize: 14, lineHeight: 20, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
  compactLabel: { fontSize: 12, lineHeight: 18 },
  filledLabel: { color: palette.onBlue },
  });
}
