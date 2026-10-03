import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { AppProvider, useApp } from '@/lib/app';
import { Loading } from '@/components/ui';
import { LockScreen, Welcome } from '@/components/Gate';
import { DialogHost } from '@/components/Dialog';
import { colors } from '@/lib/theme';

function Root() {
  const { ready, error, profileName, locked } = useApp();
  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ fontWeight: '800', fontSize: 18, marginBottom: 8 }}>Couldn’t open the database</Text>
        <Text style={{ color: colors.muted, textAlign: 'center' }}>{error}</Text>
      </View>
    );
  }
  if (!ready) return <Loading />;
  if (!profileName) return <Welcome />;
  if (locked) return <LockScreen />;
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: colors.white,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'SplitMate' }} />
      <Stack.Screen name="insights" options={{ title: 'Insights' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      <Stack.Screen name="import" options={{ title: 'Import' }} />
      <Stack.Screen name="group/new" options={{ title: 'New group' }} />
      <Stack.Screen name="group/[id]/index" options={{ title: '' }} />
      <Stack.Screen name="group/[id]/expense" options={{ title: 'Add expense' }} />
      <Stack.Screen name="group/[id]/payment" options={{ title: 'Record payment' }} />
      <Stack.Screen name="group/[id]/members" options={{ title: 'Members' }} />
      <Stack.Screen name="group/[id]/report" options={{ title: 'Report' }} />
      <Stack.Screen name="group/[id]/settings" options={{ title: 'Group settings' }} />
      <Stack.Screen name="group/[id]/transaction/[tid]" options={{ title: 'Details' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <AppProvider>
          <StatusBar style="light" />
          <Root />
          <DialogHost />
        </AppProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
