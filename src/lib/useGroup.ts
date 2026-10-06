import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { getGroupSummary } from '@/data/repo';
import { GroupSummary } from '@/data/types';
import { GroupSyncStatus, syncEngine } from '@/data/syncEngine';
import { errorMessage } from './dialog';

/** Loads a group's full summary from the local database and keeps it current as sync pulls changes. */
export function useGroup(id: string | number | undefined) {
  const [data, setData] = useState<GroupSummary | null>(null);
  const [error, setError] = useState('');
  const groupUidRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const gid = Number(id);
    if (!gid) return;
    try {
      const summary = await getGroupSummary(gid);
      setData(summary);
      groupUidRef.current = summary.group.uid;
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

  /** Reloads local data and runs a sync cycle (push pending edits, pull others' changes). */
  const refresh = useCallback(async () => {
    await reload();
    const uid = groupUidRef.current;
    if (uid) await syncEngine.syncGroup(uid).catch(() => {});
  }, [reload]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  useEffect(
    () =>
      syncEngine.subscribe((groupUid) => {
        if (groupUidRef.current === groupUid) reload();
      }),
    [reload]
  );

  const memberName = (mid: number) => data?.members.find((m) => m.id === mid)?.name ?? 'Unknown';
  const memberIndex = (mid: number) => Math.max(0, data?.members.findIndex((m) => m.id === mid) ?? 0);

  return { data, error, reload, refresh, memberName, memberIndex };
}

/** Live sync status for one group (drives the header badge). */
export function useSyncStatus(groupUid: string | undefined) {
  const [status, setStatus] = useState<GroupSyncStatus | null>(null);

  useEffect(() => {
    if (!groupUid) return;
    let active = true;
    const load = () => {
      syncEngine
        .getGroupSyncStatus(groupUid)
        .then((s) => active && setStatus(s))
        .catch(() => {});
    };
    load();
    const unsubStatus = syncEngine.subscribeStatus((uid) => uid === groupUid && load());
    const unsubData = syncEngine.subscribe((uid) => uid === groupUid && load());
    return () => {
      active = false;
      unsubStatus();
      unsubData();
    };
  }, [groupUid]);

  return status;
}
