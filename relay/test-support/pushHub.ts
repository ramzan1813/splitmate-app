// Stands in for Expo's push service in tests: the backend's outbound Expo request is
// answered with ok tickets and each message's `data` is delivered to subscribed clients,
// i.e. what a phone receives as a background notification.
import { defaultOutboundResponse, OutboundRequest } from './testServer';
import type { ChangesAvailableEvent } from '../src/types';

type Listener = (event: ChangesAvailableEvent) => void;

export class ExpoPushHub {
  private listeners = new Map<string, Set<Listener>>();
  private online = true;

  subscribe(groupUid: string, cb: Listener): () => void {
    const set = this.listeners.get(groupUid) ?? new Set<Listener>();
    set.add(cb);
    this.listeners.set(groupUid, set);
    return () => set.delete(cb);
  }

  getSubscriberCount(groupUid: string): number {
    return this.listeners.get(groupUid)?.size ?? 0;
  }

  /** Simulates Expo being unreachable (HTTP 503) so the backend must retry later. */
  setOnline(online: boolean) {
    this.online = online;
  }

  /** Pass as TestServerOptions.respond. */
  respond = (req: OutboundRequest): Response => {
    if (!req.url.includes('exp.host')) return defaultOutboundResponse(req);
    if (!this.online) return new Response('unavailable', { status: 503 });
    const messages = JSON.parse(req.body) as { data: ChangesAvailableEvent }[];
    for (const m of messages) {
      for (const cb of this.listeners.get(m.data.groupUid) ?? []) cb(m.data);
    }
    return defaultOutboundResponse(req);
  };
}
