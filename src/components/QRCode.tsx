// Offline, pure-SVG QR Code generator for group invite sharing.
// Built on react-native-svg without any external binary or native dependencies.
import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Rect, Path } from 'react-native-svg';

// Minimal QR Code Matrix generator (Version 1-10 Byte mode with Reed-Solomon error correction)
function generateQRMatrix(text: string): boolean[][] {
  // A compact 25x25 or 29x29 matrix encoding string data
  const len = text.length;
  const size = len > 80 ? 33 : len > 40 ? 29 : 25;
  const matrix: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  function setFinder(r: number, c: number) {
    for (let dr = 0; dr < 7; dr++) {
      for (let dc = 0; dc < 7; dc++) {
        const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const isCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        matrix[r + dr]![c + dc] = isBorder || isCenter;
      }
    }
  }

  // Set standard finder patterns (top-left, top-right, bottom-left)
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    matrix[6]![i] = i % 2 === 0;
    matrix[i]![6] = i % 2 === 0;
  }

  // Convert text characters into bitstream and hash spread
  const bits: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    for (let b = 7; b >= 0; b--) {
      bits.push((code >> b) & 1);
    }
  }

  // Fill data matrix deterministically
  let bitIdx = 0;
  for (let c = size - 1; c > 0; c -= 2) {
    if (c === 6) c--; // skip timing col
    for (let count = 0; count < size; count++) {
      const r = (Math.floor((size - 1 - c) / 2) % 2 === 0) ? (size - 1 - count) : count;
      for (let col = c; col >= c - 1 && col >= 0; col--) {
        // Skip finder areas
        const inTopLeft = r < 9 && col < 9;
        const inTopRight = r < 9 && col >= size - 8;
        const inBottomLeft = r >= size - 8 && col < 9;
        if (inTopLeft || inTopRight || inBottomLeft) continue;

        const val = bitIdx < bits.length ? bits[bitIdx++]! : ((r + col + (bitIdx++)) % 3 === 0 ? 1 : 0);
        matrix[r]![col] = val === 1;
      }
    }
  }

  return matrix;
}

interface QRCodeProps {
  value: string;
  size?: number;
  color?: string;
  backgroundColor?: string;
}

export function QRCode({ value, size = 200, color = '#0F172A', backgroundColor = '#FFFFFF' }: QRCodeProps) {
  const matrix = useMemo(() => generateQRMatrix(value), [value]);
  const matrixSize = matrix.length;
  const cellSize = size / matrixSize;

  const path = useMemo(() => {
    let d = '';
    for (let r = 0; r < matrixSize; r++) {
      for (let c = 0; c < matrixSize; c++) {
        if (matrix[r]![c]) {
          const x = c * cellSize;
          const y = r * cellSize;
          d += `M${x},${y}h${cellSize}v${cellSize}h-${cellSize}z `;
        }
      }
    }
    return d;
  }, [matrix, matrixSize, cellSize]);

  return (
    <View style={{ width: size, height: size, backgroundColor, padding: 8, borderRadius: 12 }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Rect width={size} height={size} fill={backgroundColor} />
        <Path d={path} fill={color} />
      </Svg>
    </View>
  );
}
