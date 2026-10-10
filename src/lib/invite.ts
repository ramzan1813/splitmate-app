import { normalizeServerUrl } from './identity';

export interface InviteData {
  uid: string | null;
  serverUrl: string | null;
  name: string | null;
  currency: string | null;
}

/** Robustly pulls the group uid, server URL, name, and currency from route params, deep links, URLs or JSON payloads. */
export function parseInviteData(params: { uid?: string; invite?: string; server?: string }): InviteData {
  let uid: string | null = params.uid || null;
  let serverUrl: string | null = params.server ? normalizeServerUrl(params.server) : null;
  let name: string | null = null;
  let currency: string | null = null;

  if (params.invite) {
    const raw = decodeURIComponent(params.invite).trim();
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.uid === 'string' && parsed.uid) uid = parsed.uid;
        if (typeof parsed.server === 'string' && parsed.server) serverUrl = normalizeServerUrl(parsed.server);
        if (typeof parsed.serverUrl === 'string' && parsed.serverUrl) serverUrl = normalizeServerUrl(parsed.serverUrl);
        if (typeof parsed.name === 'string' && parsed.name) name = parsed.name;
        if (typeof parsed.cur === 'string' && parsed.cur) currency = parsed.cur;
        if (typeof parsed.currency === 'string' && parsed.currency) currency = parsed.currency;
      } catch {
        // fall through
      }
    } else {
      // Check if raw is a full URL (http://, https://, splitmate://)
      if (/^https?:\/\//i.test(raw)) {
        try {
          const urlObj = new URL(raw);
          const queryServer = urlObj.searchParams.get('server');
          if (queryServer) {
            serverUrl = normalizeServerUrl(queryServer);
          } else if (urlObj.origin && urlObj.origin !== 'null') {
            serverUrl = normalizeServerUrl(urlObj.origin);
          }
          const queryUid = urlObj.searchParams.get('uid');
          if (queryUid) uid = queryUid;
          const queryName = urlObj.searchParams.get('name');
          if (queryName) name = queryName;
          const queryCur = urlObj.searchParams.get('cur') || urlObj.searchParams.get('currency');
          if (queryCur) currency = queryCur;
        } catch {
          // ignore URL constructor error and use query string parsing below
        }
      }

      if (!uid || !serverUrl) {
        const queryIdx = raw.indexOf('?');
        const qs = queryIdx !== -1 ? raw.slice(queryIdx + 1) : raw;
        const sp = new URLSearchParams(qs);
        const queryUid = sp.get('uid');
        if (queryUid && !uid) uid = queryUid;
        const queryServer = sp.get('server');
        if (queryServer && !serverUrl) serverUrl = normalizeServerUrl(queryServer);
        const queryName = sp.get('name');
        if (queryName && !name) name = queryName;
        const queryCur = sp.get('cur') || sp.get('currency');
        if (queryCur && !currency) currency = queryCur;
      }

      // Plain group UID string fallback (e.g. grp_...)
      if (!uid && /^grp_[a-zA-Z0-9_-]+$/.test(raw)) {
        uid = raw;
      }
    }
  }

  return { uid, serverUrl, name, currency };
}

/** Constructs an invite link that bundles the group UID, metadata, and the active server base URL. */
export function buildInviteLink(serverUrl: string, group: { uid: string; name: string; currency: string }): string {
  const base = normalizeServerUrl(serverUrl);
  const qs = `uid=${encodeURIComponent(group.uid)}&name=${encodeURIComponent(group.name)}&cur=${encodeURIComponent(group.currency)}&server=${encodeURIComponent(base)}`;
  return `${base}/join?${qs}`;
}
