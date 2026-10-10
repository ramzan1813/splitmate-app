import { useCallback, useLayoutEffect, useState } from 'react';
import { FlatList, Platform, Pressable, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { Avatar, Button, Card, Empty, HeaderButton, Loading, Row } from '@/components/ui';
import { listGroups } from '@/data/repo';
import { getSampleGroupIds, removeSampleGroups } from '@/data/samples';
import { GroupListItem } from '@/data/types';
import { money } from '@/lib/format';
import { colors } from '@/lib/theme';
import { confirm, errorMessage, notify } from '@/lib/dialog';

export default function Home() {
  const router = useRouter();
  const nav = useNavigation();
  const [groups, setGroups] = useState<GroupListItem[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [sampleCount, setSampleCount] = useState(0);

  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <Row style={{ alignItems: 'center', gap: 4 }}>
          <HeaderButton
            title="Insights"
            icon="📊"
            onPress={() => router.push('/insights')}
            testID="open-insights"
            accessibilityLabel="Insights"
          />
          <HeaderButton
            icon="⚙"
            onPress={() => router.push('/settings')}
            testID="open-app-settings"
            accessibilityLabel="Settings"
          />
        </Row>
      ),
    });
  }, [nav, router]);

  const load = useCallback(async () => {
    try {
      setGroups(await listGroups());
      setSampleCount((await getSampleGroupIds()).length);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
      setGroups((g) => g ?? []);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const removeSamples = async () => {
    if (!(await confirm('Remove sample groups', 'Delete the sample groups and all their expenses? Your own groups are not affected.', 'Remove', true))) return;
    try {
      await removeSampleGroups();
      await load();
    } catch (e) {
      notify('Could not remove', errorMessage(e));
    }
  };

  if (!groups) return <Loading />;

  return (
    <View style={{ flex: 1 }}>
      {error ? <Text style={{ color: colors.negative, padding: 12, backgroundColor: colors.negativeBg }}>{error}</Text> : null}
      <FlatList
        data={groups}
        keyExtractor={(g) => String(g.id)}
        contentContainerStyle={{ padding: 16, paddingBottom: 110, flexGrow: 1, maxWidth: 760, width: '100%', alignSelf: 'center' }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        ListHeaderComponent={
          groups.length ? (
            <>
              {sampleCount > 0 && (
                <Card style={{ backgroundColor: colors.primaryLight }} testID="samples-banner">
                  <Text style={{ fontWeight: '800', fontSize: 15, color: colors.primaryDark }}>👋 Welcome to EvenUp</Text>
                  <Text style={{ color: colors.text, marginTop: 4 }}>
                    We added {sampleCount === 1 ? 'a sample group' : `${sampleCount} sample groups`} so you can see how it works: a trip with friends, a shared flat with monthly bills, and a family holiday abroad. Open them, try Balances, Settle up and Insights — then remove them and create your own.
                  </Text>
                  <Button title="Remove sample groups" variant="outline" small onPress={removeSamples} style={{ alignSelf: 'flex-start', marginTop: 10, backgroundColor: colors.white }} testID="remove-samples" />
                </Card>
              )}
              <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 12 }}>Your groups</Text>
            </>
          ) : null
        }
        ListEmptyComponent={
          <Empty title="No groups yet" subtitle="Create a group for a trip, flat, party or anything you share — or import a group file a friend sent you." />
        }
        renderItem={({ item, index }) => (
          <Pressable onPress={() => router.push(`/group/${item.id}`)} testID={`group-${item.id}`}>
            <Card>
              <Row>
                <Avatar name={item.name} index={index} size={44} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={{ color: colors.muted, marginTop: 2 }}>
                    {item.memberCount} members · Total {money(item.totalExpenses, item.currency)}
                  </Text>
                </View>
                {item.hasMe && (
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 11, color: colors.muted }}>{item.myBalance > 0 ? 'you get back' : item.myBalance < 0 ? 'you owe' : 'settled'}</Text>
                    <Text style={{ fontWeight: '800', color: item.myBalance > 0 ? colors.positive : item.myBalance < 0 ? colors.negative : colors.muted }}>
                      {money(Math.abs(item.myBalance), item.currency)}
                    </Text>
                  </View>
                )}
              </Row>
            </Card>
          </Pressable>
        )}
      />

      {/* Responsive Bottom Floating Action Bar */}
      <View
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingBottom: Platform.OS === 'ios' ? 28 : 16,
          paddingTop: 10,
          backgroundColor: 'rgba(241, 245, 249, 0.96)',
          borderTopWidth: 1,
          borderTopColor: 'rgba(203, 213, 225, 0.7)',
        }}
      >
        <View style={{ width: '100%', maxWidth: 760, flexDirection: 'row', gap: 12 }}>
          <Button
            title="Import / Scan QR"
            variant="outline"
            onPress={() => router.push('/import')}
            style={{ flex: 1, backgroundColor: colors.white }}
            testID="import-group"
          />
          <Button
            title="+ New group"
            onPress={() => router.push('/group/new')}
            style={{ flex: 1 }}
            testID="new-group"
          />
        </View>
      </View>
    </View>
  );
}
