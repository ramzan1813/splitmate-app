import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { getGroupSummary } from '@/data/repo';
import { GroupSummary } from '@/data/types';
import { errorMessage } from './dialog';
import { subscribeToSync, syncManager } from '@/data/sync';

/** Loads a group's full summary from the local database, connects E2EE sync, and updates reactively. */
export function useGroup(id: string | number | undefined) {
  const [data, setData] = useState<GroupSummary | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const groupUidRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const gid = Number(id);
    if (!gid) return;
    try {
      const summary = await getGroupSummary(gid);
      setData(summary);
      groupUidRef.current = summary.group.uid;
      setError('');
      if (summary?.group?.uid && summary?.group?.syncKey) {
        syncManager.connectGroup(summary.group.uid, summary.group.syncKey);
        setConnected(syncManager.isConnected(summary.group.uid));
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload])
  );

  useEffect(() => {
    const unsub = subscribeToSync((_event, groupUid) => {
      if (!groupUidRef.current || groupUidRef.current === groupUid) {
        reload();
      }
    });

    const interval = setInterval(() => {
      if (groupUidRef.current) {
        setConnected(syncManager.isConnected(groupUidRef.current));
      }
    }, 2000);

    return () => {
      unsub();
      clearInterval(interval);
    };
  }, [reload]);

  const memberName = (mid: number) => data?.members.find((m) => m.id === mid)?.name ?? 'Unknown';
  const memberIndex = (mid: number) => Math.max(0, data?.members.findIndex((m) => m.id === mid) ?? 0);

  return { data, error, reload, memberName, memberIndex, isConnected: connected };
}
