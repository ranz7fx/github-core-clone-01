// REST v3 (`/api/v3`): repositories, branches, commits, refs, contents, labels, issues,
// comments and pull requests, over the same store the git, GraphQL and MCP surfaces use.
// Every reply is JSON with a non-empty X-GitHub-Request-Id (set by the HTTP layer); unknown
// routes are 404 JSON; a bad JSON body is 400; a repository under any other owner is 404.

import {
  b64decode,
  b64encode,
  commentGlobalId,
  issueGlobalId,
  parseCommit,
  parseTree,
  prGlobalId,
  repoGlobalId,
  VIEWER_EMAIL,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Comment,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  readonly status: number;
  /** A value to JSON-encode, or a raw Buffer (for an already-encoded body). */
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export const json = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({
  status,
  body,
  headers,
});

export const error = (status: number, message: string): RestResult =>
  json(status, { message });

function isoFromEpoch(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function seqToIso(seq: number): string {
  // Deterministic timestamps: a fixed epoch plus the creation sequence, never Date.now.
  return isoFromEpoch(1_700_000_000 + seq);
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

export function repoJson(repo: Repo, base: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, node_id: 'dXNlcjoxMDAw', type: 'User', site_admin: false },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: seqToIso(repo.createdSeq),
    updated_at: seqToIso(repo.createdSeq),
    pushed_at: seqToIso(repo.createdSeq),
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    fork: false,
  };
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: 1000,
    node_id: 'dXNlcjoxMDAw',
    avatar_url: '',
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    site_admin: false,
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    url: `/api/v3/users/${VIEWER_LOGIN}`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.name.length, node_id: '', name: label.name, color: label.color, description: '', default: false };
}

