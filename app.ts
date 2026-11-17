// The single process: one HTTP server serving git smart HTTP, REST v3, GraphQL and MCP from
// one in-memory store. Nothing is written to disk, the clock is never read and no randomness
// is used, so identical request sequences produce identical state.
//
// Routing:
//   GET  /healthz                                   -> {"ok": true} (no auth; the boot probe)
//   /{owner}/{repo}.git/info/refs?service=...       -> git advertisements (no auth)
//   POST /{owner}/{repo}.git/git-upload-pack        -> ls-refs / fetch
//   POST /{owner}/{repo}.git/git-receive-pack       -> push
//   /api/v3/*                                       -> REST v3 (Bearer required)
//   POST /api/graphql                              -> GraphQL (Bearer required)
//   POST /mcp                                      -> MCP JSON-RPC (Bearer required)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitResponse } from './git.ts';
import { handleRest, type RestResult } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp, mcpParseError, type McpResult } from './mcp.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function hasBearer(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined) return false;
  if (!header.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length).trim() !== '';
}

function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': payload.length,
    'x-github-request-id': requestId,
  });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, requestId: string, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

export function createApp(): Server {
  const store = new Store();
  let requestSeq = 0;

  const server = createServer((req, res) => {
    void (async () => {
      const requestId = `req-${(requestSeq += 1).toString(16)}`;
      try {
        const rawUrl = req.url ?? '/';
        const host = req.headers.host ?? '127.0.0.1';
        const url = new URL(rawUrl, `http://${host}`);
        const path = url.pathname;
        const method = req.method ?? 'GET';
        const segments = path.split('/').map((segment) => decodeURIComponent(segment));
        const base = `http://${host}`;

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, requestId, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack
        if (segments.length >= 4 && segments[2].endsWith('.git')) {
          const owner = segments[1];
          const repoName = segments[2].slice(0, -'.git'.length);
          const repo = store.getRepo(owner, repoName);
          const tail = segments.slice(3).join('/');
          if (tail === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
              return;
            }
            const service = url.searchParams.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, requestId, 404, { message: 'Not Found' });
              return;
            }
            const gitProtocolV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const result = handleInfoRefs(store, repo, service, gitProtocolV2);
            sendBuffer(res, requestId, result.status, result.contentType, result.body);
            return;
          }
          if (tail === 'git-upload-pack' || tail === 'git-receive-pack') {
            if (method !== 'POST') {
              sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
              return;
            }
            const body = await readBody(req);
            const result: GitResponse =
              tail === 'git-upload-pack'
                ? handleUploadPack(store, repo, body)
                : handleReceivePack(store, repo, body);
            sendBuffer(res, requestId, result.status, result.contentType, result.body);
            return;
          }
          sendJson(res, requestId, 404, { message: 'Not Found' });
          return;
        }

        // REST v3, GraphQL and MCP all need a non-empty Bearer token.
        if (path === '/api/v3' || path.startsWith('/api/v3/') || path === '/api/graphql' || path === '/mcp') {
          if (!hasBearer(req)) {
            sendJson(res, requestId, 401, { message: 'Unauthorized' });
            return;
          }
          const body = await readBody(req);
          if (path === '/mcp') {
            if (method !== 'POST') {
              sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
              return;
            }
            let parsed: unknown;
            try {
              parsed = body.length === 0 ? null : JSON.parse(body.toString('utf8'));
            } catch {
              const result = mcpParseError();
              sendJson(res, requestId, result.status, result.body);
              return;
            }
            const result: McpResult = handleMcp(store, parsed, base);
            if (result.status === 202) {
              res.writeHead(202, { 'x-github-request-id': requestId });
              res.end();
              return;
            }
            sendJson(res, requestId, result.status, result.body);
            return;
          }
          let parsed: unknown = null;
          if (body.length > 0) {
            try {
              parsed = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, requestId, 400, { message: 'Invalid JSON' });
              return;
            }
          }
          if (path === '/api/graphql') {
            if (method !== 'POST') {
              sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
              return;
            }
            const result = handleGraphql(store, parsed);
            sendJson(res, requestId, result.status, result.body);
            return;
          }
          const query = url.searchParams;
          const result: RestResult | null = handleRest(store, method, path, segments, query, parsed, base);
          if (result === null) {
            sendJson(res, requestId, 404, { message: 'Not Found' });
            return;
          }
          if (result.status === 204) {
            res.writeHead(204, { 'x-github-request-id': requestId, ...(result.headers ?? {}) });
            res.end();
            return;
          }
          const headers: Record<string, string> = {
            'content-type': 'application/json',
            'x-github-request-id': requestId,
            ...(result.headers ?? {}),
          };
          const payload = Buffer.from(JSON.stringify(result.body), 'utf8');
          headers['content-length'] = String(payload.length);
          res.writeHead(result.status, headers);
          res.end(payload);
          return;
        }

        sendJson(res, requestId, 404, { message: 'Not Found' });
      } catch (error) {
        process.stderr.write(`[forge] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        if (!res.headersSent) sendJson(res, requestId, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });

  return server;
}
