// Backend REST Synchronization API Gateway for SplitMate Relay
import { ServerDB } from './db';
import { getChangesSince, getGroupBootstrap, processPushMutations, ServerPushRequest } from './syncService';

export interface ServerApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: any;
}

export interface ServerApiResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

export function handleSyncApiRequest(db: ServerDB, req: ServerApiRequest): ServerApiResponse {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const path = req.path.replace(/\/+$/, '');

    // 1. GET /sync/bootstrap/:groupId
    const bootstrapMatch = path.match(/^\/sync\/bootstrap\/([^/]+)$/);
    if (bootstrapMatch && req.method === 'GET') {
      const groupUid = bootstrapMatch[1]!;
      try {
        const snapshot = getGroupBootstrap(db, groupUid);
        return {
          status: 200,
          headers: jsonHeaders,
          body: snapshot,
        };
      } catch (err: any) {
        return {
          status: 404,
          headers: jsonHeaders,
          body: { error: 'NOT_FOUND', message: err?.message || 'Group not found' },
        };
      }
    }

    // 2. GET /sync/changes/:groupId?after=<seq>&limit=<limit>
    const changesMatch = path.match(/^\/sync\/changes\/([^/]+)$/);
    if (changesMatch && req.method === 'GET') {
      const groupUid = changesMatch[1]!;
      const after = Number(req.query?.after || 0);
      const limit = Number(req.query?.limit || 100);

      const delta = getChangesSince(db, groupUid, after, limit);
      return {
        status: 200,
        headers: jsonHeaders,
        body: delta,
      };
    }

    // 3. POST /sync/push
    if (path === '/sync/push' && req.method === 'POST') {
      const body = req.body as ServerPushRequest;
      if (!body || !body.groupUid || !body.deviceId || !Array.isArray(body.mutations)) {
        return {
          status: 400,
          headers: jsonHeaders,
          body: { error: 'BAD_REQUEST', message: 'Missing required push fields (groupUid, deviceId, mutations)' },
        };
      }

      const res = processPushMutations(db, body);
      return {
        status: 200,
        headers: jsonHeaders,
        body: res,
      };
    }

    return {
      status: 404,
      headers: jsonHeaders,
      body: { error: 'ENDPOINT_NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
    };
  } catch (err: any) {
    return {
      status: 500,
      headers: jsonHeaders,
      body: { error: 'INTERNAL_SERVER_ERROR', message: err?.message || 'Server error' },
    };
  }
}
