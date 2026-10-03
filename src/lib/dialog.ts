import { Alert, Platform } from 'react-native';

export interface DialogRequest {
  title: string;
  message?: string;
  /** Present for confirmations: [cancel, confirm]. Absent for a plain notice with one OK button. */
  confirmText?: string;
  destructive?: boolean;
  resolve: (ok: boolean) => void;
}

// In-app dialogs are drawn by <DialogHost /> (components/Dialog.tsx). Until it is mounted, fall back to the system dialogs.
let host: ((req: DialogRequest) => void) | null = null;

export function registerDialogHost(show: (req: DialogRequest) => void) {
  host = show;
  return () => {
    if (host === show) host = null;
  };
}

/** Shows a message with an OK button. */
export function notify(title: string, message?: string) {
  if (host) return host({ title, message, resolve: () => {} });
  if (Platform.OS === 'web') {
    window.alert(message ? `${title}\n\n${message}` : title);
  } else {
    Alert.alert(title, message);
  }
}

/** Asks a yes/no question; resolves true when the user confirms. */
export function confirm(title: string, message: string, confirmText = 'OK', destructive = false): Promise<boolean> {
  if (host) {
    const show = host;
    return new Promise((resolve) => show({ title, message, confirmText, destructive, resolve }));
  }
  if (Platform.OS === 'web') {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmText, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ]);
  });
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
