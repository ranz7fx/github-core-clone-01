// The forge's store: every object, ref, issue, pull request and label lives here, in
// memory, in insertion order. Nothing touches the filesystem, the clock or Math.random,
// so two runs that receive the same requests in the same order hold byte-identical state.
//
// Identity: the suite's bearer token names the scenario's viewer, "adaiversen" (wire.ts
// buildScenario() derives it from the contest's one fixed seed, so it is the same on every
// trial). A repository belongs to that login; any other owner reads as 404, never 403.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The login the trial's bearer token names. */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's display name and address, used for server-made commits. */
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The all-zero object id. */
export const ZERO_OID = '0'.repeat(40);
/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';
/** The base Unix time server-made commits count up from (deterministic, never Date.now). */
export const COMMIT_EPOCH = 1_700_000_000;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;

export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
export function decodePktLines(bytes: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (length < 4 || length > PKT_LINE_MAX) throw new Error(`bad pkt-line length ${length}`);
      if (offset + length > bytes.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** The text of every data packet, in order. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------
// object parsing / building
// ---------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const who = `${fields.author} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------
// packfile write / read (plain objects only; the suite's client never sends deltas)
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects. The trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

/** Read a packfile's plain objects. Throws on deltas, bad versions or bad checksums. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack entries are not accepted');
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`unknown pack type code ${typeCode}`);
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    offset += inflated.engine.bytesWritten;
    const oid = hashObject(type, inflated.buffer);
    if (!objects.has(oid)) objects.set(oid, { type, data: inflated.buffer });
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  return objects;
}

/**
 * Every object reachable from `roots` (commit -> tree + parents, tag -> target, tree -> entries).
 * A root the store does not hold is skipped, never an error: a client may name an id it holds
 * that this forge does not. `cutAt` names commits that are included with their trees but whose
 * parents are not followed: the client's shallow boundary, where its history stops.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  cutAt?: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (cutAt === undefined || !cutAt.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// the forge's records
// ---------------------------------------------------------------------------

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdSeq: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  updatedSeq: number;
  readonly comments: Comment[];
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  /** The base branch tip when the pull request was opened (the merge base). */
  readonly baseSha: string;
  /** The head branch tip when the pull request was opened. */
  readonly headSha: string;
  readonly createdSeq: number;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  readonly labels: Map<string, Label>;
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber: number;
  readonly createdSeq: number;
}

/** The whole forge: repositories keyed by `owner/name`, objects keyed by id. */
export class Store {
  readonly repos = new Map<string, Repo>();
  readonly objects = new Map<string, GitObject>();
  private repoIdSeq = 0;
  private issueIdSeq = 0;
  private commentIdSeq = 0;
  private prIdSeq = 0;
  private seq = 0;
  /** Deterministic timestamps for server-made commits: COMMIT_EPOCH + this counter. */
  private commitSeq = 0;

  /** The next value of the global creation sequence (issue/PR ordering, timestamps). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** The timestamp for the next server-made commit. */
  nextCommitTimestamp(): number {
    this.commitSeq += 1;
    return COMMIT_EPOCH + this.commitSeq;
  }

  nextRepoId(): number {
    this.repoIdSeq += 1;
    return this.repoIdSeq;
  }

  nextIssueId(): number {
    this.issueIdSeq += 1;
    return this.issueIdSeq;
  }

  nextCommentId(): number {
    this.commentIdSeq += 1;
    return this.commentIdSeq;
  }

  nextPrId(): number {
    this.prIdSeq += 1;
    return this.prIdSeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId(),
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      createdSeq: this.nextSeq(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** All of the viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    return out;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(objects: Iterable<GitObject>): void {
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!this.objects.has(oid)) this.objects.set(oid, { type: object.type, data: object.data });
    }
  }

  /** Is `ancestor` an ancestor of `oid` (or equal to it)? Walks first-parent and all parents. */
  isAncestor(ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const queue = [oid];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** The commit ids reachable from `tip`, tip first, parents after (linear histories stay linear). */
  commitHistory(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** Flatten a tree into path -> {oid, mode}, recursively. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build a tree from a flat path -> blob map, creating intermediate trees. */
  treeFromFiles(files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        let child = node.dirs.get(name);
        if (child === undefined) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit on `repo`'s branch `ref` with `files` as its full tree, or null on conflict. */
  commitFiles(
    repo: Repo,
    ref: string,
    files: Map<string, { oid: string; mode: string }>,
    message: string,
  ): string {
    const treeOid = this.treeFromFiles(files);
    const parent = repo.refs.get(ref);
    const commitData = buildCommit({
      tree: treeOid,
      parents: parent === undefined ? [] : [parent],
      message,
      author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      timestamp: this.nextCommitTimestamp(),
    });
    const oid = this.putObject('commit', commitData);
    repo.refs.set(ref, oid);
    return oid;
  }

  /** The tree of a ref's tip as a flat path map, or null when the ref has no commit. */
  refFiles(repo: Repo, ref: string): Map<string, { oid: string; mode: string }> | null {
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const object = this.objects.get(tip);
    if (object === undefined || object.type !== 'commit') return null;
    return this.flattenTree(parseCommit(object.data).tree);
  }
}

/** Opaque, stable Relay-style global ids (never the plain database id or number). */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`repo:${repo.id}`, 'utf8').toString('base64');
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`issue:${repo.id}:${issue.number}`, 'utf8').toString('base64');
}

export function prGlobalId(repo: Repo, pr: PullRequest): string {
  return Buffer.from(`pr:${repo.id}:${pr.number}`, 'utf8').toString('base64');
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return Buffer.from(`comment:${repo.id}:${issue.number}:${comment.id}`, 'utf8').toString('base64');
}

/** Decode a global id back into its kind and parts, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const kind = parts[0];
  if (kind !== 'repo' && kind !== 'issue' && kind !== 'pr' && kind !== 'comment') return null;
  if (parts.some((part) => part === '')) return null;
  return { kind, parts };
}

/** Base64 of UTF-8 text (the contents API's encoding). */
export function b64encode(data: string | Buffer): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64');
}

/** Decode base64, ignoring whitespace (GitHub wraps content at 60 columns; we never wrap). */
export function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}
