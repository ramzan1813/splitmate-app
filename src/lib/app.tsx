// App-wide state: database ready, profile name, and the optional PIN lock.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import '@/data/platform';
import { getDb } from '@/data/db';
import { getSetting, setSetting } from '@/data/settings';
import { isPinEnabled } from './pin';

import { onLocalChange } from '@/data/sync';
import { syncEngine } from '@/data/syncEngine';

const LOCK_AFTER_MS = 60_000; // lock again after 1 minute in the background

interface AppCtx {
  ready: boolean;
  error: string;
  profileName: string | null;
  setProfileName: (n: string) => Promise<void>;
  pinEnabled: boolean;
  refreshPin: () => Promise<void>;
  locked: boolean;
  unlock: () => void;
  /** call before opening the share sheet / file picker so returning doesn't re-lock */
  suspendLock: (ms?: number) => void;
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [profileName, setName] = useState<string | null>(null);
  const [pinEnabled, setPinEnabled] = useState(false);
  const [locked, setLocked] = useState(false);
  const backgroundAt = useRef<number | null>(null);
  const suspendedUntil = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        await getDb();
        setName(await getSetting('profile.name'));
        const pin = await isPinEnabled();
        setPinEnabled(pin);
        setLocked(pin);
        setReady(true);
        // Catch up every group with the server (push queued edits, pull others' changes).
        syncEngine.syncAllGroups().catch(() => {});
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // Push each committed local write right away and notify local listeners immediately; if push fails it stays queued for the next trigger.
  useEffect(
    () =>
      onLocalChange((groupUid) => {
        syncEngine.notifyLocalChange(groupUid);
        void syncEngine.syncGroup(groupUid).catch(() => {});
      }),
    []
  );

  useEffect(() => {
    // Returning to the app is a sync trigger: other members may have changed things meanwhile.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && ready) syncEngine.syncAllGroups().catch(() => {});
    });
    return () => sub.remove();
  }, [ready]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') backgroundAt.current = Date.now();
      if (state === 'active' && backgroundAt.current) {
        const away = Date.now() - backgroundAt.current;
        backgroundAt.current = null;
        if (pinEnabled && away > LOCK_AFTER_MS && Date.now() > suspendedUntil.current) setLocked(true);
      }
    });
    return () => sub.remove();
  }, [pinEnabled]);

  const setProfileName = useCallback(async (n: string) => {
    const name = n.trim().slice(0, 80);
    await setSetting('profile.name', name);
    setName(name);
  }, []);

  const refreshPin = useCallback(async () => {
    setPinEnabled(await isPinEnabled());
  }, []);

  const value = useMemo<AppCtx>(
    () => ({
      ready,
      error,
      profileName,
      setProfileName,
      pinEnabled,
      refreshPin,
      locked,
      unlock: () => setLocked(false),
      suspendLock: (ms = 5 * 60_000) => {
        suspendedUntil.current = Date.now() + ms;
      },
    }),
    [ready, error, profileName, setProfileName, pinEnabled, refreshPin, locked]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp must be used inside AppProvider');
  return c;
}
