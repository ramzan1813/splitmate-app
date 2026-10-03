// Standard ISO/IEC 18004 QR Code generator using qrcode and react-native-svg.
// Fully compatible with all mobile cameras, Google Lens, and QR scanners.
import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Rect, Path } from 'react-native-svg';
import QRCodeLib from 'qrcode';

interface QRCodeProps {
  value: string;
  size?: number;
  color?: string;
  backgroundColor?: string;
}

export function QRCode({ value, size = 200, color = '#0F172A', backgroundColor = '#FFFFFF' }: QRCodeProps) {
  const { path, matrixSize } = useMemo(() => {
    try {
      // Generate standard QR matrix with Medium error correction (recovers up to 15% damage)
      const qr = QRCodeLib.create(value, { errorCorrectionLevel: 'M' });
      const numModules = qr.modules.size;
      const cellSize = size / numModules;
      let d = '';

      for (let r = 0; r < numModules; r++) {
        for (let c = 0; c < numModules; c++) {
          if (qr.modules.get(r, c)) {
            const x = c * cellSize;
            const y = r * cellSize;
            d += `M${x},${y}h${cellSize}v${cellSize}h-${cellSize}z `;
          }
        }
      }

      return { path: d, matrixSize: numModules };
    } catch {
      return { path: '', matrixSize: 21 };
    }
  }, [value, size]);

  if (!path) {
    return null;
  }

  return (
    <View style={{ width: size, height: size, backgroundColor, padding: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Rect width={size} height={size} fill={backgroundColor} />
        <Path d={path} fill={color} />
      </Svg>
    </View>
  );
}
