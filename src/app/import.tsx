import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Avatar, Button, Card, Row, Screen, SectionTitle } from '@/components/ui';
import { ExportFile, findNameClashes, importFile, parseExport } from '@/data/backup';
import { QRScannerModal } from '@/components/QRScannerModal';
import { pickTextFile } from '@/lib/files';
import { money } from '@/lib/format';
import { colors } from '@/lib/theme';
import { errorMessage, notify } from '@/lib/dialog';
import { useApp } from '@/lib/app';

export default function ImportScreen() {
  const router = useRouter();
  const { suspendLock } = useApp();
  const [file, setFile] = useState<ExportFile | null>(null);
  const [fileName, setFileName] = useState('');
  const [clashes, setClashes] = useState<Record<string, boolean>>({});
  const [meRef, setMeRef] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState('');
  const [showScanner, setShowScanner] = useState(false);

  const handleJoinInvite = () => {
    const raw = inviteUrl.trim();
    if (!raw) return;
    router.push(`/join?invite=${encodeURIComponent(raw)}`);
  };

  const pick = async () => {
    try {
      suspendLock();
      const picked = await pickTextFile();
      if (!picked) return;
      const parsed = parseExport(picked.text);
      setFile(parsed);
      setFileName(picked.name);
      setClashes(await findNameClashes(parsed));
      setMeRef(Object.fromEntries(parsed.groups.map((g) => [g.uid, parsed.kind === 'backup' ? (g.members.find((m) => m.isMe)?.ref ?? null) : null])));
    } catch (e) {
      setFile(null);
      notify("Can't import this file", errorMessage(e));
    }
  };

  const doImport = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const ids = await importFile(file, { meRef });
      notify('Imported', `${ids.length} group${ids.length === 1 ? '' : 's'} imported.`);
      if (ids.length === 1) router.replace(`/group/${ids[0]}`);
      else router.dismissTo('/');
    } catch (e) {
      notify('Import failed', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <Card style={{ marginBottom: 18 }}>
        <Text style={{ fontWeight: '800', fontSize: 16, marginBottom: 4 }}>Join via Invite Link or QR Code</Text>
        <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 12 }}>
          Scan a QR code or paste an invite link shared by a friend to join and sync in real time.
        </Text>
        <TextInput
          placeholder="Paste invite link (e.g. splitmate://join?...)"
          value={inviteUrl}
          onChangeText={setInviteUrl}
          style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, marginBottom: 10, backgroundColor: '#fff' }}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Row style={{ gap: 10 }}>
          <Button
            title="📷 Scan QR Code"
            variant="outline"
            onPress={() => setShowScanner(true)}
            style={{ flex: 1, backgroundColor: '#fff' }}
            testID="scan-qr-btn"
          />
          <Button
            title="Join Group"
            onPress={handleJoinInvite}
            disabled={!inviteUrl.trim()}
            style={{ flex: 1 }}
            testID="join-invite-btn"
          />
        </Row>
      </Card>

      <SectionTitle>Import Backup or JSON File</SectionTitle>
      <Text style={{ color: colors.muted, marginBottom: 12 }}>
        Import a group file a friend shared with you, or a backup you exported earlier (files ending in .splitmate.json). Each group is added as a new group that you own: it never changes the original group or anyone else’s copy. To share a live group with others, use an invite link instead.
      </Text>
      <Button title={file ? 'Choose a different file' : 'Choose file'} variant={file ? 'outline' : 'primary'} onPress={pick} testID="pick-file" />

      {file && (
        <View style={{ marginTop: 18 }}>
          <Card>
            <Text style={{ fontWeight: '800', fontSize: 16 }}>{file.kind === 'backup' ? 'Full backup' : 'Shared group'}</Text>
            <Text style={{ color: colors.muted, marginTop: 2 }} numberOfLines={1}>
              {fileName}
              {file.exportedAt ? ` · exported ${file.exportedAt.slice(0, 10)}` : ''}
            </Text>
          </Card>

          {file.groups.map((g) => {
            const total = g.transactions.filter((t) => t.type === 'expense').reduce((a, t) => a + t.amount, 0);
            return (
              <Card key={g.uid}>
                <Text style={{ fontWeight: '800', fontSize: 16 }}>{g.name}</Text>
                <Text style={{ color: colors.muted, marginTop: 2 }}>
                  {g.members.length} members · {g.transactions.length} transactions · {money(total, g.currency)}
                </Text>
                {clashes[g.uid] ? (
                  <Text style={{ color: colors.accent, fontWeight: '700', marginTop: 4 }} testID={`import-copy-note-${g.uid}`}>
                    You already have a group with this name; this one is added as “{g.name} (copy)”.
                  </Text>
                ) : null}
                <Text style={{ fontSize: 13, fontWeight: '600', color: colors.muted, marginTop: 10, marginBottom: 6 }}>Which one is you?</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                  {g.members.map((m, i) => (
                    <Pressable
                      key={m.ref}
                      onPress={() => setMeRef((r) => ({ ...r, [g.uid]: r[g.uid] === m.ref ? null : m.ref }))}
                      style={[{ flexDirection: 'row', alignItems: 'center', padding: 6, paddingRight: 12, borderRadius: 20, borderWidth: 1, borderColor: colors.border, marginRight: 8, marginBottom: 8, backgroundColor: '#fff' }, meRef[g.uid] === m.ref && { borderColor: colors.primary, borderWidth: 2 }]}
                      testID={`import-me-${m.ref}`}
                    >
                      <Avatar name={m.name} index={i} size={24} />
                      <Text style={{ marginLeft: 6, fontWeight: '600' }}>{m.name}</Text>
                      {meRef[g.uid] === m.ref && <Text style={{ color: colors.primary, fontWeight: '800', marginLeft: 6 }}>✓ me</Text>}
                    </Pressable>
                  ))}
                </View>
              </Card>
            );
          })}

          <Button title={`Import ${file.groups.length === 1 ? 'group' : `${file.groups.length} groups`}`} onPress={doImport} loading={busy} style={{ marginTop: 8 }} testID="do-import" />
        </View>
      )}

      <QRScannerModal
        visible={showScanner}
        onClose={() => setShowScanner(false)}
        onScan={(data) => {
          setShowScanner(false);
          router.push(`/join?invite=${encodeURIComponent(data)}`);
        }}
      />
    </Screen>
  );
}
