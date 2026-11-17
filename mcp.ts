// MCP (`POST /mcp`): JSON-RPC 2.0 Streamable HTTP, answered as plain JSON. The modern era
// revision 2026-07-28 is served through `server/discover`; the legacy `initialize` handshake
// is answered too, for safety. Six canonical tools share the store with REST and GraphQL:
// create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request.
// An unknown tool is a JSON-RPC error; a bad call is a tool result with isError, never HTTP 500.

import {
  VIEWER_LOGIN,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { issueJson, mergePullRequest, pullJson, repoJson } from './rest.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description?: string }>;
    readonly required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new Error(`missing required argument "${key}"`);
  return value;
}

function requireRepo(store: Store, owner: string, repoName: string): Repo {
  if (owner !== VIEWER_LOGIN) throw new Error('Not Found');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) throw new Error('Not Found');
  return repo;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown; isError?: boolean };

function toolResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true, structuredContent: { error: message } };
}

function callTool(store: Store, base: string, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = requireString(args, 'name');
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) throw new Error('Repository already exists');
      const repo = store.createRepo(
        VIEWER_LOGIN,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolResult(repoJson(repo, base));
    }
    case 'get_repo': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      return toolResult(repoJson(requireRepo(store, owner, repoName), base));
    }
    case 'create_issue': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      const title = requireString(args, 'title');
      const repo = requireRepo(store, owner, repoName);
      const seq = store.nextSeq();
      const issue: Issue = {
        id: store.nextIssueId(),
        number: repo.nextNumber,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdSeq: seq,
        updatedSeq: seq,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return toolResult(issueJson(repo, issue, base));
    }
    case 'list_issues': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      const repo = requireRepo(store, owner, repoName);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return toolResult(list.map((issue) => issueJson(repo, issue, base)));
    }
    case 'create_pull_request': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      const title = requireString(args, 'title');
      const head = requireString(args, 'head');
      const baseRef = requireString(args, 'base');
      const repo = requireRepo(store, owner, repoName);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined) throw new Error(`Head branch ${head} does not exist`);
      if (baseSha === undefined) throw new Error(`Base branch ${baseRef} does not exist`);
      for (const pr of repo.pulls.values()) {
        if (pr.state === 'open' && pr.headRef === head && pr.baseRef === baseRef) {
          throw new Error('A pull request already exists for this head and base');
        }
      }
      const pr: PullRequest = {
        id: store.nextPrId(),
        number: repo.nextNumber,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef,
        baseSha,
        headSha,
        createdSeq: store.nextSeq(),
      };
      repo.nextNumber += 1;
      repo.pulls.set(pr.number, pr);
      return toolResult(pullJson(repo, pr, base));
    }
    case 'merge_pull_request': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      const repo = requireRepo(store, owner, repoName);
      const pullNumber = args.pull_number;
      if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber)) {
        throw new Error('missing required argument "pull_number"');
      }
      const pr = repo.pulls.get(pullNumber);
      if (pr === undefined) throw new Error('Not Found');
      const outcome = mergePullRequest(store, repo, pr);
      if (!outcome.ok) throw new Error(outcome.message);
      return toolResult(pullJson(repo, pr, base));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export interface McpResult {
  readonly status: number;
  readonly body: unknown;
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** The answer to a body that is not JSON at all: HTTP 400, JSON-RPC -32700, id null. */
export function mcpParseError(): McpResult {
  return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
}

export function handleMcp(store: Store, body: unknown, base: string): McpResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const request = body as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = request.method;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  // Notifications carry no id and get no reply body.
  if (method.startsWith('notifications/')) return { status: 202, body: null };
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = params.protocolVersion;
    const protocolVersion =
      typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (typeof name !== 'string') return rpcError(id, -32602, 'Tool name is required');
    if (!TOOL_MAP.has(name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOL_MAP.get(name)!;
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return rpcResult(id, toolError(`missing required argument "${required}"`));
      }
    }
    try {
      return rpcResult(id, callTool(store, base, name, args));
    } catch (error) {
      return rpcResult(id, toolError(error instanceof Error ? error.message : 'Tool call failed'));
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
