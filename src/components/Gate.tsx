// First-launch welcome and the PIN lock screen, shown before the app's screens.
import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Field } from './ui';
import { PinPad } from './PinPad';
import { colors } from '@/lib/theme';
import { useApp } from '@/lib/app';
import { lockoutRemaining, verifyPin, removePin } from '@/lib/pin';
import { eraseAllData } from '@/data/repo';
import { createSampleGroups } from '@/data/samples';
import { confirm, notify } from '@/lib/dialog';

function Logo() {
  return (
    <View style={{ alignItems: 'center', marginBottom: 24 }}>
      <View style={{ width: 72, height: 72, borderRadius: 20, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 34, fontWeight: '900' }}>÷</Text>
      </View>
      <Text style={{ fontSize: 28, fontWeight: '800', color: colors.text, marginTop: 12 }}>SplitMate</Text>
      <Text style={{ color: colors.muted, marginTop: 4 }}>Share & split group expenses</Text>
    </View>
  );
}

export function Welcome() {
  const { setProfileName } = useApp();
  const [name, setName] = useState('');
  const start = async () => {
    if (!name.trim()) return notify('Your name', 'Enter your name to get started');
    // example groups show how the app is used; failing to create them must not block getting started
    await createSampleGroups(name).catch(() => {});
    await setProfileName(name);
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAwareScrollView
        contentContainerStyle={{ padding: 24, flexGrow: 1, justifyContent: 'center', maxWidth: 480, width: '100%', alignSelf: 'center' }}
        keyboardShouldPersistTaps="handled"
        bottomOffset={80}
      >
        <Logo />
        <Text style={{ color: colors.text, fontSize: 15, marginBottom: 16, textAlign: 'center' }}>
          Everything stays on this phone. No account, no internet needed.
        </Text>
        <Field label="What should we call you?" value={name} onChangeText={setName} placeholder="Your name" onSubmitEditing={start} testID="welcome-name" />
        <Button title="Get started" onPress={start} testID="welcome-start" />
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

export function LockScreen() {
  const { unlock, refreshPin, setProfileName } = useApp();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState('Enter your PIN');
  const [wait, setWait] = useState(0);

  useEffect(() => {
    lockoutRemaining().then(setWait);
  }, []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const check = async (value: string) => {
    const r = await verifyPin(value);
    setPin('');
    if (r.ok) return unlock();
    setWait(r.wait);
    setMessage(r.wait ? 'Too many wrong attempts' : 'Wrong PIN, try again');
  };

  const forgot = async () => {
    const ok = await confirm(
      'Forgot PIN?',
      'For your privacy the PIN cannot be recovered. You can erase ALL data on this phone and start fresh. If you exported a backup file you can restore it afterwards.',
      'Erase everything',
      true
    );
    if (!ok) return;
    await eraseAllData();
    await removePin();
    await refreshPin();
    notify('Data erased', 'The app will now start fresh.');
    if (Platform.OS === 'web') {
      window.location.replace('/');
      return;
    }
    await setProfileName('');
    unlock();
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
      <Logo />
      <Text style={{ textAlign: 'center', color: wait ? colors.negative : colors.text, fontWeight: '600' }} testID="lock-message">
        {wait ? `${message}. Try again in ${wait}s` : message}
      </Text>
      <PinPad value={pin} onChange={setPin} onComplete={check} disabled={wait > 0} />
      <Button title="Forgot PIN?" variant="ghost" small onPress={forgot} style={{ alignSelf: 'center', marginTop: 8 }} />
    </SafeAreaView>
  );
}
