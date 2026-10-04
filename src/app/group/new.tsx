import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, Field, Row, Screen, SectionTitle } from '@/components/ui';
import { CurrencyPicker } from '@/components/CurrencyPicker';
import { createGroup } from '@/data/repo';
import { PermissionModel } from '@/data/types';
import { errorMessage, notify } from '@/lib/dialog';
import { useApp } from '@/lib/app';
import { colors } from '@/lib/theme';

export default function NewGroup() {
  const router = useRouter();
  const { profileName } = useApp();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [permissionModel, setPermissionModel] = useState<PermissionModel>('collaborative');
  const [myName, setMyName] = useState(profileName || '');
  const [members, setMembers] = useState<string[]>(['']);
  const [saving, setSaving] = useState(false);

  const setMember = (i: number, v: string) => setMembers((m) => m.map((x, j) => (j === i ? v : x)));

  const create = async () => {
    if (!name.trim()) return notify('Group name required', 'Give your group a name');
    setSaving(true);
    try {
      const g = await createGroup({
        name,
        description,
        currency,
        permissionModel,
        myName,
        members: members.filter((m) => m.trim()),
      });
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
      <CurrencyPicker value={currency} onChange={setCurrency} />

      <SectionTitle>Group Access & Permissions</SectionTitle>
      <View style={{ gap: 8, marginBottom: 16 }}>
        <Pressable
          onPress={() => setPermissionModel('collaborative')}
          style={{
            padding: 12,
            borderRadius: 12,
            borderWidth: 1.5,
            borderColor: permissionModel === 'collaborative' ? colors.primary : colors.border,
            backgroundColor: permissionModel === 'collaborative' ? colors.primaryLight : colors.card,
          }}
        >
          <Row style={{ justifyContent: 'space-between', marginBottom: 2 }}>
            <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>🤝 Collaborative (Default)</Text>
            {permissionModel === 'collaborative' && <Text style={{ color: colors.primary, fontWeight: '800' }}>✓</Text>}
          </Row>
          <Text style={{ color: colors.muted, fontSize: 13 }}>
            Anyone can add & edit expenses. Deletes are only allowed by the creator of that expense (or group admin).
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setPermissionModel('contributor')}
          style={{
            padding: 12,
            borderRadius: 12,
            borderWidth: 1.5,
            borderColor: permissionModel === 'contributor' ? colors.primary : colors.border,
            backgroundColor: permissionModel === 'contributor' ? colors.primaryLight : colors.card,
          }}
        >
          <Row style={{ justifyContent: 'space-between', marginBottom: 2 }}>
            <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>✍️ Contributor Mode</Text>
            {permissionModel === 'contributor' && <Text style={{ color: colors.primary, fontWeight: '800' }}>✓</Text>}
          </Row>
          <Text style={{ color: colors.muted, fontSize: 13 }}>
            Members can add new expenses, but only the group creator/admin can edit or delete them.
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setPermissionModel('admin_only')}
          style={{
            padding: 12,
            borderRadius: 12,
            borderWidth: 1.5,
            borderColor: permissionModel === 'admin_only' ? colors.primary : colors.border,
            backgroundColor: permissionModel === 'admin_only' ? colors.primaryLight : colors.card,
          }}
        >
          <Row style={{ justifyContent: 'space-between', marginBottom: 2 }}>
            <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>👑 Admin Only (Broadcast)</Text>
            {permissionModel === 'admin_only' && <Text style={{ color: colors.primary, fontWeight: '800' }}>✓</Text>}
          </Row>
          <Text style={{ color: colors.muted, fontSize: 13 }}>
            Only the creator can add, edit, or delete expenses. Other peers have read-only access.
          </Text>
        </Pressable>
      </View>

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
