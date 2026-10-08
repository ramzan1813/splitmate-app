import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button, Card, Field, Loading, Row, Screen, SectionTitle } from '@/components/ui';
import { CurrencyPicker } from '@/components/CurrencyPicker';
import { useGroup } from '@/lib/useGroup';
import { deleteGroup, isGroupAdmin, leaveGroup, updateGroup } from '@/data/repo';
import { GroupSummary, PermissionModel } from '@/data/types';
import { confirm, errorMessage, notify } from '@/lib/dialog';
import { colors } from '@/lib/theme';

export default function GroupSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, reload } = useGroup(id);
  if (!data) return <Loading />;
  return <GroupSettings id={id} data={data} reload={reload} />;
}

function GroupSettings({ id, data, reload }: { id: string; data: GroupSummary; reload: () => Promise<void> }) {
  const router = useRouter();
  const [name, setName] = useState(data.group.name);
  const [description, setDescription] = useState(data.group.description);
  const [currency, setCurrency] = useState(data.group.currency);
  const [permissionModel, setPermissionModel] = useState<PermissionModel>(data.group.permissionModel || 'collaborative');
  const [saving, setSaving] = useState(false);

  const isCreator = data.isCreator;
  const isAdmin = isGroupAdmin(data.group, data.myIdentityId);

  const save = async () => {
    setSaving(true);
    try {
      await updateGroup(Number(id), { name, description, currency, permissionModel });
      await reload();
      notify('Saved', 'Group settings and permissions updated');
    } catch (e) {
      notify('Could not save', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = await confirm(
      'Delete group for everyone',
      `Permanently delete "${data.group.name}" with all its expenses, payments and members — for every member, on every phone and on the server. This can't be undone.`,
      'Delete for everyone',
      true
    );
    if (!ok) return;
    try {
      await deleteGroup(Number(id));
      router.dismissTo('/');
    } catch (e) {
      notify('Could not delete', errorMessage(e));
    }
  };

  const leave = async () => {
    const ok = await confirm(
      'Leave group',
      `Remove "${data.group.name}" from this phone? Nothing changes for the other members, and you can rejoin with an invite link.`,
      'Leave',
      true
    );
    if (!ok) return;
    try {
      await leaveGroup(Number(id));
      router.dismissTo('/');
    } catch (e) {
      notify('Could not leave', errorMessage(e));
    }
  };

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <Field label="Group name" value={name} onChangeText={setName} testID="settings-name" editable={isCreator} />
      <Field label="Description" value={description} onChangeText={setDescription} editable={isCreator} />
      
      {isCreator ? (
        <>
          <SectionTitle>Currency</SectionTitle>
          <CurrencyPicker value={currency} onChange={setCurrency} />

          <SectionTitle>Access & Permissions (Admin)</SectionTitle>
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
                {permissionModel === 'collaborative' && <Text style={{ color: colors.primary, fontWeight: '800' }}>✓ Active</Text>}
              </Row>
              <Text style={{ color: colors.muted, fontSize: 13 }}>
                Anyone can add & edit expenses. Deletes are restricted to the expense author or group admin.
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
                {permissionModel === 'contributor' && <Text style={{ color: colors.primary, fontWeight: '800' }}>✓ Active</Text>}
              </Row>
              <Text style={{ color: colors.muted, fontSize: 13 }}>
                Members can add expenses and edit/delete their own transactions. Only the admin can edit or delete everyone’s transactions.
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
                <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>👑 Admin Only</Text>
                {permissionModel === 'admin_only' && <Text style={{ color: colors.primary, fontWeight: '800' }}>✓ Active</Text>}
              </Row>
              <Text style={{ color: colors.muted, fontSize: 13 }}>
                Only the creator can add, edit, or delete expenses. Other peers have read-only view.
              </Text>
            </Pressable>
          </View>

          <Button title="Save settings" onPress={save} loading={saving} testID="settings-save" />
        </>
      ) : (
        <Card style={{ marginTop: 12, backgroundColor: colors.bg }}>
          <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text, marginBottom: 4 }}>
            🔒 Group Managed by Admin ({data.group.creatorName || 'Creator'})
          </Text>
          <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>
            Permission Mode:{' '}
            <Text style={{ fontWeight: '700', color: colors.text }}>
              {permissionModel === 'admin_only' ? '👑 Admin Only' : permissionModel === 'contributor' ? '✍️ Contributor Mode' : '🤝 Collaborative'}
            </Text>
            {'\n'}Currency: <Text style={{ fontWeight: '700', color: colors.text }}>{currency}</Text>
          </Text>
        </Card>
      )}
      
      <SectionTitle>Danger zone</SectionTitle>
      {isAdmin ? (
        <>
          <Button title="Delete group" variant="danger" onPress={remove} testID="delete-group" />
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>
            As the admin you can delete the group. This erases it for every member.
          </Text>
        </>
      ) : (
        <>
          <Button title="Leave group" variant="danger" onPress={leave} testID="leave-group" />
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>
            Removes the group from this phone only. You can rejoin with an invite link.
          </Text>
        </>
      )}
    </Screen>
  );
}
