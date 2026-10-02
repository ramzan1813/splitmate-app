import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Chip, Field, Row, Screen, SectionTitle } from '@/components/ui';
import { createGroup, CURRENCIES } from '@/data/repo';
import { errorMessage, notify } from '@/lib/dialog';
import { useApp } from '@/lib/app';
import { colors } from '@/lib/theme';

export default function NewGroup() {
  const router = useRouter();
  const { profileName } = useApp();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [myName, setMyName] = useState(profileName || '');
  const [members, setMembers] = useState<string[]>(['']);
  const [saving, setSaving] = useState(false);

  const setMember = (i: number, v: string) => setMembers((m) => m.map((x, j) => (j === i ? v : x)));

  const create = async () => {
    if (!name.trim()) return notify('Group name required', 'Give your group a name');
    setSaving(true);
    try {
      const g = await createGroup({ name, description, currency, myName, members: members.filter((m) => m.trim()) });
      router.replace(`/group/${g.id}`);
    } catch (e) {
      notify('Could not create group', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <Field label="Group name" value={name} onChangeText={setName} placeholder="e.g. Murree Trip, Flat 4B" testID="group-name" />
      <Field label="Description (optional)" value={description} onChangeText={setDescription} placeholder="What is this group for?" />
      <SectionTitle>Currency</SectionTitle>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
        {CURRENCIES.map((c) => (
          <Chip key={c} label={c} active={currency === c} onPress={() => setCurrency(c)} testID={`cur-${c}`} />
        ))}
      </ScrollView>
      <SectionTitle>Members</SectionTitle>
      <Field label="You appear in this group as" value={myName} onChangeText={setMyName} />
      {members.map((m, i) => (
        <Row key={i} style={{ marginBottom: 0 }}>
          <View style={{ flex: 1 }}>
            <Field value={m} onChangeText={(v) => setMember(i, v)} placeholder={`Member ${i + 2} name`} testID={`member-input-${i}`} />
          </View>
          {members.length > 1 && (
            <Pressable onPress={() => setMembers((ms) => ms.filter((_, j) => j !== i))} style={{ padding: 10, marginBottom: 14 }}>
              <Text style={{ color: colors.negative, fontSize: 18 }}>✕</Text>
            </Pressable>
          )}
        </Row>
      ))}
      <Button title="+ Add another member" variant="ghost" small onPress={() => setMembers((m) => [...m, ''])} testID="add-member-row" />
      <Text style={{ color: colors.muted, fontSize: 12, marginVertical: 12 }}>
        Friends are just names here — they don’t need the app. You can share the group file with them later from the Members screen.
      </Text>
      <Button title="Create group" onPress={create} loading={saving} testID="create-group" />
    </Screen>
  );
}
