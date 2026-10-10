import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Avatar, Button, Card, Field, Loading, Row, Screen, SectionTitle } from '@/components/ui';
import { useGroup } from '@/lib/useGroup';
import { addMember, deleteMember, mergeMembers, renameMember, setMe } from '@/data/repo';
import { exportGroup } from '@/data/backup';
import { Member } from '@/data/types';
import { money } from '@/lib/format';
import { colors } from '@/lib/theme';
import { confirm, errorMessage, notify } from '@/lib/dialog';
import { safeFileName, shareFile } from '@/lib/files';
import { useApp } from '@/lib/app';

export default function Members() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const gid = Number(id);
  const { data, reload, memberIndex } = useGroup(id);
  const { suspendLock } = useApp();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [mergingFrom, setMergingFrom] = useState<Member | null>(null);
  const [sharing, setSharing] = useState(false);

  if (!data) return <Loading />;
  const cur = data.group.currency;
  // "Me" is chosen when creating or joining the group. Only a group with nobody marked as me
  // (an older group, or "me" removed on another phone) offers a one-time choice here.
  const canChooseMe = data.myMemberId === null;

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

  const chooseMe = async (m: Member) => {
    const ok = await confirm('This is me', `Mark ${m.name} as you in this group? You can’t change this later.`, 'This is me');
    if (ok) run(() => setMe(gid, m.id));
  };

  const handleMerge = async (target: Member) => {
    if (!mergingFrom) return;
    const isSourceReal = mergingFrom.isMe || Boolean(mergingFrom.userId);
    const isTargetReal = target.isMe || Boolean(target.userId);
    if (isSourceReal) {
      notify('Cannot merge', 'Real registered users cannot be merged away.');
      return;
    }
    if (!isTargetReal) {
      notify('Cannot merge', 'Only a dummy user can be merged into a real user.');
      return;
    }

    const srcName = mergingFrom.name;
    const tgtName = target.name;
    const ok = await confirm(
      'Merge Members',
      `Merge dummy user "${srcName}" into real user "${tgtName}"?\n\nAll past transactions, paid amounts, and split shares belonging to ${srcName} will be transferred to ${tgtName}, and ${srcName} will be removed.`,
      'Merge',
      false
    );
    if (!ok) return;

    run(async () => {
      await mergeMembers(gid, mergingFrom.id, target.id);
      setMergingFrom(null);
      notify('Members Merged', `Consolidated ${srcName} into ${tgtName}.`);
    }, 'Could not merge members');
  };

  const share = async () => {
    setSharing(true);
    try {
      suspendLock();
      const file = await exportGroup(gid);
      await shareFile(JSON.stringify(file), `${safeFileName(data.group.name)}.evenup.json`, 'application/json', 'Share group');
    } catch (e) {
      notify('Could not share', errorMessage(e));
    } finally {
      setSharing(false);
    }
  };

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      {/* Merge Selection Modal / View: only real users are valid targets */}
      {mergingFrom && (
        <Card style={{ backgroundColor: colors.primaryLight, borderWidth: 1.5, borderColor: colors.primary, marginBottom: 16 }}>
          <Text style={{ fontWeight: '800', fontSize: 16, color: colors.primaryDark, marginBottom: 4 }}>
            Merge dummy user “{mergingFrom.name}” into a real user
          </Text>
          <Text style={{ color: colors.primaryDark, fontSize: 13, marginBottom: 12 }}>
            Select the destination real user. All expenses, payments, and splits for {mergingFrom.name} will be reassigned:
          </Text>
          <View style={{ gap: 8, marginBottom: 12 }}>
            {data.members
              .filter((m) => (m.isMe || Boolean(m.userId)) && m.id !== mergingFrom.id)
              .map((target) => (
                <Pressable
                  key={target.id}
                  onPress={() => handleMerge(target)}
                  style={{
                    backgroundColor: colors.card,
                    padding: 12,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: colors.border,
                    flexDirection: 'row',
                    alignItems: 'center',
                  }}
                >
                  <Avatar name={target.name} index={memberIndex(target.id)} size={28} />
                  <Text style={{ marginLeft: 10, fontWeight: '700', fontSize: 14, color: colors.text, flex: 1 }}>
                    {target.name} {target.isMe ? '(you)' : ''}
                  </Text>
                  <View style={{ backgroundColor: '#e6f4ea', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginRight: 8 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#137333' }}>👤 Real User</Text>
                  </View>
                  <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 13 }}>Merge here →</Text>
                </Pressable>
              ))}
            {data.members.filter((m) => (m.isMe || Boolean(m.userId)) && m.id !== mergingFrom.id).length === 0 && (
              <Text style={{ color: colors.muted, fontSize: 13, fontStyle: 'italic', paddingVertical: 6 }}>
                No registered real users available in this group to merge into.
              </Text>
            )}
          </View>
          <Button small variant="ghost" title="Cancel Merge" onPress={() => setMergingFrom(null)} />
        </Card>
      )}

      <Card style={{ backgroundColor: colors.primaryLight }}>
        <Text style={{ fontWeight: '700', color: colors.primaryDark }}>Share this group</Text>
        <Text style={{ color: colors.primaryDark, marginTop: 4, fontSize: 13 }}>
          Send the group as a file (WhatsApp, email, Drive…). Your friend opens EvenUp → Import group, picks the file and chooses their name. Send it again any time to share updates.
        </Text>
        <Button small title="Share group file" onPress={share} loading={sharing} style={{ alignSelf: 'flex-start', marginTop: 10 }} testID="share-group-file" />
      </Card>

      {canChooseMe && (
        <Card style={{ backgroundColor: colors.primaryLight }} testID="choose-me-hint">
          <Text style={{ fontWeight: '700', color: colors.primaryDark }}>Which member are you?</Text>
          <Text style={{ color: colors.primaryDark, marginTop: 4, fontSize: 13 }}>
            Tap “This is me” on your name. You can only choose once.
          </Text>
        </Card>
      )}

      <SectionTitle>{data.members.length} members</SectionTitle>
      {data.members.map((m) => {
        const st = data.stats.find((s) => s.memberId === m.id);
        const isRealUser = m.isMe || Boolean(m.userId);
        return (
          <Card key={m.id} style={{ marginBottom: 12, padding: 0, position: 'relative', overflow: 'hidden' }}>
            {editing !== m.id && (
              <Pressable
                onPress={() => router.push(`/group/${id}/member/${m.id}`)}
                style={({ pressed }) => ({
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 1,
                  opacity: pressed ? 0.8 : 1,
                })}
                testID={`member-card-${m.id}`}
                accessibilityLabel={`${m.name} dashboard`}
              />
            )}

            <View style={{ padding: 14, paddingBottom: 12 }}>
              <Row style={{ alignItems: 'center' }}>
                <Avatar name={m.name} index={memberIndex(m.id)} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Row style={{ alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>
                      {m.name}
                    </Text>
                    {m.isMe && (
                      <View style={{ backgroundColor: colors.primaryLight, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: colors.primaryDark }}>you</Text>
                      </View>
                    )}
                    {isRealUser ? (
                      <View
                        testID={`user-badge-${m.id}`}
                        style={{
                          backgroundColor: '#e6f4ea',
                          borderColor: '#ceead6',
                          borderWidth: 1,
                          paddingHorizontal: 6,
                          paddingVertical: 2,
                          borderRadius: 6,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 3,
                        }}
                      >
                        <Text style={{ fontSize: 11, fontWeight: '700', color: '#137333' }}>👤 User</Text>
                      </View>
                    ) : (
                      <View
                        testID={`dummy-badge-${m.id}`}
                        style={{
                          backgroundColor: '#fef7e0',
                          borderColor: '#feefc3',
                          borderWidth: 1,
                          paddingHorizontal: 6,
                          paddingVertical: 2,
                          borderRadius: 6,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 3,
                        }}
                      >
                        <Text style={{ fontSize: 11, fontWeight: '700', color: '#b06000' }}>Dummy User</Text>
                      </View>
                    )}
                  </Row>
                </View>
                {st && (
                  <Text style={{ fontWeight: '800', color: st.balance > 0 ? colors.positive : st.balance < 0 ? colors.negative : colors.muted }}>
                    {money(st.balance, cur, { sign: true })}
                  </Text>
                )}
              </Row>

              {editing === m.id ? (
                <View style={{ marginTop: 12, zIndex: 2 }}>
                  <Field label="Name" value={editName} onChangeText={setEditName} testID={`edit-name-${m.id}`} />
                  <Row style={{ gap: 10, flexWrap: 'wrap' }}>
                    <Button small title="Save name" onPress={() => run(async () => { await renameMember(gid, m.id, editName); setEditing(null); })} />
                    {!m.isMe && <Button small variant="danger" title="Remove" onPress={() => remove(m)} />}
                    <Button small variant="ghost" title="Cancel" onPress={() => setEditing(null)} />
                  </Row>
                </View>
              ) : (
                <Row style={{ marginTop: 8, gap: 14, zIndex: 2 }}>
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
                  {canChooseMe && (
                    <Button
                      small
                      variant="ghost"
                      title="This is me"
                      style={{ paddingHorizontal: 0 }}
                      onPress={() => chooseMe(m)}
                      testID={`set-me-${m.id}`}
                    />
                  )}
                  {data.members.length > 1 && !isRealUser && (
                    <Button
                      small
                      variant="ghost"
                      title="Merge"
                      style={{ paddingHorizontal: 0 }}
                      onPress={() => setMergingFrom(m)}
                      testID={`merge-member-${m.id}`}
                    />
                  )}
                </Row>
              )}
            </View>
          </Card>
        );
      })}

      {data.canAddMember && (
        <>
          <SectionTitle>Add member</SectionTitle>
          <Card>
            <Field label="Name" value={name} onChangeText={setName} placeholder="Friend's name" onSubmitEditing={add} testID="new-member-name" />
            <Button title="Add member" onPress={add} testID="new-member-add" />
          </Card>
        </>
      )}
    </Screen>
  );
}
