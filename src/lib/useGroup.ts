import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { getGroupSummary } from '@/data/repo';
import { GroupSummary } from '@/data/types';
import { errorMessage } from './dialog';

/** Loads a group's full summary from the local database and reloads whenever the screen is focused. */
export function useGroup(id: string | number | undefined) {
  const [data, setData] = useState<GroupSummary | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const gid = Number(id);
    if (!gid) return;
    try {
      setData(await getGroupSummary(gid));
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload])
  );

  const memberName = (mid: number) => data?.members.find((m) => m.id === mid)?.name ?? 'Unknown';
  const memberIndex = (mid: number) => Math.max(0, data?.members.findIndex((m) => m.id === mid) ?? 0);

  return { data, error, reload, memberName, memberIndex };
}
