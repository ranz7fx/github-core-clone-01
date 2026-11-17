// Git smart HTTP: info/refs advertisements (v0 and v2), upload-pack (ls-refs, fetch) and
// receive-pack (push). The wire shapes mirror what the suite's git client parses: every
// pkt-line, section header and sideband band is placed exactly where its decoder looks.
//
// Repositories are created through REST only; a push to a missing repo answers 404 and a
// malformed POST never takes the server down.

import {
  collectReachable,
  decodePktLines,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  writePack,
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  DEFAULT_BRANCH,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

export const AGENT = 'forge/1.0';
const UPLOAD_PACK_CAPS_V0 =
  'symref=HEAD:refs/heads/main side-band-64k side-band thin-pack ofs-delta multi_ack_detailed shallow agent=forge/1.0';
const RECEIVE_PACK_CAPS_V0 =
  'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main';

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return {
    status: 404,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'),
  };
}

function badRequest(message: string): GitResponse {
  return {
    status: 400,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// ref listing
// ---------------------------------------------------------------------------

interface ListedRef {
  readonly oid: string;
  readonly name: string;
  /** The commit an annotated tag points at, when this ref is one. */
  readonly peeled?: string;
}

/** HEAD first, then branches, then tags, each group sorted by name. */
function listRefs(store: Store, repo: Repo): ListedRef[] {
  const out: ListedRef[] = [];
  const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  out.push({ oid: mainTip ?? ZERO_OID, name: 'HEAD' });
  const branches: string[] = [];
  const tags: string[] = [];
  for (const name of repo.refs.keys()) {
    if (name.startsWith('refs/heads/')) branches.push(name);
    else if (name.startsWith('refs/tags/')) tags.push(name);
  }
  branches.sort();
  tags.sort();
  for (const name of branches) out.push({ oid: repo.refs.get(name)!, name });
  for (const name of tags) {
    const oid = repo.refs.get(name)!;
    let peeled: string | undefined;
    const object = store.getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = store.getObject(target);
      if (targetObject !== undefined && targetObject.type === 'commit') peeled = target;
    }
    out.push(peeled === undefined ? { oid, name } : { oid, name, peeled });
  }
  return out;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

function v0Advertisement(
  store: Store,
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_PACK_CAPS_V0 : RECEIVE_PACK_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listRefs(store, repo);
  const nonHead = refs.filter((ref) => ref.name !== 'HEAD');
  const head = refs[0];
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (nonHead.length === 0 && headTip === undefined) {
    // An unborn repository advertises only the capabilities line.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`), PKT_FLUSH);
    return Buffer.concat(parts);
  }
  let first = true;
  const line = (oid: string, name: string, peeled?: string): void => {
    parts.push(pktLine(`${oid} ${name}${first ? `\0${caps}` : ''}\n`));
    first = false;
    if (peeled !== undefined) parts.push(pktLine(`${peeled} ${name}^{}\n`));
  };
  line(head.oid, 'HEAD');
  for (const ref of nonHead) line(ref.oid, ref.name, ref.peeled);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('side-band-64k\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  store: Store,
  repo: Repo | undefined,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocolV2: boolean,
): GitResponse {
  if (repo === undefined) return notFound();
  if (service === 'git-receive-pack') {
    // receive-pack is v0 only, whatever the client asked for.
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement(store, repo, service));
  }
  if (gitProtocolV2) return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
  return ok('application/x-git-upload-pack-advertisement', v0Advertisement(store, repo, service));
}

// ---------------------------------------------------------------------------
// upload-pack: ls-refs and fetch
// ---------------------------------------------------------------------------

interface FetchArgs {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly deepen: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isOid(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).split(' ')[0];
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(depth) && depth >= 0) deepen = depth;
    }
  }
  return { wants, haves, shallow, deepen };
}

/** The commits a fetch includes, at what depth, and which of them form the new boundary. */
function planFetch(
  store: Store,
  wants: readonly string[],
  deepen: number | null,
): { included: Map<string, number>; boundary: Set<string> } {
  const included = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of wants) queue.push({ oid: want, dist: 0 });
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    if (deepen !== null && dist >= deepen) continue;
    const known = included.get(oid);
    if (known !== undefined && known <= dist) continue;
    const object = store.getObject(oid);
    if (object === undefined) continue;
    included.set(oid, dist);
    if (object.type === 'commit') {
      if (deepen === null || dist + 1 < deepen) {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
      }
    } else if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, dist });
    }
  }
  const boundary = new Set<string>();
  if (deepen !== null) {
    for (const [oid, dist] of included) {
      if (dist !== deepen - 1) continue;
      const object = store.getObject(oid);
      if (object !== undefined && object.type === 'commit' && parseCommit(object.data).parents.length > 0) {
        boundary.add(oid);
      }
    }
  }
  return { included, boundary };
}

