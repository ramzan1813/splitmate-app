import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button, Card, Row, Screen, SectionTitle } from '@/components/ui';
import { createGroup, listGroups } from '@/data/repo';
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
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    async function init() {
      try {
        let rawUid = params.uid;
        let rawKey = params.key;
        let rawName = params.name ? decodeURIComponent(params.name) : 'Shared Group';
        let rawCur = params.cur || 'USD';

        // Check if raw invite string is present
        if (params.invite) {
          const raw = decodeURIComponent(params.invite);
          const queryIdx = raw.indexOf('?');
          const queryString = queryIdx !== -1 ? raw.slice(queryIdx + 1) : raw;
          const search = new URLSearchParams(queryString);
          rawUid = search.get('uid') || rawUid;
          rawKey = search.get('key') || rawKey;
          rawName = search.get('name') ? decodeURIComponent(search.get('name')!) : rawName;
          rawCur = search.get('cur') || rawCur;
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
          // Already in group, navigate directly
          router.replace(`/group/${existing.id}`);
          return;
        }

        setGroupInfo({
          uid: rawUid,
          key: rawKey,
          name: rawName,
          currency: rawCur,
        });
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [params, router]);

  const handleJoin = async () => {
    if (!groupInfo) return;
    try {
      setJoining(true);
      const newGroup = await createGroup({
        name: groupInfo.name,
        currency: groupInfo.currency,
        myName: profileName || 'Me',
        syncKey: groupInfo.key,
        uid: groupInfo.uid,
      });

      notify('Joined Group', `Connected to ${groupInfo.name} with E2EE sync.`);
      router.replace(`/group/${newGroup.id}`);
    } catch (e) {
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

        <View style={{ width: '100%', backgroundColor: colors.bg, borderRadius: 12, padding: 14, marginBottom: 20 }}>
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

        <Button
          title={`Join ${groupInfo.name}`}
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
