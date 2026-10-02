import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Avatar, Button, Card, Chip, Row, Screen, SectionTitle } from '@/components/ui';
import { ExportFile, findExisting, importFile, parseExport } from '@/data/backup';
import { pickTextFile } from '@/lib/files';
import { money } from '@/lib/format';
import { colors } from '@/lib/theme';
import { confirm, errorMessage, notify } from '@/lib/dialog';
import { useApp } from '@/lib/app';

export default function ImportScreen() {
  const router = useRouter();
  const { suspendLock } = useApp();
  const [file, setFile] = useState<ExportFile | null>(null);
  const [fileName, setFileName] = useState('');
  const [existing, setExisting] = useState<Record<string, number>>({});
  const [meRef, setMeRef] = useState<Record<string, number | null>>({});
  const [onDuplicate, setOnDuplicate] = useState<'replace' | 'copy'>('replace');
  const [eraseFirst, setEraseFirst] = useState(false);
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    try {
      suspendLock();
      const picked = await pickTextFile();
      if (!picked) return;
      const parsed = parseExport(picked.text);
      setFile(parsed);
      setFileName(picked.name);
      setExisting(await findExisting(parsed));
      setMeRef(Object.fromEntries(parsed.groups.map((g) => [g.uid, parsed.kind === 'backup' ? (g.members.find((m) => m.isMe)?.ref ?? null) : null])));
      setEraseFirst(false);
    } catch (e) {
      setFile(null);
      notify("Can't import this file", errorMessage(e));
    }
  };

  const doImport = async () => {
    if (!file) return;
    if (eraseFirst && !(await confirm('Replace all data', 'All groups currently on this phone will be deleted and replaced by the backup.', 'Replace', true))) return;
    setBusy(true);
    try {
      const ids = await importFile(file, { onDuplicate, meRef, eraseFirst });
      notify('Imported', `${ids.length} group${ids.length === 1 ? '' : 's'} imported.`);
      if (ids.length === 1) router.replace(`/group/${ids[0]}`);
      else router.dismissTo('/');
    } catch (e) {
      notify('Import failed', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const dupCount = file ? file.groups.filter((g) => existing[g.uid]).length : 0;

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <Text style={{ color: colors.muted, marginBottom: 12 }}>
        Import a group file a friend shared with you, or restore a backup you exported earlier (files ending in .splitmate.json).
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
                {existing[g.uid] ? <Text style={{ color: colors.accent, fontWeight: '700', marginTop: 4 }}>Already on this phone</Text> : null}
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

          {dupCount > 0 && !eraseFirst && (
            <>
              <SectionTitle>Groups already on this phone</SectionTitle>
              <Row style={{ flexWrap: 'wrap' }}>
                <Chip label="Update with this file" active={onDuplicate === 'replace'} onPress={() => setOnDuplicate('replace')} testID="dup-replace" />
                <Chip label="Keep both (import as copy)" active={onDuplicate === 'copy'} onPress={() => setOnDuplicate('copy')} testID="dup-copy" />
              </Row>
            </>
          )}

          {file.kind === 'backup' && (
            <Pressable onPress={() => setEraseFirst(!eraseFirst)} style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 10 }} testID="erase-first">
              <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.negative, backgroundColor: eraseFirst ? colors.negative : 'transparent', marginRight: 10, alignItems: 'center', justifyContent: 'center' }}>
                {eraseFirst && <Text style={{ color: '#fff', fontWeight: '900' }}>✓</Text>}
              </View>
              <Text style={{ flex: 1 }}>Replace everything on this phone with this backup</Text>
            </Pressable>
          )}

          <Button title={`Import ${file.groups.length === 1 ? 'group' : `${file.groups.length} groups`}`} onPress={doImport} loading={busy} style={{ marginTop: 8 }} testID="do-import" />
        </View>
      )}
    </Screen>
  );
}
