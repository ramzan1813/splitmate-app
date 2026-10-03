import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button, Field, Loading, Screen, SectionTitle } from '@/components/ui';
import { CurrencyPicker } from '@/components/CurrencyPicker';
import { useGroup } from '@/lib/useGroup';
import { deleteGroup, updateGroup } from '@/data/repo';
import { GroupSummary } from '@/data/types';
import { confirm, errorMessage, notify } from '@/lib/dialog';

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
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await updateGroup(Number(id), { name, description, currency });
      await reload();
      notify('Saved', 'Group settings updated');
    } catch (e) {
      notify('Could not save', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!(await confirm('Delete group', `Permanently delete "${data.group.name}" and all its expenses from this phone?`, 'Delete', true))) return;
    try {
      await deleteGroup(Number(id));
      router.dismissTo('/');
    } catch (e) {
      notify('Could not delete', errorMessage(e));
    }
  };

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <Field label="Group name" value={name} onChangeText={setName} testID="settings-name" />
      <Field label="Description" value={description} onChangeText={setDescription} />
      <SectionTitle>Currency</SectionTitle>
      <CurrencyPicker value={currency} onChange={setCurrency} />
      <Button title="Save settings" onPress={save} loading={saving} testID="settings-save" />
      <SectionTitle>Danger zone</SectionTitle>
      <Button title="Delete group" variant="danger" onPress={remove} testID="delete-group" />
    </Screen>
  );
}
