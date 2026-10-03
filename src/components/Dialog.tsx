// Draws notify()/confirm() dialogs in the app's own style instead of the system alert boxes.
import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { Button, Row } from './ui';
import { DialogRequest, registerDialogHost } from '@/lib/dialog';
import { colors } from '@/lib/theme';

export function DialogHost() {
  // dialogs can be requested back to back (e.g. two confirmations), so they are queued and shown one at a time
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  useEffect(() => registerDialogHost((req) => setQueue((q) => [...q, req])), []);

  const current = queue[0];
  const close = (ok: boolean) => {
    current?.resolve(ok);
    setQueue((q) => q.slice(1));
  };
  const isConfirm = !!current?.confirmText;

  return (
    <Modal visible={!!current} transparent animationType="fade" onRequestClose={() => close(false)} statusBarTranslucent>
      <Pressable onPress={() => !isConfirm && close(false)} style={{ flex: 1, backgroundColor: 'rgba(17,24,39,0.45)', justifyContent: 'center', padding: 24 }}>
        {current && (
          <Pressable onPress={() => {}} style={{ backgroundColor: colors.card, borderRadius: 20, padding: 20, maxWidth: 400, width: '100%', alignSelf: 'center' }} testID="dialog">
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: current.destructive ? colors.negativeBg : colors.primaryLight,
                marginBottom: 12,
              }}
            >
              <Text style={{ fontSize: 20, fontWeight: '900', color: current.destructive ? colors.negative : colors.primary }}>{current.destructive ? '!' : isConfirm ? '?' : 'i'}</Text>
            </View>
            <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>{current.title}</Text>
            {current.message ? <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 21, marginTop: 6 }}>{current.message}</Text> : null}
            <Row style={{ gap: 10, marginTop: 20 }}>
              {isConfirm && <Button title="Cancel" variant="outline" onPress={() => close(false)} style={{ flex: 1 }} testID="dialog-cancel" />}
              <Button
                title={current.confirmText ?? 'OK'}
                variant={current.destructive ? 'danger' : 'primary'}
                onPress={() => close(true)}
                style={{ flex: 1 }}
                testID="dialog-ok"
              />
            </Row>
          </Pressable>
        )}
      </Pressable>
    </Modal>
  );
}