/** Sideband packet: one band byte followed by a chunk of the pack (each chunk fits one pkt-line). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    out.push(pktLine(payload));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

function handleLsRefs(store: Store, repo: Repo, packets: readonly { kind: string; payload?: Buffer }[]): GitResponse {
  let sawDelim = false;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!sawDelim) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (keep('HEAD')) {
    if (mainTip !== undefined) {
      parts.push(pktLine(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  }
  for (const ref of listRefs(store, repo)) {
    if (ref.name === 'HEAD') continue;
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetch(store: Store, repo: Repo, packets: ReturnType<typeof decodePktLines>, v2: boolean): GitResponse {
  // v2: command line, then args after the delim, ending at the flush.
  // v0: wants section, then a flush, then the haves section, then a flush.
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind !== 'data') continue;
    sections[sections.length - 1].push(packet.payload.toString('utf8'));
  }
  let args: FetchArgs;
  if (v2) {
    const afterDelim: string[] = [];
    let sawDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        sawDelim = true;
        continue;
      }
      if (packet.kind === 'flush') break;
      if (sawDelim && packet.kind === 'data') afterDelim.push(packet.payload.toString('utf8'));
    }
    args = parseFetchArgs(afterDelim);
  } else {
    args = parseFetchArgs([...sections[0], ...(sections[1] ?? [])]);
  }
  const { included, boundary } = planFetch(store, args.wants, args.deepen);
  const haveReachable = collectReachable(args.haves, (oid) => store.getObject(oid), new Set(args.shallow));
  // The depth boundary cuts the walk: a boundary commit is sent with its tree, but never its
  // parents, or a depth-1 fetch would silently carry the whole history.
  const sendReachable = collectReachable(included.keys(), (oid) => store.getObject(oid), boundary);
  const toSend: GitObject[] = [];
  for (const oid of sendReachable) {
    if (haveReachable.has(oid)) continue;
    const object = store.getObject(oid);
    if (object !== undefined) toSend.push(object);
  }
  const pack = writePack(toSend);
  const unshallow: string[] = [];
  for (const oid of args.shallow) {
    if (included.has(oid) && !boundary.has(oid)) unshallow.push(oid);
  }
  const shallowLines: string[] = [];
  for (const oid of boundary) shallowLines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) shallowLines.push(`unshallow ${oid}\n`);
  const parts: Buffer[] = [];
  if (v2) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM);
    if (shallowLines.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const line of shallowLines) parts.push(pktLine(line));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
  } else {
    parts.push(pktLine('NAK\n'));
    for (const line of shallowLines) parts.push(pktLine(line));
  }
  parts.push(...sidebandPackets(pack), PKT_FLUSH);
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

export function handleUploadPack(store: Store, repo: Repo | undefined, body: Buffer): GitResponse {
  if (repo === undefined) return notFound();
  let packets: ReturnType<typeof decodePktLines>;
  try {
    packets = decodePktLines(body);
  } catch {
    return badRequest('malformed pkt-line stream');
  }
  const first = packets.find((packet) => packet.kind === 'data');
  if (first === undefined || first.kind !== 'data') return badRequest('empty upload-pack request');
  const command = first.payload.toString('utf8').replace(/\n$/, '');
  if (command.startsWith('command=ls-refs')) return handleLsRefs(store, repo, packets);
  if (command.startsWith('command=fetch')) return handleFetch(store, repo, packets, true);
  // No command line: a v0 fetch (want/have/done across two flush-separated sections).
  if (command.startsWith('want ') || command.startsWith('deepen ')) return handleFetch(store, repo, packets, false);
  return badRequest('unknown upload-pack request');
}

// ---------------------------------------------------------------------------
// receive-pack: push
// ---------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function reportStream(unpack: string, reports: Array<{ ref: string; ok: boolean; reason: string }>): Buffer {
  const parts: Buffer[] = [pktLine(`unpack ${unpack}\n`)];
  for (const report of reports) {
    parts.push(pktLine(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleReceivePack(store: Store, repo: Repo | undefined, body: Buffer): GitResponse {
  if (repo === undefined) return notFound();
  // Parse pkt-lines by hand up to the first flush: the raw pack follows it, and the pack's
  // bytes are not pkt-lines, so the whole body must never go through the pkt-line decoder.
  const commands: PushCommand[] = [];
  let offset = 0;
  let sawFlush = false;
  let packOffset = body.length;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return badRequest('malformed pkt-line stream');
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      sawFlush = true;
      packOffset = offset + 4;
      break;
    }
    if (length < 4 || offset + length > body.length) return badRequest('truncated pkt-line');
    const text = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    const parts = line.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2].startsWith('refs/')) {
      return badRequest('malformed push command');
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    offset += length;
  }
  if (!sawFlush || commands.length === 0) return badRequest('push has no command list');
  const packBytes = body.subarray(packOffset);
  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackError: string | null = null;
  let unpacked: Map<string, GitObject> | null = null;
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackError = 'missing pack';
    } else {
      try {
        unpacked = readPack(packBytes);
      } catch (error) {
        unpackError = error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ') : 'bad pack';
      }
    }
  }
  if (unpackError !== null) {
    for (const command of commands) reports.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    const stream = reportStream(unpackError, reports);
    return ok(
      'application/x-git-receive-pack-result',
      Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), stream])), PKT_FLUSH]),
    );
  }
  if (unpacked !== null) store.putObjects(unpacked.values());
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (current !== command.oldOid) {
        reports.push({ ref: command.ref, ok: false, reason: 'old value does not match current' });
      } else {
        repo.refs.delete(command.ref);
        reports.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (store.getObject(command.newOid) === undefined) {
      reports.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        reports.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      reports.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
    } else if (current !== command.oldOid) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (!store.isAncestor(command.oldOid, command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  const stream = reportStream('ok', reports);
  return ok(
    'application/x-git-receive-pack-result',
    Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), stream])), PKT_FLUSH]),
  );
}
