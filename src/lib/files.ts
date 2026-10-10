// Saving/sharing files and picking files to import. Works on Android, iOS and web.
import { Platform } from 'react-native';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { MAX_FILE_BYTES } from '@/data/backup';

export const safeFileName = (s: string) => s.replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '-') || 'evenup';

function downloadOnWeb(data: string | Uint8Array, filename: string, mime: string) {
  const blob = new Blob([data as BlobPart], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Writes a file to the app cache and opens the share sheet (WhatsApp, Drive, email, Files...). */
export async function shareFile(data: string | Uint8Array, filename: string, mime: string, dialogTitle: string) {
  if (Platform.OS === 'web') return downloadOnWeb(data, filename, mime);
  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete();
  file.create();
  file.write(data);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle });
}

/** Lets the user pick a .json file and returns its text, or null if they cancelled. */
export async function pickTextFile(): Promise<{ name: string; text: string } | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: Platform.OS === 'web' ? ['application/json', '.json'] : ['application/json', 'text/plain', 'application/octet-stream', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled || !res.assets?.length) return null;
  const asset = res.assets[0]!;
  if (asset.size && asset.size > MAX_FILE_BYTES) throw new Error('The file is too large (max 10 MB)');
  let text: string;
  if (Platform.OS === 'web') {
    const webFile = (asset as { file?: Blob }).file;
    text = webFile ? await webFile.text() : await (await fetch(asset.uri)).text();
  } else {
    text = await new File(asset.uri).text();
  }
  return { name: asset.name, text };
}
