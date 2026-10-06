import React, { useEffect, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button, Row } from '@/components/ui';
import { colors } from '@/lib/theme';

interface QRScannerModalProps {
  visible: boolean;
  onClose: () => void;
  onScan: (data: string) => void;
  title?: string;
}

export function QRScannerModal({
  visible,
  onClose,
  onScan,
  title = 'Scan SplitMate QR Code',
}: QRScannerModalProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [showManual, setShowManual] = useState(false);

  // Start fresh each time the scanner opens (state adjusted during render, not in an effect).
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) {
      setScanned(false);
      setShowManual(false);
      setManualInput('');
    }
  }

  useEffect(() => {
    if (visible && !permission?.granted) requestPermission();
  }, [visible, permission?.granted, requestPermission]);

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (scanned || !data) return;
    setScanned(true);
    onScan(data.trim());
    onClose();
  };

  const handleManualSubmit = () => {
    if (!manualInput.trim()) return;
    onScan(manualInput.trim());
    onClose();
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.container}>
          {/* Header */}
          <Row style={styles.header}>
            <Text style={styles.headerTitle}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
          </Row>

          {/* Scanner View or Permissions/Manual Fallback */}
          {Platform.OS === 'web' || !permission?.granted || showManual ? (
            <View style={styles.fallbackContainer}>
              <Text style={styles.fallbackIcon}>📷</Text>
              {!permission?.granted && Platform.OS !== 'web' && (
                <>
                  <Text style={styles.fallbackText}>Camera permission is required to scan QR codes directly.</Text>
                  <Button
                    title="Grant Permission"
                    onPress={requestPermission}
                    style={{ marginBottom: 16 }}
                  />
                </>
              )}
              <Text style={styles.fallbackSubtext}>
                {Platform.OS === 'web'
                  ? 'Paste invite link or QR payload below:'
                  : 'Or paste / enter the invite link / QR code manually:'}
              </Text>
              <TextInput
                value={manualInput}
                onChangeText={setManualInput}
                placeholder="splitmate://join?uid=... or JSON"
                placeholderTextColor="#9CA3AF"
                style={styles.manualInput}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Row style={{ gap: 8, width: '100%' }}>
                <Button title="Join Group" onPress={handleManualSubmit} style={{ flex: 1 }} />
                {permission?.granted && Platform.OS !== 'web' && (
                  <Button
                    variant="outline"
                    title="Open Camera"
                    onPress={() => setShowManual(false)}
                    style={{ flex: 1 }}
                  />
                )}
              </Row>
            </View>
          ) : (
            <View style={styles.cameraWrapper}>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{
                  barcodeTypes: ['qr'],
                }}
                onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
              />

              {/* Viewfinder Target Mask */}
              <View style={styles.maskContainer}>
                <View style={styles.maskTop} />
                <View style={styles.maskMiddle}>
                  <View style={styles.maskSide} />
                  <View style={styles.viewfinder}>
                    <View style={[styles.corner, styles.topLeft]} />
                    <View style={[styles.corner, styles.topRight]} />
                    <View style={[styles.corner, styles.bottomLeft]} />
                    <View style={[styles.corner, styles.bottomRight]} />
                  </View>
                  <View style={styles.maskSide} />
                </View>
                <View style={styles.maskBottom}>
                  <Text style={styles.hintText}>Align the QR code inside the box</Text>
                  <Pressable
                    onPress={() => setShowManual(true)}
                    style={styles.manualSwitchBtn}
                  >
                    <Text style={styles.manualSwitchText}>Enter or paste link manually</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  container: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#0F172A',
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  header: {
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#1E293B',
  },
  headerTitle: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '700',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '700',
  },
  cameraWrapper: {
    height: 380,
    width: '100%',
    position: 'relative',
    overflow: 'hidden',
  },
  maskContainer: {
    ...StyleSheet.absoluteFill,
  },
  maskTop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  maskMiddle: {
    flexDirection: 'row',
    height: 220,
  },
  maskSide: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  viewfinder: {
    width: 220,
    height: 220,
    position: 'relative',
    backgroundColor: 'transparent',
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: colors.primaryLight,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 8,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 8,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 8,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 8,
  },
  maskBottom: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    alignItems: 'center',
    paddingTop: 12,
  },
  hintText: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '600',
  },
  manualSwitchBtn: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 12,
  },
  manualSwitchText: {
    color: colors.primaryLight,
    fontSize: 12,
    fontWeight: '600',
  },
  fallbackContainer: {
    padding: 24,
    alignItems: 'center',
    backgroundColor: '#0F172A',
  },
  fallbackIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  fallbackText: {
    color: '#E2E8F0',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 14,
  },
  fallbackSubtext: {
    color: '#94A3B8',
    fontSize: 13,
    marginBottom: 10,
    textAlign: 'center',
  },
  manualInput: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    padding: 10,
    fontSize: 13,
    backgroundColor: '#1E293B',
    color: '#F8FAFC',
    marginBottom: 16,
  },
});
