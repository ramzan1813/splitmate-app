import { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, Field, Row, Screen, SectionTitle } from '@/components/ui';
import { PinPad } from '@/components/PinPad';
import { useApp } from '@/lib/app';
import { removePin, setPin, verifyPin } from '@/lib/pin';
import { exportAll } from '@/data/backup';
import { eraseAllData } from '@/data/repo';
import { createSampleGroups, getSampleGroupIds } from '@/data/samples';
import { safeFileName, shareFile } from '@/lib/files';
import { todayISO } from '@/lib/format';
import { colors } from '@/lib/theme';
import { confirm, errorMessage, notify } from '@/lib/dialog';

type PinStep = null | 'verify-change' | 'verify-remove' | 'new' | 'confirm';

export default function AppSettings() {
  const router = useRouter();
  const { profileName, setProfileName, pinEnabled, refreshPin, suspendLock } = useApp();
  const [name, setName] = useState(profileName || '');
  const [step, setStep] = useState<PinStep>(null);
  const [entry, setEntry] = useState('');
  const [first, setFirst] = useState('');
  const [pinMsg, setPinMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const saveName = async () => {
    if (!name.trim()) return notify('Name required');
    await setProfileName(name);
    notify('Saved', 'Your name was updated. New groups will use it.');
  };

  const startPin = (s: PinStep) => {
    setEntry('');
    setFirst('');
    setPinMsg('');
    setStep(s);
  };

  const onPin = async (v: string) => {
    setEntry('');
    if (step === 'verify-change' || step === 'verify-remove') {
      const r = await verifyPin(v);
      if (!r.ok) return setPinMsg(r.wait ? `Too many attempts. Wait ${r.wait}s.` : 'Wrong PIN');
      if (step === 'verify-remove') {
        await removePin();
        await refreshPin();
        setStep(null);
        return notify('PIN removed', 'The app no longer asks for a PIN.');
      }
      setPinMsg('');
      return setStep('new');
    }
    if (step === 'new') {
      setFirst(v);
      setPinMsg('');
      return setStep('confirm');
    }
    if (step === 'confirm') {
      if (v !== first) {
        setPinMsg("PINs didn't match. Start again.");
        return setStep('new');
      }
      await setPin(v);
      await refreshPin();
      setStep(null);
      notify('PIN set', 'The app will ask for this PIN when opened. There is no way to recover a forgotten PIN, so keep a backup.');
    }
  };

  const backup = async () => {
    setBusy(true);
    try {
      suspendLock();
      const file = await exportAll();
      if (!file.groups.length) return notify('Nothing to back up', 'Create a group first.');
      await shareFile(JSON.stringify(file), `${safeFileName('splitmate-backup')}-${todayISO()}.splitmate.json`, 'application/json', 'Save backup');
    } catch (e) {
      notify('Backup failed', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const addSamples = async () => {
    if ((await getSampleGroupIds()).length) return notify('Already added', 'The sample groups are already on your home screen.');
    try {
      await createSampleGroups(profileName || 'Me');
      notify('Sample groups added', 'Open them from the home screen to see how SplitMate works.');
    } catch (e) {
      notify('Could not add samples', errorMessage(e));
    }
  };

  const erase = async () => {
    if (!(await confirm('Erase all data', 'Delete every group, expense and setting from this phone? This cannot be undone.', 'Erase', true))) return;
    if (!(await confirm('Are you sure?', 'Last chance — export a backup first if you might need this data.', 'Erase everything', true))) return;
    await eraseAllData();
    await removePin();
    await refreshPin();
    // go back to the home screen first, then clear the name so the welcome screen shows
    if (Platform.OS === 'web') {
      window.location.replace('/');
      return;
    }
    router.dismissTo('/');
    await setProfileName('');
  };

  const titles: Record<Exclude<PinStep, null>, string> = {
    'verify-change': 'Enter your current PIN',
    'verify-remove': 'Enter your PIN to turn it off',
    new: 'Choose a new 4-digit PIN',
    confirm: 'Enter the new PIN again',
  };

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <SectionTitle>Your name</SectionTitle>
      <Field value={name} onChangeText={setName} testID="profile-name" />
      <Button title="Save name" variant="outline" small onPress={saveName} style={{ alignSelf: 'flex-start' }} />

      <SectionTitle>App lock</SectionTitle>
      <Card>
        {step ? (
          <View>
            <Text style={{ textAlign: 'center', fontWeight: '700', fontSize: 16 }}>{titles[step]}</Text>
            {pinMsg ? <Text style={{ textAlign: 'center', color: colors.negative, marginTop: 6 }}>{pinMsg}</Text> : null}
            <PinPad value={entry} onChange={setEntry} onComplete={onPin} />
            <Button title="Cancel" variant="ghost" small onPress={() => setStep(null)} />
          </View>
        ) : pinEnabled ? (
          <>
            <Text style={{ color: colors.text }}>🔒 PIN lock is on. The app asks for your PIN when opened and after 1 minute in the background.</Text>
            <Row style={{ gap: 10, marginTop: 12 }}>
              <Button small variant="outline" title="Change PIN" onPress={() => startPin('verify-change')} />
              <Button small variant="danger" title="Turn off" onPress={() => startPin('verify-remove')} testID="pin-off" />
            </Row>
          </>
        ) : (
          <>
            <Text style={{ color: colors.text }}>Protect your expenses with a 4-digit PIN.</Text>
            <Button small title="Set a PIN" onPress={() => startPin('new')} style={{ alignSelf: 'flex-start', marginTop: 12 }} testID="pin-set" />
          </>
        )}
      </Card>

      <SectionTitle>Backup & restore</SectionTitle>
      <Card>
        <Text style={{ color: colors.text, marginBottom: 12 }}>
          Your data lives only on this phone. Save a backup file to Google Drive, email or your computer, so you can restore it on a new phone or after reinstalling.
        </Text>
        <Row style={{ gap: 10, flexWrap: 'wrap' }}>
          <Button small title="Export backup" onPress={backup} loading={busy} testID="export-backup" />
          <Button small variant="outline" title="Restore / import file" onPress={() => router.push('/import')} testID="restore-backup" />
        </Row>
      </Card>

      <SectionTitle>Getting started</SectionTitle>
      <Card>
        <Text style={{ color: colors.text, marginBottom: 12 }}>Add example groups (a trip, a shared flat and a family holiday) to see how SplitMate organises expenses.</Text>
        <Button small variant="outline" title="Add sample groups" onPress={addSamples} style={{ alignSelf: 'flex-start' }} testID="add-samples" />
      </Card>

      <SectionTitle>Privacy</SectionTitle>
      <Card>
        <Text style={{ color: colors.muted, fontSize: 13 }}>
          SplitMate works fully offline and never sends your data anywhere. It has no account, no ads and no analytics, and doesn’t ask for contacts, location, camera, microphone or storage permissions. Data is stored in the app’s private SQLite database and is removed if you uninstall the app — export a backup first.
        </Text>
      </Card>

      <SectionTitle>Danger zone</SectionTitle>
      <Button title="Erase all data" variant="danger" onPress={erase} />
      <Text style={{ color: colors.muted, textAlign: 'center', marginTop: 20, fontSize: 12 }}>SplitMate 1.1.0 · offline edition</Text>
    </Screen>
  );
}
