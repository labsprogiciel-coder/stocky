import React from 'react';
import { Pressable, Text, View, ScrollView, StyleProp, ViewStyle, TextStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { colors } from '../constants/theme';

export const Icon = (p: { name: React.ComponentProps<typeof Feather>['name']; size?: number; color?: string }) => (
  <Feather name={p.name} size={p.size ?? 22} color={p.color ?? colors.text} />
);

export function Screen({
  children,
  footer,
  scroll = true,
  paddingHorizontal = 12,
  paddingTop,
  paddingBottom,
  edges,
  hasHeader = false,
  style,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
  scroll?: boolean;
  paddingHorizontal?: number;
  paddingTop?: number;
  paddingBottom?: number;
  edges?: readonly ('top' | 'right' | 'bottom' | 'left')[];
  hasHeader?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const resolvedEdges = edges ?? (hasHeader ? ['bottom'] : ['top']);
  const topPad = paddingTop ?? (hasHeader ? 8 : 16);
  const bottomPad = paddingBottom ?? 16;
  const body = (
    <View style={[{ paddingTop: topPad, paddingBottom: bottomPad, paddingHorizontal, gap: 16 }, style]}>
      {children}
    </View>
  );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={resolvedEdges}>
      {scroll ? <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>{body}</ScrollView> : body}
      {footer}
    </SafeAreaView>
  );
}

export const H1 = ({ children }: { children: React.ReactNode }) => (
  <Text accessibilityRole="header" style={{ fontSize: 24, fontWeight: '700', color: colors.text }}>{children}</Text>
);
export const H2 = ({ children }: { children: React.ReactNode }) => (
  <Text accessibilityRole="header" style={{ fontSize: 16, fontWeight: '600', color: colors.text }}>{children}</Text>
);
export const Muted = ({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) => (
  <Text style={[{ fontSize: 13, color: colors.muted }, style]}>{children}</Text>
);

export const Card = ({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) => (
  <View style={[{ backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 16 }, style]}>{children}</View>
);

export function Btn({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'outline';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        {
          minHeight: 48,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 20,
          backgroundColor: primary ? colors.primary : '#fff',
          borderWidth: primary ? 0 : 1,
          borderColor: colors.primary,
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      <Text style={{ fontSize: 15, fontWeight: '600', color: primary ? '#fff' : colors.primary }}>{title}</Text>
    </Pressable>
  );
}

export const Alert = ({ message, style }: { message: string; style?: StyleProp<ViewStyle> }) => (
  <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FEE2E2', borderRadius: 10, padding: 12 }, style]}>
    <Feather name="alert-circle" size={16} color="#B91C1C" />
    <Text style={{ flex: 1, fontSize: 13, color: '#B91C1C', fontWeight: '500' }}>{message}</Text>
  </View>
);

export const Chip = ({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) => (
  <Pressable onPress={onPress} style={{ minHeight: 44, paddingHorizontal: 18, borderRadius: 999, justifyContent: 'center', backgroundColor: active ? colors.primary : '#fff', borderWidth: active ? 0 : 1, borderColor: colors.field }}>
    <Text style={{ fontSize: 14, fontWeight: '600', color: active ? '#fff' : colors.muted }}>{label}</Text>
  </Pressable>
);

export const Progress = ({ value }: { value: number }) => (
  <View style={{ height: 8, borderRadius: 4, backgroundColor: colors.border }}>
    <View style={{ width: `${Math.round(value * 100)}%`, height: 8, borderRadius: 4, backgroundColor: colors.primary }} />
  </View>
);

export const Thumb = ({ size = 48 }: { size?: number }) => (
  <View style={{ width: size, height: size, borderRadius: 10, backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center' }}>
    <Icon name="image" size={Math.round(size * 0.45)} color={colors.primary} />
  </View>
);

export function Stepper({ value, onChange, big }: { value: number; onChange: (n: number) => void; big?: boolean }) {
  const btn = { width: 56, height: 56, borderRadius: 12, borderWidth: 1, borderColor: colors.field, backgroundColor: '#fff', alignItems: 'center' as const, justifyContent: 'center' as const };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Pressable accessibilityLabel="Moins" style={btn} onPress={() => onChange(Math.max(0, value - 1))}><Icon name="minus" color={colors.primary} /></Pressable>
      <Text style={{ fontSize: big ? 40 : 30, fontWeight: '700', color: colors.text }}>{value}</Text>
      <Pressable accessibilityLabel="Plus" style={btn} onPress={() => onChange(value + 1)}><Icon name="plus" color={colors.primary} /></Pressable>
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: T[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable key={o} onPress={() => onChange(o)} style={{ flex: 1, minHeight: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? colors.tint : '#fff', borderWidth: on ? 2 : 1, borderColor: on ? colors.primary : colors.field }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: on ? colors.primary : colors.muted }}>{o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export const Row = ({ onPress, children }: { onPress?: () => void; children: React.ReactNode }) => (
  <Pressable onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderTopWidth: 1, borderTopColor: colors.line, minHeight: 64 }}>
    {children}
  </Pressable>
);
