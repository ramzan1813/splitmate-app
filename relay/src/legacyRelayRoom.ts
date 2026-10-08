// Placeholder for the v2 relay's Durable Object class. Cloudflare refuses a deploy that stops
// exporting a class with existing Durable Objects unless a delete-class migration is applied,
// and that migration permanently erases their SQLite storage (the v2 server-side sync data).
// Exporting this class keeps that data intact while nothing routes to it any more.
// Remove it only together with an explicit delete-class migration, after the data is exported
// or deliberately discarded.
export class RelayRoom {
  async fetch(): Promise<Response> {
    return Response.json(
      { error: 'GONE', message: 'The WebSocket relay was replaced by the HTTP sync API (/sync/*)' },
      { status: 410 }
    );
  }
}
