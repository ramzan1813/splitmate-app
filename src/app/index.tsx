import { useCallback, useLayoutEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { Avatar, Button, Card, Empty, Loading, Row } from '@/components/ui';
import { listGroups } from '@/data/repo';
import { GroupListItem } from '@/data/types';
import { money } from '@/lib/format';
import { colors } from '@/lib/theme';
import { errorMessage } from '@/lib/dialog';

export default function Home() {
  const router = useRouter();
  const nav = useNavigation();
  const [groups, setGroups] = useState<GroupListItem[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <Row>
          <Pressable onPress={() => router.push('/insights')} style={{ paddingHorizontal: 8 }} testID="open-insights" accessibilityLabel="Insights">
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Insights</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/settings')} style={{ paddingHorizontal: 8 }} testID="open-app-settings" accessibilityLabel="Settings">
            <Text style={{ color: '#fff', fontSize: 20 }}>⚙</Text>
          </Pressable>
        </Row>
      ),
    });
  }, [nav, router]);

  const load = useCallback(async () => {
    try {
      setGroups(await listGroups());
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

  if (!groups) return <Loading />;

  return (
    <View style={{ flex: 1 }}>
      {error ? <Text style={{ color: colors.negative, padding: 12, backgroundColor: colors.negativeBg }}>{error}</Text> : null}
      <FlatList
        data={groups}
        keyExtractor={(g) => String(g.id)}
        contentContainerStyle={{ padding: 16, paddingBottom: 140, flexGrow: 1, maxWidth: 760, width: '100%', alignSelf: 'center' }}
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
        ListHeaderComponent={groups.length ? <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 12 }}>Your groups</Text> : null}
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
      <View style={{ position: 'absolute', left: 16, right: 16, bottom: 24, flexDirection: 'row', gap: 12 }}>
        <Button title="Import group" variant="outline" onPress={() => router.push('/import')} style={{ flex: 1, backgroundColor: colors.white }} testID="import-group" />
        <Button title="+ New group" onPress={() => router.push('/group/new')} style={{ flex: 1 }} testID="new-group" />
      </View>
    </View>
  );
}
