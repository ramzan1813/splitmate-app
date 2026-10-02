import { useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Avatar, Button, Card, Field, Loading, Row, Screen, SectionTitle } from '@/components/ui';
import { useGroup } from '@/lib/useGroup';
import { addMember, deleteMember, renameMember, setMe } from '@/data/repo';
import { exportGroup } from '@/data/backup';
import { Member } from '@/data/types';
import { money } from '@/lib/format';
import { colors } from '@/lib/theme';
import { confirm, errorMessage, notify } from '@/lib/dialog';
import { safeFileName, shareFile } from '@/lib/files';
import { useApp } from '@/lib/app';

export default function Members() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const gid = Number(id);
  const { data, reload, memberIndex } = useGroup(id);
  const { suspendLock } = useApp();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [sharing, setSharing] = useState(false);

  if (!data) return <Loading />;
  const cur = data.group.currency;

  const run = async (fn: () => Promise<unknown>, title = 'Could not save') => {
    try {
      await fn();
      await reload();
    } catch (e) {
      notify(title, errorMessage(e));
    }
  };

  const add = () => {
    if (!name.trim()) return notify('Enter a name');
    run(async () => {
      await addMember(gid, name);
      setName('');
    }, 'Could not add member');
  };

  const remove = async (m: Member) => {
    if (!(await confirm('Remove member', `Remove ${m.name} from the group?`, 'Remove', true))) return;
    setEditing(null);
    run(() => deleteMember(gid, m.id), 'Could not remove');
  };

  const share = async () => {
    setSharing(true);
    try {
      suspendLock();
      const file = await exportGroup(gid);
      await shareFile(JSON.stringify(file), `${safeFileName(data.group.name)}.splitmate.json`, 'application/json', 'Share group');
    } catch (e) {
      notify('Could not share', errorMessage(e));
    } finally {
      setSharing(false);
    }
  };

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <Card style={{ backgroundColor: colors.primaryLight }}>
        <Text style={{ fontWeight: '700', color: colors.primaryDark }}>Share this group</Text>
        <Text style={{ color: colors.primaryDark, marginTop: 4, fontSize: 13 }}>
          Send the group as a file (WhatsApp, email, Drive…). Your friend opens SplitMate → Import group, picks the file and chooses their name. Send it again any time to share updates.
        </Text>
        <Button small title="Share group file" onPress={share} loading={sharing} style={{ alignSelf: 'flex-start', marginTop: 10 }} testID="share-group-file" />
      </Card>

      <SectionTitle>{data.members.length} members</SectionTitle>
      {data.members.map((m) => {
        const st = data.stats.find((s) => s.memberId === m.id);
        return (
          <Card key={m.id}>
            <Row>
              <Avatar name={m.name} index={memberIndex(m.id)} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={{ fontWeight: '700', fontSize: 15 }}>
                  {m.name}
                  {m.isMe ? ' (you)' : ''}
                </Text>
              </View>
              {st && (
                <Text style={{ fontWeight: '800', color: st.balance > 0 ? colors.positive : st.balance < 0 ? colors.negative : colors.muted }}>
                  {money(st.balance, cur, { sign: true })}
                </Text>
              )}
            </Row>
            {editing === m.id ? (
              <View style={{ marginTop: 12 }}>
                <Field label="Name" value={editName} onChangeText={setEditName} testID={`edit-name-${m.id}`} />
                <Row style={{ gap: 10, flexWrap: 'wrap' }}>
                  <Button small title="Save name" onPress={() => run(async () => { await renameMember(gid, m.id, editName); setEditing(null); })} />
                  <Button small variant="danger" title="Remove" onPress={() => remove(m)} />
                  <Button small variant="ghost" title="Cancel" onPress={() => setEditing(null)} />
                </Row>
              </View>
            ) : (
              <Row style={{ marginTop: 6, gap: 14 }}>
                <Button
                  small
                  variant="ghost"
                  title="Edit"
                  style={{ paddingHorizontal: 0 }}
                  onPress={() => {
                    setEditing(m.id);
                    setEditName(m.name);
                  }}
                  testID={`edit-member-${m.id}`}
                />
                <Button
                  small
                  variant="ghost"
                  title={m.isMe ? 'Not me' : 'This is me'}
                  style={{ paddingHorizontal: 0 }}
                  onPress={() => run(() => setMe(gid, m.isMe ? null : m.id))}
                  testID={`set-me-${m.id}`}
                />
              </Row>
            )}
          </Card>
        );
      })}

      <SectionTitle>Add member</SectionTitle>
      <Card>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Friend's name" onSubmitEditing={add} testID="new-member-name" />
        <Button title="Add member" onPress={add} testID="new-member-add" />
      </Card>
    </Screen>
  );
}
