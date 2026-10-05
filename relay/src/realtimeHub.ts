// Server-side Realtime Notification Hub for Cloudflare Relay
import { RealtimeNotification } from './types';

export type RealtimeSubscriber = (notification: RealtimeNotification) => void;

export class RealtimeHub {
  private subscribers = new Map<string, Set<RealtimeSubscriber>>();

  public subscribe(groupUid: string, subscriber: RealtimeSubscriber): () => void {
    if (!this.subscribers.has(groupUid)) {
      this.subscribers.set(groupUid, new Set());
    }
    const groupSubs = this.subscribers.get(groupUid)!;
    groupSubs.add(subscriber);

    return () => {
      groupSubs.delete(subscriber);
      if (groupSubs.size === 0) {
        this.subscribers.delete(groupUid);
      }
    };
  }

  public publish(groupUid: string, notification: RealtimeNotification): void {
    const groupSubs = this.subscribers.get(groupUid);
    if (!groupSubs) return;

    for (const sub of groupSubs) {
      try {
        sub(notification);
      } catch {
        // Safe execution: ignore individual subscriber errors
      }
    }
  }

  public getSubscriberCount(groupUid: string): number {
    return this.subscribers.get(groupUid)?.size ?? 0;
  }

  public clear(): void {
    this.subscribers.clear();
  }
}

export const serverRealtimeHub = new RealtimeHub();
