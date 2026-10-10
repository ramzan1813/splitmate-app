import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Avatar, Button, Card, Row, Screen } from '@/components/ui';
import { listGroups } from '@/data/repo';
import { syncEngine, SyncNetworkError } from '@/data/syncEngine';
import { GroupBootstrapResponse } from '@/data/types';
import { useApp } from '@/lib/app';
import { colors } from '@/lib/theme';
import { errorMessage, notify } from '@/lib/dialog';
import { updateServerUrl } from '@/lib/identity';
import { parseInviteData } from '@/lib/invite';

export default function JoinScreen() {
  const router = useRouter();
  // Depend on the strings, not the params object: it is a new object on every render.
  const { uid: uidParam, invite: inviteParam, server: serverParam } = useLocalSearchParams<{ uid?: string; invite?: string; server?: string }>();
  const { profileName } = useApp();
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [snapshot, setSnapshot] = useState<GroupBootstrapResponse | null>(null);
  const [selectedMember, setSelectedMember] = useState('');
  const [targetServerUrl, setTargetServerUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const handled = useRef(false);
  const myDefaultName = profileName || 'Me';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const inviteData = parseInviteData({ uid: uidParam, invite: inviteParam, server: serverParam });
      const { uid, serverUrl } = inviteData;
      setTargetServerUrl(serverUrl);
      if (!uid) {
        setError('Invalid or incomplete invite link. Please scan a valid SplitMate QR code or paste an invite link.');
        return;
      }
      const existing = (await listGroups()).find((g) => g.uid === uid);
      if (existing) {
        if (serverUrl) {
          await updateServerUrl(serverUrl);
        }
        handled.current = true;
        syncEngine.syncGroup(uid).catch(() => {});
        router.replace(`/group/${existing.id}`);
        return;
      }
      const snap = await syncEngine.fetchGroupSnapshot(uid, serverUrl || undefined);
      const match = snap.members.find((m) => m.name.toLowerCase() === myDefaultName.toLowerCase());
      setSelectedMember(match?.name || myDefaultName);
      setSnapshot(snap);
    } catch (e) {
      setError(
        e instanceof SyncNetworkError
          ? `Couldn't reach the SplitMate server to load this group. Check your connection and try again.\n\n${e.message}`
          : errorMessage(e)
      );
    } finally {
      setLoading(false);
    }
  }, [uidParam, inviteParam, serverParam, router, myDefaultName]);

  useEffect(() => {
    if (!handled.current) load();
  }, [load]);

  const handleJoin = async () => {
    if (!snapshot || handled.current) return;
    try {
      handled.current = true;
      setJoining(true);
      if (targetServerUrl) {
        await updateServerUrl(targetServerUrl);
      }
      const groupId = await syncEngine.joinGroup(snapshot, selectedMember.trim() || myDefaultName);
      router.replace(`/group/${groupId}`);
    } catch (e) {
      handled.current = false;
      notify("Couldn't join", errorMessage(e));
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return (
      <Screen style={{ justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={{ marginTop: 12, color: colors.muted, fontSize: 14 }}>Loading group from the server...</Text>
      </Screen>
    );
  }

  if (error || !snapshot) {
    return (
      <Screen style={{ maxWidth: 480, width: '100%', alignSelf: 'center', justifyContent: 'center' }}>
        <Card style={{ padding: 24, alignItems: 'center' }}>
          <Text style={{ fontSize: 32, marginBottom: 12 }}>⚠️</Text>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text, marginBottom: 8, textAlign: 'center' }}>Couldn’t open invite</Text>
          <Text style={{ color: colors.muted, textAlign: 'center', fontSize: 14, marginBottom: 20 }}>
            {error || 'The invite link is missing the group id.'}
          </Text>
          <Row style={{ gap: 10, width: '100%' }}>
            <Button title="Go to Home" variant="outline" onPress={() => router.replace('/')} style={{ flex: 1 }} />
            <Button title="Try again" onPress={load} style={{ flex: 1 }} />
          </Row>
        </Card>
      </Screen>
    );
  }

  const group = snapshot.group;
  const members = snapshot.members.map((m) => m.name);
  const isSelected = (name: string) => selectedMember.toLowerCase() === name.toLowerCase();
  const optionStyle = (name: string) => ({
    padding: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: isSelected(name) ? colors.primary : colors.border,
    backgroundColor: isSelected(name) ? colors.primaryLight : colors.card,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
  });
  const optionText = (name: string) => ({
    fontWeight: (isSelected(name) ? '700' : '500') as '700' | '500',
    color: isSelected(name) ? colors.primaryDark : colors.text,
    flex: 1,
  });

  return (
    <Screen style={{ maxWidth: 480, width: '100%', alignSelf: 'center', justifyContent: 'center' }}>
      <Card style={{ padding: 24, alignItems: 'center' }}>
        <Text style={{ fontSize: 36, marginBottom: 12 }}>🤝</Text>
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 6, textAlign: 'center' }}>Join {group.name}</Text>
        <Text style={{ color: colors.muted, textAlign: 'center', fontSize: 14, marginBottom: 20 }}>
          You were invited to join this group. Expenses and payments sync through the SplitMate server.
        </Text>

        <View style={{ width: '100%', backgroundColor: colors.bg, borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={{ color: colors.muted, fontSize: 13 }}>Group Name</Text>
            <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text }}>{group.name}</Text>
          </Row>
          <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={{ color: colors.muted, fontSize: 13 }}>Currency</Text>
            <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text }}>{group.currency}</Text>
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ color: colors.muted, fontSize: 13 }}>Transactions</Text>
            <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text }}>{snapshot.transactions.length}</Text>
          </Row>
        </View>

        {/* Member Identity Binding */}
        <View style={{ width: '100%', marginBottom: 20 }}>
          <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text, marginBottom: 8 }}>Who represents you in this group?</Text>
          <View style={{ gap: 8 }}>
            {members.map((m, idx) => (
              <Pressable key={m} onPress={() => setSelectedMember(m)} style={optionStyle(m)}>
                <Avatar name={m} index={idx} size={28} />
                <Text style={[optionText(m), { marginLeft: 10 }]}>{m}</Text>
                {isSelected(m) && <Text style={{ color: colors.primary, fontWeight: '800' }}>✓</Text>}
              </Pressable>
            ))}

            {/* Join as a new member if the profile name is not in the group */}
            {!members.some((m) => m.toLowerCase() === myDefaultName.toLowerCase()) && (
              <Pressable onPress={() => setSelectedMember(myDefaultName)} style={optionStyle(myDefaultName)}>
                <Text style={{ fontSize: 18, marginRight: 10 }}>👤</Text>
                <Text style={optionText(myDefaultName)}>Join as {myDefaultName} (New Member)</Text>
                {isSelected(myDefaultName) && <Text style={{ color: colors.primary, fontWeight: '800' }}>✓</Text>}
              </Pressable>
            )}
          </View>
        </View>

        <Button title={`Join as ${selectedMember || myDefaultName}`} onPress={handleJoin} loading={joining} style={{ width: '100%', marginBottom: 10 }} />
        <Button title="Cancel" variant="ghost" onPress={() => router.replace('/')} style={{ width: '100%' }} />
      </Card>
    </Screen>
  );
}
