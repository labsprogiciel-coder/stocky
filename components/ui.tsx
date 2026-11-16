import React, { useState } from 'react';
import { Image, Pressable, Text, View, ScrollView, StyleProp, ViewStyle, TextStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { colors } from '../constants/theme';
import { photoUri } from '../data/photos';

/** Couleur des actions destructives (suppression, réinitialisation). */
export const DANGER = '#8A2A1B';

export type IconName = React.ComponentProps<typeof Feather>['name'];

export const Icon = (p: { name: IconName; size?: number; color?: string }) => (
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
  accessibilityLabel,
  accessibilityHint,
}: {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'outline' | 'danger';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const primary = variant === 'primary';
  const fg = primary ? '#fff' : variant === 'danger' ? DANGER : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
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
          borderColor: variant === 'danger' ? DANGER : colors.primary,
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      <Text style={{ fontSize: 15, fontWeight: '600', color: fg }}>{title}</Text>
    </Pressable>
  );
}

export const Alert = ({ message, style }: { message: string; style?: StyleProp<ViewStyle> }) => (
  <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FEE2E2', borderRadius: 10, padding: 12 }, style]}>
    <Feather name="alert-circle" size={16} color="#B91C1C" />
    <Text style={{ flex: 1, fontSize: 13, color: '#B91C1C', fontWeight: '500' }}>{message}</Text>
  </View>
);

export type EmptyStateAction = {
  label: string;
  onPress: () => void;
  /** Libellé lu par le lecteur d'écran (par défaut : `label`). */
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

/**
 * État vide : icône, titre, message et actions facultatives (principale puis
 * secondaire). Affiché à la place d'une liste ou d'une carte sans contenu.
 */
export function EmptyState({
  icon,
  title,
  message,
  primaryAction,
  secondaryAction,
  style,
}: {
  icon: IconName;
  title: string;
  message?: string;
  primaryAction?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  style?: StyleProp<ViewStyle>;
}) {
  const hasActions = primaryAction !== undefined || secondaryAction !== undefined;
  return (
    <Card style={[{ alignItems: 'center', gap: 10, paddingVertical: 28 }, style]}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}
      >
        <Icon name={icon} size={28} color={colors.primary} />
      </View>
      <Text accessibilityRole="header" style={{ fontSize: 17, fontWeight: '600', color: colors.text, textAlign: 'center' }}>{title}</Text>
      {message !== undefined && <Muted style={{ fontSize: 14, textAlign: 'center', lineHeight: 20 }}>{message}</Muted>}
      {hasActions && (
        <View style={{ alignSelf: 'stretch', gap: 8, marginTop: 8 }}>
          {primaryAction && (
            <Btn
              title={primaryAction.label}
              onPress={primaryAction.onPress}
              accessibilityLabel={primaryAction.accessibilityLabel ?? primaryAction.label}
              accessibilityHint={primaryAction.accessibilityHint}
            />
          )}
          {secondaryAction && (
            <Btn
              title={secondaryAction.label}
              variant="outline"
              onPress={secondaryAction.onPress}
              accessibilityLabel={secondaryAction.accessibilityLabel ?? secondaryAction.label}
              accessibilityHint={secondaryAction.accessibilityHint}
            />
          )}
        </View>
      )}
    </Card>
  );
}

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

/**
 * URI d'une photo d'article (nom de fichier `Item.photo`, résolu à chaque
 * rendu) ; `null` si absente ou si l'image n'a pas pu être affichée.
 */
function usePhotoSource(photo: string | null | undefined) {
  const uri = photoUri(photo);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  return {
    uri: uri !== null && uri !== failedUri ? uri : null,
    onError: () => setFailedUri(uri),
  };
}

/**
 * Vignette d'article : la photo (`photo` = nom de fichier `Item.photo`) si
 * elle existe, sinon l'icône par défaut. Décorative par défaut ; passer
 * `accessibilityLabel` pour qu'elle soit annoncée.
 */
export function Thumb({ size = 48, photo, accessibilityLabel }: { size?: number; photo?: string | null; accessibilityLabel?: string }) {
  const { uri, onError } = usePhotoSource(photo);
  const a11y = accessibilityLabel
    ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel }
    : { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
  if (uri) {
    return (
      <Image
        {...a11y}
        source={{ uri }}
        onError={onError}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
        style={{ width: size, height: size, borderRadius: 10, backgroundColor: colors.tint }}
      />
    );
  }
  return (
    <View {...a11y} style={{ width: size, height: size, borderRadius: 10, backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="image" size={Math.round(size * 0.45)} color={colors.primary} />
    </View>
  );
}

/** Grande photo d'article (fiche, formulaire), ou un emplacement vide. */
export function ItemPhoto({
  photo,
  height = 200,
  accessibilityLabel,
  emptyLabel = 'Aucune photo',
}: {
  photo?: string | null;
  height?: number;
  accessibilityLabel: string;
  emptyLabel?: string;
}) {
  const { uri, onError } = usePhotoSource(photo);
  if (uri) {
    return (
      <Image
        accessible
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
        accessibilityIgnoresInvertColors
        source={{ uri }}
        onError={onError}
        resizeMode="contain"
        style={{ height, borderRadius: 14, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border }}
      />
    );
  }
  return (
    <View
      accessible
      accessibilityLabel={emptyLabel}
      style={{ height, borderRadius: 14, borderWidth: 2, borderStyle: 'dashed', borderColor: '#C9C6BB', backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', gap: 8 }}
    >
      <Icon name="image" size={28} color={colors.muted} />
      <Muted>{emptyLabel}</Muted>
    </View>
  );
}

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
