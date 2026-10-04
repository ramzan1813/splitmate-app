import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Avatar, Button, Card, Row, Screen, SectionTitle } from '@/components/ui';
import { createGroup, listGroups } from '@/data/repo';
import { createSyncEvent, syncManager } from '@/data/sync';
import { useApp } from '@/lib/app';
import { colors } from '@/lib/theme';
import { errorMessage, notify } from '@/lib/dialog';

export default function JoinScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    uid?: string;
    key?: string;
    name?: string;
    cur?: string;
    members?: string;
    invite?: string;
  }>();
  const { profileName } = useApp();
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [groupInfo, setGroupInfo] = useState<{
    uid: string;
    key: string;
    name: string;
    currency: string;
    members: string[];
  } | null>(null);
  const [selectedMember, setSelectedMember] = useState<string>('');
  const [error, setError] = useState('');

  const hasHandled = React.useRef(false);

  useEffect(() => {
    async function init() {
      if (hasHandled.current) return;
      try {
        let rawUid = params.uid;
        let rawKey = params.key;
        let rawName = params.name ? decodeURIComponent(params.name) : 'Shared Group';
        let rawCur = params.cur || 'USD';
        let rawMembers: string[] = [];

        if (params.members) {
          rawMembers = decodeURIComponent(params.members)
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean);
        }

        // Check if raw invite string is present
        if (params.invite) {
          const raw = decodeURIComponent(params.invite).trim();
          if (raw.startsWith('{')) {
            try {
              const parsed = JSON.parse(raw);
              rawUid = parsed.uid || rawUid;
              rawKey = parsed.key || parsed.syncKey || rawKey;
              rawName = parsed.name || rawName;
              rawCur = parsed.cur || parsed.currency || rawCur;
              if (Array.isArray(parsed.members)) {
                rawMembers = parsed.members.map((m: any) => (typeof m === 'string' ? m : m.name)).filter(Boolean);
              }
            } catch {
              // ignore json parse error
            }
          } else {
            const queryIdx = raw.indexOf('?');
            const queryString = queryIdx !== -1 ? raw.slice(queryIdx + 1) : raw;
            const search = new URLSearchParams(queryString);
            rawUid = search.get('uid') || rawUid;
            rawKey = search.get('key') || search.get('syncKey') || rawKey;
            rawName = search.get('name') ? decodeURIComponent(search.get('name')!) : rawName;
            rawCur = search.get('cur') || search.get('currency') || rawCur;
            if (search.get('members')) {
              rawMembers = decodeURIComponent(search.get('members')!)
                .split(',')
                .map((m) => m.trim())
                .filter(Boolean);
            }
          }
        }

        if (!rawUid || !rawKey) {
          setError('Invalid or incomplete invite link. Please scan a valid SplitMate QR code or paste an invite link.');
          setLoading(false);
          return;
        }

        // Check if user already has this group
        const existingGroups = await listGroups();
        const existing = existingGroups.find((g) => g.uid === rawUid);
        if (existing) {
          hasHandled.current = true;
          if (existing.syncKey || rawKey) {
            await syncManager.connectGroup(existing.uid, existing.syncKey || rawKey);
            await syncManager.requestState(existing.uid);
          }
          router.replace(`/group/${existing.id}`);
          return;
        }

        // Auto-match profile name if present among members
        const myDefaultName = profileName || 'Me';
        const match = rawMembers.find((m) => m.toLowerCase() === myDefaultName.toLowerCase());
        setSelectedMember(match || myDefaultName);

        setGroupInfo({
          uid: rawUid,
          key: rawKey,
          name: rawName,
          currency: rawCur,
          members: rawMembers,
        });
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [params, router, profileName]);

  const handleJoin = async () => {
    if (!groupInfo || hasHandled.current) return;
    try {
      hasHandled.current = true;
      setJoining(true);
      const myChosenName = selectedMember.trim() || profileName || 'Me';
      const newGroup = await createGroup({
        name: groupInfo.name,
        currency: groupInfo.currency,
        myName: myChosenName,
        members: groupInfo.members,
        syncKey: groupInfo.key,
        uid: groupInfo.uid,
      });

      // Connect to E2EE relay and broadcast JOIN_GROUP announcement + request state
      await syncManager.connectGroup(groupInfo.uid, groupInfo.key);
      await createSyncEvent(groupInfo.uid, 'JOIN_GROUP', { memberName: myChosenName });
      await syncManager.requestState(groupInfo.uid);

      router.replace(`/group/${newGroup.id}`);
    } catch (e) {
      hasHandled.current = false;
      notify("Couldn't join", errorMessage(e));
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return (
      <Screen style={{ justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={{ marginTop: 12, color: colors.muted, fontSize: 14 }}>Connecting to group invite...</Text>
      </Screen>
    );
  }

  if (error || !groupInfo) {
    return (
      <Screen style={{ maxWidth: 480, width: '100%', alignSelf: 'center', justifyContent: 'center' }}>
        <Card style={{ padding: 24, alignItems: 'center' }}>
          <Text style={{ fontSize: 32, marginBottom: 12 }}>⚠️</Text>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text, marginBottom: 8, textAlign: 'center' }}>
            Invite Link Not Recognized
          </Text>
          <Text style={{ color: colors.muted, textAlign: 'center', fontSize: 14, marginBottom: 20 }}>
            {error || 'The invite link or QR code is missing required group sync information.'}
          </Text>
          <Row style={{ gap: 10, width: '100%' }}>
            <Button title="Go to Home" variant="outline" onPress={() => router.replace('/')} style={{ flex: 1 }} />
            <Button title="Manual Import" onPress={() => router.replace('/import')} style={{ flex: 1 }} />
          </Row>
        </Card>
      </Screen>
    );
  }

  const myDefaultName = profileName || 'Me';
  const hasMemberOptions = groupInfo.members && groupInfo.members.length > 0;

  return (
    <Screen style={{ maxWidth: 480, width: '100%', alignSelf: 'center', justifyContent: 'center' }}>
      <Card style={{ padding: 24, alignItems: 'center' }}>
        <Text style={{ fontSize: 36, marginBottom: 12 }}>🤝</Text>
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 6, textAlign: 'center' }}>
          Join {groupInfo.name}
        </Text>
        <Text style={{ color: colors.muted, textAlign: 'center', fontSize: 14, marginBottom: 20 }}>
          You were invited to join this group. All expenses and payments will be synced end-to-end encrypted in real time.
        </Text>

        <View style={{ width: '100%', backgroundColor: colors.bg, borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={{ color: colors.muted, fontSize: 13 }}>Group Name</Text>
            <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text }}>{groupInfo.name}</Text>
          </Row>
          <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={{ color: colors.muted, fontSize: 13 }}>Currency</Text>
            <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text }}>{groupInfo.currency}</Text>
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ color: colors.muted, fontSize: 13 }}>Security</Text>
            <Text style={{ color: colors.positive, fontWeight: '700', fontSize: 13 }}>🔒 E2EE Active</Text>
          </Row>
        </View>

        {/* Member Identity Binding */}
        <View style={{ width: '100%', marginBottom: 20 }}>
          <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text, marginBottom: 8 }}>
            Who represents you in this group?
          </Text>
          <View style={{ gap: 8 }}>
            {hasMemberOptions &&
              groupInfo.members.map((m, idx) => {
                const isSelected = selectedMember.toLowerCase() === m.toLowerCase();
                return (
                  <Pressable
                    key={idx}
                    onPress={() => setSelectedMember(m)}
                    style={{
                      padding: 12,
                      borderRadius: 10,
                      borderWidth: 1.5,
                      borderColor: isSelected ? colors.primary : colors.border,
                      backgroundColor: isSelected ? colors.primaryLight : colors.card,
                      flexDirection: 'row',
                      alignItems: 'center',
                    }}
                  >
                    <Avatar name={m} index={idx} size={28} />
                    <Text
                      style={{
                        marginLeft: 10,
                        fontWeight: isSelected ? '700' : '500',
                        color: isSelected ? colors.primaryDark : colors.text,
                        flex: 1,
                      }}
                    >
                      {m}
                    </Text>
                    {isSelected && <Text style={{ color: colors.primary, fontWeight: '800' }}>✓</Text>}
                  </Pressable>
                );
              })}

            {/* Join as new user if not already matching */}
            {!groupInfo.members.some((m) => m.toLowerCase() === myDefaultName.toLowerCase()) && (
              <Pressable
                onPress={() => setSelectedMember(myDefaultName)}
                style={{
                  padding: 12,
                  borderRadius: 10,
                  borderWidth: 1.5,
                  borderColor: selectedMember.toLowerCase() === myDefaultName.toLowerCase() ? colors.primary : colors.border,
                  backgroundColor: selectedMember.toLowerCase() === myDefaultName.toLowerCase() ? colors.primaryLight : colors.card,
                  flexDirection: 'row',
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 18, marginRight: 10 }}>👤</Text>
                <Text
                  style={{
                    fontWeight: selectedMember.toLowerCase() === myDefaultName.toLowerCase() ? '700' : '500',
                    color: selectedMember.toLowerCase() === myDefaultName.toLowerCase() ? colors.primaryDark : colors.text,
                    flex: 1,
                  }}
                >
                  Join as {myDefaultName} (New Member)
                </Text>
                {selectedMember.toLowerCase() === myDefaultName.toLowerCase() && <Text style={{ color: colors.primary, fontWeight: '800' }}>✓</Text>}
              </Pressable>
            )}
          </View>
        </View>

        <Button
          title={`Join as ${selectedMember || myDefaultName}`}
          onPress={handleJoin}
          loading={joining}
          style={{ width: '100%', marginBottom: 10 }}
        />
        <Button
          title="Cancel"
          variant="ghost"
          onPress={() => router.replace('/')}
          style={{ width: '100%' }}
        />
      </Card>
    </Screen>
  );
}