export function issueJson(repo: Repo, issue: Issue, base: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: '000000' })),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: seqToIso(issue.createdSeq),
    updated_at: seqToIso(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? seqToIso(issue.updatedSeq) : null,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment, base: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, issue, comment),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: seqToIso(comment.createdSeq),
    updated_at: seqToIso(comment.createdSeq),
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pr: PullRequest, base: string): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: prGlobalId(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.state === 'open',
    mergeable_state: pr.state === 'open' ? 'clean' : 'unknown',
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    draft: false,
    locked: false,
    created_at: seqToIso(pr.createdSeq),
    updated_at: seqToIso(pr.createdSeq),
    closed_at: pr.state === 'closed' ? pr.mergedAt ?? seqToIso(pr.createdSeq) : null,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

// ---------------------------------------------------------------------------
// merge (shared by REST and GraphQL)
// ---------------------------------------------------------------------------

export type MergeOutcome =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** A squash merge of `pr` onto its base branch, or a conflict. One commit, parent = base tip. */
export function mergePullRequest(store: Store, repo: Repo, pr: PullRequest): MergeOutcome {
  if (pr.state !== 'open') return { ok: false, status: 405, message: 'Pull request is not open' };
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (baseTip === undefined) return { ok: false, status: 405, message: 'Base branch has no commits' };
  const baseFiles = flattenAt(store, repo, pr.baseSha);
  const oursFiles = flattenAt(store, repo, baseTip);
  const theirsFiles = flattenAt(store, repo, pr.headSha);
  if (baseFiles === null || oursFiles === null || theirsFiles === null) {
    return { ok: false, status: 405, message: 'Pull request branches are missing' };
  }
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set<string>([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  for (const path of paths) {
    const base = baseFiles.get(path);
    const ours = oursFiles.get(path);
    const theirs = theirsFiles.get(path);
    const baseOid = base?.oid;
    const oursOid = ours?.oid;
    const theirsOid = theirs?.oid;
    if (oursOid === theirsOid) {
      if (ours !== undefined) merged.set(path, ours);
    } else if (baseOid === oursOid) {
      if (theirs !== undefined) merged.set(path, theirs);
    } else if (baseOid === theirsOid) {
      if (ours !== undefined) merged.set(path, ours);
    } else {
      return { ok: false, status: 405, message: 'Merge conflict' };
    }
  }
  const message = `Merge pull request #${pr.number} from ${pr.headRef}`;
  const sha = store.commitFiles(repo, `refs/heads/${pr.baseRef}`, merged, message);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = seqToIso(store.nextSeq());
  pr.mergeCommitSha = sha;
  return { ok: true, sha };
}

/** Flatten the tree of a commit id, or null when the commit is not in the store. */
function flattenAt(
  store: Store,
  repo: Repo,
  commitOid: string,
): Map<string, { oid: string; mode: string }> | null {
  const object = store.getObject(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return store.flattenTree(parseCommit(object.data).tree);
}

/** Would a squash merge of `pr` conflict right now? (Used for GraphQL `mergeable`.) */
export function mergeWouldConflict(store: Store, repo: Repo, pr: PullRequest): boolean {
  if (pr.state !== 'open') return false;
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (baseTip === undefined) return false;
  const baseFiles = flattenAt(store, repo, pr.baseSha);
  const oursFiles = flattenAt(store, repo, baseTip);
  const theirsFiles = flattenAt(store, repo, pr.headSha);
  if (baseFiles === null || oursFiles === null || theirsFiles === null) return false;
  const paths = new Set<string>([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  for (const path of paths) {
    const baseOid = baseFiles.get(path)?.oid;
    const oursOid = oursFiles.get(path)?.oid;
    const theirsOid = theirsFiles.get(path)?.oid;
    if (oursOid === theirsOid) continue;
    if (baseOid === oursOid) continue;
    if (baseOid === theirsOid) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// routing helpers
// ---------------------------------------------------------------------------

interface Context {
  readonly store: Store;
  readonly base: string;
  readonly method: string;
  readonly path: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: unknown;
}

function repoOf(ctx: Context): Repo | null {
  const owner = ctx.segments[4];
  const name = ctx.segments[5];
  if (owner !== VIEWER_LOGIN || name === undefined) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function pageParams(ctx: Context): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: readonly T[], ctx: Context): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(ctx);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (page < totalPages) {
    const build = (p: number): string => {
      const params = new URLSearchParams(ctx.query);
      params.set('page', String(p));
      params.set('per_page', String(perPage));
      return `${ctx.base}${ctx.path}?${params.toString()}`;
    };
    const links: string[] = [`<${build(page + 1)}>; rel="next"`, `<${build(totalPages)}>; rel="last"`];
    if (page > 1) links.push(`<${build(1)}>; rel="first"`, `<${build(page - 1)}>; rel="prev"`);
    headers.Link = links.join(', ');
  }
  return { page: pageItems as T[], headers };
}

// ---------------------------------------------------------------------------
// contents helpers
// ---------------------------------------------------------------------------

function countLines(data: Buffer): number {
  const text = data.toString('utf8');
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

export function diffFiles(
  store: Store,
  repo: Repo,
  baseSha: string,
  headSha: string,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseFiles = flattenAt(store, repo, baseSha) ?? new Map();
  const headFiles = flattenAt(store, repo, headSha) ?? new Map();
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
    if (base === undefined && head !== undefined) {
      const data = store.getObject(head.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (base !== undefined && head === undefined) {
      const data = store.getObject(base.oid)?.data ?? Buffer.alloc(0);
      const deletions = countLines(data);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (base !== undefined && head !== undefined) {
      const oldData = store.getObject(base.oid)?.data ?? Buffer.alloc(0);
      const newData = store.getObject(head.oid)?.data ?? Buffer.alloc(0);
      const oldLines = oldData.toString('utf8').split('\n');
      const newLines = newData.toString('utf8').split('\n');
      const oldCounts = new Map<string, number>();
      for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
      let additions = 0;
      for (const line of newLines) {
        const remaining = oldCounts.get(line) ?? 0;
        if (remaining > 0) oldCounts.set(line, remaining - 1);
        else additions += 1;
      }
      let deletions = 0;
      for (const count of oldCounts.values()) deletions += count;
      if (additions === 0 && deletions === 0) {
        additions = 1;
        deletions = 1;
      }
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

function resolveRefTip(store: Store, repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (/^[0-9a-f]{40}$/.test(ref) && store.getObject(ref) !== undefined) return ref;
  return undefined;
}

function commitJson(store: Store, repo: Repo, oid: string, base: string): Record<string, unknown> | null {
  const object = store.getObject(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const parseWho = (line: string): { name: string; email: string; date: string } => {
    const match = line.match(/^(.*?) <(.*?)> (\d+) [+-]\d{4}$/);
    if (match === null) return { name: line, email: '', date: seqToIso(0) };
    return { name: match[1], email: match[2], date: isoFromEpoch(Number(match[3])) };
  };
  const author = parseWho(commit.author);
  const committer = parseWho(commit.committer);
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author,
      committer,
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

function bodyObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** Route a REST v3 request. Returns null when the path is not a REST route at all. */
export function handleRest(
  store: Store,
  method: string,
  path: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  base: string,
): RestResult | null {
  if (segments.length < 3 || segments[1] !== 'api' || segments[2] !== 'v3') return null;
  const ctx: Context = { store, base, method, path, segments, query, body };
  let rest = segments.slice(3);
  if (rest.length > 0 && rest[rest.length - 1] === '') rest = rest.slice(0, -1);

  // GET /api/v3/
  if (rest.length === 0) {
    if (method !== 'GET') return error(404, 'Not Found');
    const urls: Record<string, string> = {
      current_user_url: `${base}/api/v3/user`,
      current_user_authorizations_html_url: `${base}/settings/applications`,
      authorizations_url: `${base}/api/v3/authorizations`,
      code_search_url: `${base}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
      commit_search_url: `${base}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
      emails_url: `${base}/api/v3/user/emails`,
      emojis_url: `${base}/api/v3/emojis`,
      events_url: `${base}/api/v3/events`,
      feeds_url: `${base}/api/v3/feeds`,
      followers_url: `${base}/api/v3/user/followers`,
      following_url: `${base}/api/v3/user/following{/target}`,
      gists_url: `${base}/api/v3/gists{/gist_id}`,
      hub_url: `${base}/api/v3/hub`,
      issue_search_url: `${base}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
      issues_url: `${base}/api/v3/issues`,
      keys_url: `${base}/api/v3/user/keys`,
      labels_url: `${base}/api/v3/repos/{owner}/{repo}/labels{/name}`,
      marketplace_url: `${base}/api/v3/marketplace`,
      notifications_url: `${base}/api/v3/notifications{?since,all,participating}`,
      organizations_url: `${base}/api/v3/user/orgs`,
      public_gists_url: `${base}/api/v3/gists/public`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${base}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
      current_user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${base}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${base}/api/v3/gists/starred`,
      user_url: `${base}/api/v3/users/{user}`,
      user_organizations_url: `${base}/api/v3/users/{user}/orgs`,
      user_repositories_url: `${base}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${base}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
    };
    return json(200, urls, { 'X-OAuth-Scopes': 'repo, read:org, user' });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return error(404, 'Not Found');
    return json(200, { installed_version: '1.0.0' });
  }

  // /api/v3/user and /api/v3/user/repos
  if (rest[0] === 'user') {
    if (rest.length === 1) {
      if (method !== 'GET') return error(404, 'Not Found');
      return json(200, userJson());
    }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.viewerRepos().map((repo) => repoJson(repo, base));
        const { page, headers } = paginate(repos, ctx);
        return json(200, page, headers);
      }
      if (method === 'POST') {
        const input = bodyObject(body);
        const name = bodyString(input, 'name');
        if (name === undefined || name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
          return error(422, 'name is required');
        }
        if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
          return error(422, 'Repository already exists');
        }
        const repo = store.createRepo(
          VIEWER_LOGIN,
          name,
          bodyString(input, 'description') ?? '',
          input.private === true,
        );
        return json(201, repoJson(repo, base));
      }
      return error(404, 'Not Found');
    }
    return error(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}/...
  if (rest[0] === 'repos') {
    const repo = repoOf(ctx);
    if (repo === null) return error(404, 'Not Found');
    const tail = rest.slice(3);

    // /repos/{owner}/{name}
    if (tail.length === 0) {
      if (method === 'GET') return json(200, repoJson(repo, base));
      if (method === 'PATCH') {
        const input = bodyObject(body);
        const description = bodyString(input, 'description');
        if (description !== undefined) repo.description = description;
        if (input.private === true || input.private === false) repo.private = input.private;
        return json(200, repoJson(repo, base));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo.owner, repo.name);
        return json(204, null);
      }
      return error(404, 'Not Found');
    }

    // /repos/{owner}/{name}/branches
    if (tail[0] === 'branches') {
      if (tail.length === 1) {
        if (method !== 'GET') return error(404, 'Not Found');
        const names: string[] = [];
        for (const name of repo.refs.keys()) if (name.startsWith('refs/heads/')) names.push(name.slice('refs/heads/'.length));
        names.sort();
        return json(
          200,
          names.map((name) => ({
            name,
            commit: { sha: repo.refs.get(`refs/heads/${name}`) },
            protected: false,
          })),
        );
      }
      if (tail.length === 2) {
        if (method !== 'GET') return error(404, 'Not Found');
        const sha = repo.refs.get(`refs/heads/${tail[1]}`);
        if (sha === undefined) return error(404, 'Not Found');
        return json(200, { name: tail[1], commit: { sha }, protected: false });
      }
      return error(404, 'Not Found');
    }

    // /repos/{owner}/{name}/commits
    if (tail[0] === 'commits') {
      if (tail.length !== 1 || method !== 'GET') return error(404, 'Not Found');
      const tip = resolveRefTip(store, repo, query.get('sha'));
      if (tip === undefined) return json(200, []);
      const list = store.commitHistory(tip);
      const out: Array<Record<string, unknown>> = [];
      for (const oid of list) {
        const entry = commitJson(store, repo, oid, base);
        if (entry !== null) out.push(entry);
      }
      return json(200, out);
    }

    // /repos/{owner}/{name}/git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2) {
        if (method !== 'POST') return error(404, 'Not Found');
        const input = bodyObject(body);
        const ref = bodyString(input, 'ref');
        const sha = bodyString(input, 'sha');
        if (ref === undefined || !ref.startsWith('refs/') || sha === undefined) {
          return error(422, 'ref and sha are required');
        }
        if (repo.refs.has(ref)) return error(422, 'Reference already exists');
        const object = store.getObject(sha);
        if (object === undefined || object.type !== 'commit') return error(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha, type: 'commit', url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } });
      }
      if (tail.length >= 3) {
        if (method !== 'GET') return error(404, 'Not Found');
        const ref = `refs/${tail.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return error(404, 'Not Found');
        const object = store.getObject(sha);
        return json(200, {
          ref,
          object: { sha, type: object?.type ?? 'commit', url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${object?.type ?? 'commit'}s/${sha}` },
        });
      }
      return error(404, 'Not Found');
    }

    // /repos/{owner}/{name}/contents/{path}
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
      if (method === 'GET') return getContents(store, repo, contentPath, query.get('ref'), base);
      if (method === 'PUT') return putContents(store, repo, contentPath, bodyObject(body), base);
      if (method === 'DELETE') return deleteContents(store, repo, contentPath, bodyObject(body), base);
      return error(404, 'Not Found');
    }

    // /repos/{owner}/{name}/labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        return json(200, [...repo.labels.values()].map((label) => labelJson(label)));
      }
      if (method === 'POST' && tail.length === 1) {
        const input = bodyObject(body);
        const name = bodyString(input, 'name');
        if (name === undefined || name === '') return error(422, 'name is required');
        if (repo.labels.has(name)) return error(422, 'Label already exists');
        const label: Label = { name, color: bodyString(input, 'color') ?? '000000' };
        repo.labels.set(name, label);
        return json(201, labelJson(label));
      }
      return error(404, 'Not Found');
    }

    // /repos/{owner}/{name}/issues...
    if (tail[0] === 'issues') {
      return handleIssues(ctx, repo, tail.slice(1), base);
    }

    // /repos/{owner}/{name}/pulls...
    if (tail[0] === 'pulls') {
      return handlePulls(ctx, repo, tail.slice(1), base);
    }

    return error(404, 'Not Found');
  }

  return error(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function getContents(
  store: Store,
  repo: Repo,
  contentPath: string,
  refParam: string | null,
  base: string,
): RestResult {
  const tip = resolveRefTip(store, repo, refParam);
  if (tip === undefined) return error(404, 'Not Found');
  const object = store.getObject(tip);
  if (object === undefined || object.type !== 'commit') return error(404, 'Not Found');
  const treeOid = parseCommit(object.data).tree;
  const segments = contentPath === '' ? [] : contentPath.split('/');
  let currentTree = treeOid;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const treeObject = store.getObject(currentTree);
    if (treeObject === undefined || treeObject.type !== 'tree') return error(404, 'Not Found');
    const entry = parseTree(treeObject.data).find(
      (candidate) => candidate.name === segments[index] && candidate.mode === '40000',
    );
    if (entry === undefined) return error(404, 'Not Found');
    currentTree = entry.oid;
  }
  const treeObject = store.getObject(currentTree);
  if (treeObject === undefined || treeObject.type !== 'tree') return error(404, 'Not Found');
  const entries = parseTree(treeObject.data);
  if (segments.length === 0) {
    return json(
      200,
      entries.map((entry) => contentEntryJson(store, repo, entry, '', base)),
    );
  }
  const last = segments[segments.length - 1];
  const entry = entries.find((candidate) => candidate.name === last);
  if (entry === undefined) return error(404, 'Not Found');
  if (entry.mode === '40000') {
    const subObject = store.getObject(entry.oid);
    if (subObject === undefined || subObject.type !== 'tree') return error(404, 'Not Found');
    return json(
      200,
      parseTree(subObject.data).map((child) => contentEntryJson(store, repo, child, contentPath, base)),
    );
  }
  const blob = store.getObject(entry.oid);
  if (blob === undefined || blob.type !== 'blob') return error(404, 'Not Found');
  return json(200, {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name: last,
    path: contentPath,
    content: b64encode(blob.data),
    sha: entry.oid,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${contentPath}`,
    html_url: `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${contentPath}`,
    download_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${contentPath}`,
  });
}

function contentEntryJson(
  store: Store,
  repo: Repo,
  entry: { mode: string; name: string; oid: string },
  parentPath: string,
  base: string,
): Record<string, unknown> {
  const path = parentPath === '' ? entry.name : `${parentPath}/${entry.name}`;
  const out: Record<string, unknown> = {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `${base}/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${path}`,
  };
  if (entry.mode !== '40000') {
    const blob = store.getObject(entry.oid);
    out.size = blob?.data.length ?? 0;
    out.download_url = `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`;
  }
  return out;
}

function putContents(
  store: Store,
  repo: Repo,
  contentPath: string,
  input: Record<string, unknown>,
  base: string,
): RestResult {
  const message = bodyString(input, 'message') ?? 'Update file';
  const content = bodyString(input, 'content');
  if (content === undefined) return error(422, 'content is required');
  const branch = bodyString(input, 'branch') ?? repo.defaultBranch;
  const branchRef = `refs/heads/${branch}`;
  if (!repo.refs.has(branchRef)) {
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip !== undefined) repo.refs.set(branchRef, defaultTip);
  }
  const files = store.refFiles(repo, branchRef) ?? new Map<string, { oid: string; mode: string }>();
  const blob = b64decode(content);
  const blobOid = store.putObject('blob', blob);
  const existing = files.get(contentPath);
  const sha = bodyString(input, 'sha');
  if (existing !== undefined) {
    if (sha === undefined || sha !== existing.oid) return error(409, 'sha does not match the current file');
  }
  files.set(contentPath, { oid: blobOid, mode: '100644' });
  const commitSha = store.commitFiles(repo, branchRef, files, message);
  const status = existing === undefined ? 201 : 200;
  return json(status, {
    content: {
      name: contentPath.split('/').pop() ?? contentPath,
      path: contentPath,
      sha: blobOid,
      size: blob.length,
      type: 'file',
      encoding: 'base64',
      content: b64encode(blob),
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${contentPath}`,
    },
    commit: { sha: commitSha, message },
  });
}

function deleteContents(
  store: Store,
  repo: Repo,
  contentPath: string,
  input: Record<string, unknown>,
  base: string,
): RestResult {
  const message = bodyString(input, 'message') ?? 'Delete file';
  const branch = bodyString(input, 'branch') ?? repo.defaultBranch;
  const branchRef = `refs/heads/${branch}`;
  const files = store.refFiles(repo, branchRef);
  if (files === null) return error(404, 'Not Found');
  const existing = files.get(contentPath);
  if (existing === undefined) return error(404, 'Not Found');
  const sha = bodyString(input, 'sha');
  if (sha !== undefined && sha !== existing.oid) return error(409, 'sha does not match the current file');
  files.delete(contentPath);
  const commitSha = store.commitFiles(repo, branchRef, files, message);
  return json(200, { commit: { sha: commitSha, message } });
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function handleIssues(ctx: Context, repo: Repo, tail: string[], base: string): RestResult {
  const { store, method, query } = ctx;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const { page, headers } = paginate(list, ctx);
      return json(200, page.map((issue) => issueJson(repo, issue, base)), headers);
    }
    if (method === 'POST') {
      const input = bodyObject(ctx.body);
      const title = bodyString(input, 'title');
      if (title === undefined || title === '') return error(422, 'title is required');
      const labelNames: string[] = [];
      if (Array.isArray(input.labels)) {
        for (const label of input.labels) {
          const name = typeof label === 'string' ? label : (label as { name?: unknown })?.name;
          if (typeof name !== 'string') continue;
          if (!repo.labels.has(name)) return error(422, `Label ${name} does not exist`);
          labelNames.push(name);
        }
      }
      const seq = store.nextSeq();
      const issue: Issue = {
        id: store.nextIssueId(),
        number: repo.nextNumber,
        title,
        body: bodyString(input, 'body') ?? '',
        state: 'open',
        labels: labelNames,
        createdSeq: seq,
        updatedSeq: seq,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return json(201, issueJson(repo, issue, base));
    }
    return error(404, 'Not Found');
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return error(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return error(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return json(200, issueJson(repo, issue, base));
    if (method === 'PATCH') {
      const input = bodyObject(ctx.body);
      const title = bodyString(input, 'title');
      const body = bodyString(input, 'body');
      const state = bodyString(input, 'state');
      if (title !== undefined) issue.title = title;
      if (body !== undefined) issue.body = body;
      if (state === 'open' || state === 'closed') issue.state = state;
      issue.updatedSeq = store.nextSeq();
      return json(200, issueJson(repo, issue, base));
    }
    return error(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      return json(200, issue.comments.map((comment) => commentJson(repo, issue, comment, base)));
    }
    if (method === 'POST') {
      const input = bodyObject(ctx.body);
      const body = bodyString(input, 'body');
      if (body === undefined || body === '') return error(422, 'body is required');
      const comment: Comment = { id: store.nextCommentId(), body, createdSeq: store.nextSeq() };
      issue.comments.push(comment);
      issue.updatedSeq = store.nextSeq();
      return json(201, commentJson(repo, issue, comment, base));
    }
    return error(404, 'Not Found');
  }
  return error(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

function handlePulls(ctx: Context, repo: Repo, tail: string[], base: string): RestResult {
  const { store, method, query } = ctx;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pr) => pr.state === 'open');
      else if (state === 'closed') list = list.filter((pr) => pr.state === 'closed');
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, headers } = paginate(list, ctx);
      return json(200, page.map((pr) => pullJson(repo, pr, base)), headers);
    }
    if (method === 'POST') {
      const input = bodyObject(ctx.body);
      const head = bodyString(input, 'head');
      const baseRef = bodyString(input, 'base');
      const title = bodyString(input, 'title');
      if (head === undefined || baseRef === undefined || title === undefined || title === '') {
        return error(422, 'head, base and title are required');
      }
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined) return error(422, `Head branch ${head} does not exist`);
      if (baseSha === undefined) return error(422, `Base branch ${baseRef} does not exist`);
      for (const pr of repo.pulls.values()) {
        if (pr.state === 'open' && pr.headRef === head && pr.baseRef === baseRef) {
          return error(422, 'A pull request already exists for this head and base');
        }
      }
      const pr: PullRequest = {
        id: store.nextPrId(),
        number: repo.nextNumber,
        title,
        body: bodyString(input, 'body') ?? '',
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
      return json(201, pullJson(repo, pr, base));
    }
    return error(404, 'Not Found');
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return error(404, 'Not Found');
  const pr = repo.pulls.get(number);
  if (pr === undefined) return error(404, 'Not Found');
  if (tail.length === 1) {
    if (method !== 'GET') return error(404, 'Not Found');
    return json(200, pullJson(repo, pr, base));
  }
  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') return error(404, 'Not Found');
    return json(200, diffFiles(store, repo, pr.baseSha, pr.headSha));
  }
  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') return error(404, 'Not Found');
    const outcome = mergePullRequest(store, repo, pr);
    if (!outcome.ok) return error(outcome.status, outcome.message);
    return json(200, { sha: outcome.sha, merged: true, message: 'Pull request successfully merged' });
  }
  return error(404, 'Not Found');
}
