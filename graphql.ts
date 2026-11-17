// GraphQL (`POST /api/graphql`): the subset of the language the suite's documents use —
// named operations, variables, aliases, inline fragments, input objects and enums — executed
// against the same store as REST. Unknown fields are reported as errors (HTTP 200, as the
// suite expects); an unknown repository resolves to `repository: null` with no errors;
// a batch (a JSON array of operations) answers with an array in the same order.

import {
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  prGlobalId,
  repoGlobalId,
  VIEWER_EMAIL,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Comment,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { diffFiles, mergePullRequest, mergeWouldConflict } from './rest.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'int'; readonly value: string }
  | { readonly kind: 'float'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'punct'; readonly value: string }
  | { readonly kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '﻿') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '.' && source[index + 1] === '.' && source[index + 2] === '.') {
      tokens.push({ kind: 'spread' });
      index += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') {
          const escaped = source[index + 1];
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else if (escaped === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
            index += 4;
          } else value += escaped ?? '';
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let end = index;
      if (source[end] === '-') end += 1;
      while (end < source.length && /[0-9]/.test(source[end])) end += 1;
      let isFloat = false;
      if (source[end] === '.') {
        isFloat = true;
        end += 1;
        while (end < source.length && /[0-9]/.test(source[end])) end += 1;
      }
      if (source[end] === 'e' || source[end] === 'E') {
        isFloat = true;
        end += 1;
        if (source[end] === '+' || source[end] === '-') end += 1;
        while (end < source.length && /[0-9]/.test(source[end])) end += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      let end = index;
      while (end < source.length && /[_A-Za-z0-9]/.test(source[end])) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selection: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  readonly kind: 'spread';
  readonly name: string;
}

interface InlineFragmentNode {
  readonly kind: 'inline';
  readonly typeCondition: string | null;
  readonly selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  readonly kind: 'operation';
  readonly operation: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  readonly selection: SelectionNode[];
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly name: string;
  readonly typeCondition: string;
  readonly selection: SelectionNode[];
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value} in GraphQL document`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Array<OperationNode | FragmentNode> {
    const definitions: Array<OperationNode | FragmentNode> = [];
    while (this.index < this.tokens.length) definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): OperationNode | FragmentNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selection: this.parseSelectionSet() };
    }
    if (token !== undefined && token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      this.next();
      const operation = token.value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      const next = this.peek();
      if (next !== undefined && next.kind === 'name') {
        name = next.value;
        this.next();
      }
      const variableDefinitions = this.parseVariableDefinitions();
      return { kind: 'operation', operation, name, variableDefinitions, selection: this.parseSelectionSet() };
    }
    if (token !== undefined && token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      const on = this.expectName();
      if (on !== 'on') throw new Error('expected on in fragment definition');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selection: this.parseSelectionSet() };
    }
    throw new Error('expected an operation or fragment definition');
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const definitions: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (!this.acceptPunct('(')) return definitions;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      definitions.push({ name, defaultValue });
    }
    return definitions;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      if (next !== undefined && next.kind === 'name') {
        const name = next.value;
        this.next();
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() };
    }
    const nameOrAlias = this.expectName();
    let alias: string | null = null;
    let name = nameOrAlias;
    if (this.acceptPunct(':')) {
      alias = nameOrAlias;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const next = this.peek();
    const selection = next !== undefined && next.kind === 'punct' && next.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selection };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private skipDirectives(): void {
    while (true) {
      const token = this.peek();
      if (token === undefined || token.kind !== 'punct' || token.value !== '@') return;
      this.next();
      this.expectName();
      this.parseArguments();
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('expected a value in GraphQL document');
  }
}

// ---------------------------------------------------------------------------
// schema (for __type / __schema introspection)
// ---------------------------------------------------------------------------

interface TypeDef {
  readonly kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  readonly fields: string[];
  readonly enumValues: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'], enumValues: [] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'], enumValues: [] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email'], enumValues: [] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt'],
    enumValues: [],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'labels', 'author', 'createdAt', 'updatedAt', 'url', 'repository'], enumValues: [] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount', 'edges'], enumValues: [] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'], enumValues: [] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'repository'],
    enumValues: [],
  },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount', 'edges'], enumValues: [] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'], enumValues: [] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'], enumValues: [] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'], enumValues: [] },
  Ref: { kind: 'OBJECT', fields: ['name', 'target'], enumValues: [] },
  GitObject: { kind: 'OBJECT', fields: ['oid'], enumValues: [] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'], enumValues: [] },
  Comment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt'], enumValues: [] },
  CommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'], enumValues: [] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'], enumValues: [] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'], enumValues: [] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'], enumValues: [] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'], enumValues: [] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'comment', 'clientMutationId'], enumValues: [] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'MILESTONE', 'PROJECT', 'LABEL', 'ORGANIZATION', 'PACKAGE'],
  },
  String: { kind: 'SCALAR', fields: [], enumValues: [] },
  Int: { kind: 'SCALAR', fields: [], enumValues: [] },
  Boolean: { kind: 'SCALAR', fields: [], enumValues: [] },
  ID: { kind: 'SCALAR', fields: [], enumValues: [] },
};

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface GqlContext {
  readonly store: Store;
  readonly errors: Array<{ message: string }>;
}

type GqlValue = Record<string, unknown> | null;

function seqIso(seq: number): string {
  return new Date((1_700_000_000 + seq) * 1000).toISOString();
}

function unwrapValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => unwrapValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = unwrapValue(field.value, variables);
      return out;
    }
  }
}

function argMap(args: Array<{ name: string; value: ValueNode }>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = unwrapValue(arg.value, variables);
  return out;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = text.match(/^cursor:(\d+)$/);
  return match === null ? null : Number(match[1]);
}

interface Page {
  readonly sliced: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor: string | null;
  readonly endCursor: string | null;
}

function paginate<T>(items: readonly T[], args: Record<string, unknown>): { items: T[]; page: Page } {
  let start = 0;
  if (typeof args.after === 'string') {
    const index = decodeCursor(args.after);
    if (index !== null) start = index + 1;
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : items.length;
  const sliced = items.slice(start, start + first);
  return {
    items: sliced,
    page: {
      sliced: sliced.length,
      hasNextPage: start + sliced.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: sliced.length > 0 ? encodeCursor(start) : null,
      endCursor: sliced.length > 0 ? encodeCursor(start + sliced.length - 1) : null,
    },
  };
}

function pageInfoObject(page: Page): Record<string, unknown> {
  return {
    __typename: 'PageInfo',
    hasNextPage: page.hasNextPage,
    hasPreviousPage: page.hasPreviousPage,
    startCursor: page.startCursor,
    endCursor: page.endCursor,
  };
}

// Wrappers around store entities; the entity itself stays under a plain key so the resolver
// can reach it, and __typename drives inline fragments.
function repoObject(repo: Repo): Record<string, unknown> {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __typename: 'Issue', repo, issue };
}

function prObject(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return { __typename: 'PullRequest', repo, pr };
}

function commentObject(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return { __typename: 'Comment', repo, issue, comment };
}

function userObject(): Record<string, unknown> {
  return { __typename: 'User' };
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function executeSelection(
  typeName: string,
  source: Record<string, unknown>,
  selections: SelectionNode[],
  ctx: GqlContext,
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== typeName) continue;
      Object.assign(out, executeSelection(typeName, source, fragment.selection, ctx, variables, fragments));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelection(typeName, source, selection.selection, ctx, variables, fragments));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const args = argMap(selection.args, variables);
    const value = resolveField(typeName, selection.name, source, args, ctx, variables);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      if (selection.selection === null) {
        out[key] = value;
        continue;
      }
      out[key] = value.map((item) => {
        if (item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>).__typename === 'string') {
          return executeSelection(
            (item as Record<string, unknown>).__typename as string,
            item as Record<string, unknown>,
            selection.selection as SelectionNode[],
            ctx,
            variables,
            fragments,
          );
        }
        return item;
      });
      continue;
    }
    if (typeof value !== 'object') {
      out[key] = value;
      continue;
    }
    if (selection.selection === null) {
      out[key] = value;
      continue;
    }
    const childType = (value as Record<string, unknown>).__typename;
    if (typeof childType !== 'string') {
      out[key] = value;
      continue;
    }
    out[key] = executeSelection(childType, value as Record<string, unknown>, selection.selection, ctx, variables, fragments);
  }
  return out;
}

function resolveField(
  typeName: string,
  field: string,
  source: Record<string, unknown>,
  args: Record<string, unknown>,
  ctx: GqlContext,
  variables: Record<string, unknown>,
): unknown {
  const store = ctx.store;
  if (typeName === 'Query') {
    if (field === 'viewer') return userObject();
    if (field === 'repository') {
      const owner = args.owner;
      const name = args.name;
      if (owner !== VIEWER_LOGIN || typeof name !== 'string') return null;
      const repo = store.getRepo(VIEWER_LOGIN, name);
      return repo === undefined ? null : repoObject(repo);
    }
    if (field === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      const dbid = Number(decoded.parts[1]);
      if (!Number.isInteger(dbid)) return null;
      const repo = findRepoById(store, dbid);
      if (repo === undefined) return null;
      if (decoded.kind === 'repo') return repoObject(repo);
      if (decoded.kind === 'issue') {
        const issue = repo.issues.get(Number(decoded.parts[2]));
        return issue === undefined ? null : issueObject(repo, issue);
      }
      if (decoded.kind === 'pr') {
        const pr = repo.pulls.get(Number(decoded.parts[2]));
        return pr === undefined ? null : prObject(repo, pr);
      }
      if (decoded.kind === 'comment') {
        const issue = repo.issues.get(Number(decoded.parts[2]));
        const comment = issue?.comments.find((candidate) => candidate.id === Number(decoded.parts[3]));
        return issue === undefined || comment === undefined ? null : commentObject(repo, issue, comment);
      }
      return null;
    }
    if (field === '__type') {
      const name = args.name;
      if (typeof name !== 'string') return null;
      const def = SCHEMA[name];
      if (def === undefined) return null;
      return typeObject(name, def);
    }
    if (field === '__schema') {
      return {
        __typename: '__Schema',
        types: Object.keys(SCHEMA).map((name) => typeObject(name, SCHEMA[name])),
        queryType: typeObject('Query', SCHEMA.Query),
        mutationType: typeObject('Mutation', SCHEMA.Mutation),
        directives: [],
      };
    }
  }
  if (typeName === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field === 'createIssue') {
      const repo = input.repositoryId !== undefined && typeof input.repositoryId === 'string'
        ? findRepoById(store, Number(decodeGlobalId(input.repositoryId)?.parts[1] ?? Number.NaN))
        : undefined;
      if (repo === undefined || typeof input.title !== 'string') {
        ctx.errors.push({ message: 'createIssue needs a repositoryId and a title' });
        return null;
      }
      const seq = store.nextSeq();
      const issue: Issue = {
        id: store.nextIssueId(),
        number: repo.nextNumber,
        title: input.title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        createdSeq: seq,
        updatedSeq: seq,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return {
        __typename: 'CreateIssuePayload',
        issue: issueObject(repo, issue),
        clientMutationId: input.clientMutationId ?? null,
      };
    }
    if (field === 'closeIssue') {
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      const repo = decoded === null ? undefined : findRepoById(store, Number(decoded.parts[1]));
      const issue = repo?.issues.get(Number(decoded?.parts[2] ?? Number.NaN));
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'closeIssue needs a known issueId' });
        return null;
      }
      issue.state = 'closed';
      issue.updatedSeq = store.nextSeq();
      return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
    }
    if (field === 'createPullRequest') {
      const repo = input.repositoryId !== undefined && typeof input.repositoryId === 'string'
        ? findRepoById(store, Number(decodeGlobalId(input.repositoryId)?.parts[1] ?? Number.NaN))
        : undefined;
      const headRef = input.headRefName;
      const baseRef = input.baseRefName;
      if (repo === undefined || typeof headRef !== 'string' || typeof baseRef !== 'string' || typeof input.title !== 'string') {
        ctx.errors.push({ message: 'createPullRequest needs a repositoryId, headRefName, baseRefName and title' });
        return null;
      }
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) {
        ctx.errors.push({ message: 'createPullRequest branches do not exist' });
        return null;
      }
      let pr = [...repo.pulls.values()].find(
        (candidate) => candidate.state === 'open' && candidate.headRef === headRef && candidate.baseRef === baseRef,
      );
      if (pr === undefined) {
        pr = {
          id: store.nextPrId(),
          number: repo.nextNumber,
          title: input.title,
          body: '',
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef,
          baseRef,
          baseSha,
          headSha,
          createdSeq: store.nextSeq(),
        };
        repo.nextNumber += 1;
        repo.pulls.set(pr.number, pr);
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: prObject(repo, pr), clientMutationId: input.clientMutationId ?? null };
    }
    if (field === 'mergePullRequest') {
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      const repo = decoded === null ? undefined : findRepoById(store, Number(decoded.parts[1]));
      const pr = repo?.pulls.get(Number(decoded?.parts[2] ?? Number.NaN));
      if (repo === undefined || pr === undefined) {
        ctx.errors.push({ message: 'mergePullRequest needs a known pullRequestId' });
        return null;
      }
      mergePullRequest(store, repo, pr);
      return { __typename: 'MergePullRequestPayload', pullRequest: prObject(repo, pr), clientMutationId: input.clientMutationId ?? null };
    }
    if (field === 'addComment') {
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      const repo = decoded === null ? undefined : findRepoById(store, Number(decoded.parts[1]));
      const issue = repo?.issues.get(Number(decoded?.parts[2] ?? Number.NaN));
      if (repo === undefined || issue === undefined || typeof input.body !== 'string') {
        ctx.errors.push({ message: 'addComment needs a known subjectId and a body' });
        return null;
      }
      const comment: Comment = { id: store.nextCommentId(), body: input.body, createdSeq: store.nextSeq() };
      issue.comments.push(comment);
      issue.updatedSeq = store.nextSeq();
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: commentObject(repo, issue, comment), cursor: encodeCursor(issue.comments.length - 1) },
        comment: commentObject(repo, issue, comment),
        clientMutationId: input.clientMutationId ?? null,
      };
    }
  }
  if (typeName === 'User') {
    if (field === 'login') return VIEWER_LOGIN;
    if (field === 'id') return '1000';
    if (field === 'name') return VIEWER_NAME;
    if (field === 'email') return VIEWER_EMAIL;
  }
  if (typeName === 'Repository') {
    const repo = source.repo as Repo;
    if (field === 'id') return repoGlobalId(repo);
    if (field === 'databaseId') return repo.id;
    if (field === 'name') return repo.name;
    if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (field === 'owner') return userObject();
    if (field === 'description') return repo.description;
    if (field === 'private') return repo.private;
    if (field === 'createdAt') return seqIso(repo.createdSeq);
    if (field === 'updatedAt') return seqIso(repo.createdSeq);
    if (field === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, targetOid: tip };
    }
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'issue') {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueObject(repo, issue);
    }
    if (field === 'issues') {
      let list = [...repo.issues.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      } else {
        list = list.filter((issue) => issue.state === 'open');
      }
      const orderBy = args.orderBy as Record<string, unknown> | undefined;
      if (orderBy !== undefined && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
        list.sort((a, b) => b.createdSeq - a.createdSeq);
      } else {
        list.sort((a, b) => a.createdSeq - b.createdSeq);
      }
      const { items, page } = paginate(list, args);
      return {
        __typename: 'IssueConnection',
        nodes: items.map((issue) => issueObject(repo, issue)),
        edges: items.map((issue, index) => ({
          __typename: 'IssueEdge',
          node: issueObject(repo, issue),
          cursor: encodeCursor(list.indexOf(issue)),
        })),
        pageInfo: pageInfoObject(page),
        totalCount: list.length,
      };
    }
    if (field === 'pullRequests') {
      const list = [...repo.pulls.values()].filter((pr) => pr.state === 'open').sort((a, b) => a.createdSeq - b.createdSeq);
      const { items, page } = paginate(list, args);
      return {
        __typename: 'PullRequestConnection',
        nodes: items.map((pr) => prObject(repo, pr)),
        edges: items.map((pr) => ({
          __typename: 'PullRequestEdge',
          node: prObject(repo, pr),
          cursor: encodeCursor(list.indexOf(pr)),
        })),
        pageInfo: pageInfoObject(page),
        totalCount: list.length,
      };
    }
    if (field === 'pullRequest') {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pr = repo.pulls.get(number);
      return pr === undefined ? null : prObject(repo, pr);
    }
  }
  if (typeName === 'Issue') {
    const repo = source.repo as Repo;
    const issue = source.issue as Issue;
    if (field === 'id') return issueGlobalId(repo, issue);
    if (field === 'number') return issue.number;
    if (field === 'title') return issue.title;
    if (field === 'body') return issue.body;
    if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field === 'labels') {
      return {
        __typename: 'LabelConnection',
        nodes: issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? '000000' })),
      };
    }
    if (field === 'author') return userObject();
    if (field === 'createdAt') return seqIso(issue.createdSeq);
    if (field === 'updatedAt') return seqIso(issue.updatedSeq);
    if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    if (field === 'repository') return repoObject(repo);
  }
  if (typeName === 'PullRequest') {
    const repo = source.repo as Repo;
    const pr = source.pr as PullRequest;
    if (field === 'id') return prGlobalId(repo, pr);
    if (field === 'number') return pr.number;
    if (field === 'title') return pr.title;
    if (field === 'body') return pr.body;
    if (field === 'state') return pr.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field === 'merged') return pr.merged;
    if (field === 'mergeable') {
      if (pr.state !== 'open') return 'UNKNOWN';
      return mergeWouldConflict(store, repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
    }
    if (field === 'headRefName') return pr.headRef;
    if (field === 'baseRefName') return pr.baseRef;
    if (field === 'headRefOid') return pr.headSha;
    if (field === 'baseRefOid') return pr.baseSha;
    if (field === 'author') return userObject();
    if (field === 'createdAt') return seqIso(pr.createdSeq);
    if (field === 'updatedAt') return seqIso(pr.createdSeq);
    if (field === 'mergedAt') return pr.mergedAt;
    if (field === 'mergeCommit') {
      return pr.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pr.mergeCommitSha };
    }
    if (field === 'repository') return repoObject(repo);
    if (field === 'files') {
      const files = diffFiles(store, repo, pr.baseSha, pr.headSha);
      const nodes = files.map((file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
      const { items, page } = paginate(nodes, args);
      return { __typename: 'PullRequestChangedFileConnection', nodes: items, pageInfo: pageInfoObject(page), totalCount: nodes.length };
    }
  }
  if (typeName === 'Ref') {
    if (field === 'name') return source.name;
    if (field === 'target') {
      const oid = source.targetOid;
      return typeof oid === 'string' ? { __typename: 'GitObject', oid } : null;
    }
  }
  if (typeName === 'GitObject') {
    if (field === 'oid') return source.oid;
  }
  if (typeName === 'Comment') {
    const repo = source.repo as Repo;
    const issue = source.issue as Issue;
    const comment = source.comment as Comment;
    if (field === 'id') return commentGlobalId(repo, issue, comment);
    if (field === 'body') return comment.body;
    if (field === 'author') return userObject();
    if (field === 'createdAt') return seqIso(comment.createdSeq);
  }
  // Plain objects (connections, payloads, page info, __Type and friends) resolve by property.
  if (Object.prototype.hasOwnProperty.call(source, field)) return source[field];
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
  return null;
}

function typeObject(name: string, def: TypeDef): Record<string, unknown> {
  return {
    __typename: '__Type',
    name,
    kind: def.kind,
    description: null,
    fields: def.fields.map((fieldName) => ({
      __typename: '__Field',
      name: fieldName,
      description: null,
      args: [],
      type: { __typename: '__Type', name: 'String', kind: 'SCALAR', description: null },
    })),
    enumValues: def.enumValues.map((value) => ({
      __typename: '__EnumValue',
      name: value,
      description: null,
      isDeprecated: false,
      deprecationReason: null,
    })),
    inputFields: null,
    interfaces: [],
    possibleTypes: null,
    ofType: null,
  };
}

// ---------------------------------------------------------------------------
// top level
// ---------------------------------------------------------------------------

export interface GraphqlResult {
  readonly status: number;
  readonly body: unknown;
}

function executeOne(
  store: Store,
  operationBody: Record<string, unknown>,
): { status: number; body: Record<string, unknown> } {
  const query = operationBody.query;
  if (typeof query !== 'string' || query === '') {
    return { status: 400, body: { errors: [{ message: 'A GraphQL query is required' }] } };
  }
  let definitions: Array<OperationNode | FragmentNode>;
  try {
    definitions = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { status: 400, body: { errors: [{ message: error instanceof Error ? error.message : 'Syntax Error' }] } };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  const operationName = operationBody.operationName;
  let operation = operations[0];
  if (typeof operationName === 'string') {
    operation = operations.find((candidate) => candidate.name === operationName) ?? operations[0];
  }
  if (operation === undefined) {
    return { status: 400, body: { errors: [{ message: 'No operation found in document' }] } };
  }
  const variables = (operationBody.variables ?? {}) as Record<string, unknown>;
  for (const definition of operation.variableDefinitions) {
    if (variables[definition.name] === undefined && definition.defaultValue !== null) {
      variables[definition.name] = unwrapValue(definition.defaultValue, variables);
    }
  }
  const ctx: GqlContext = { store, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(rootType, { __typename: rootType }, operation.selection, ctx, variables, fragments);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return { status: 200, body };
}

export function handleGraphql(store: Store, body: unknown): GraphqlResult {
  if (Array.isArray(body)) {
    const results = body.map((item) =>
      item !== null && typeof item === 'object' ? executeOne(store, item as Record<string, unknown>) : { status: 400, body: { errors: [{ message: 'Invalid operation' }] } },
    );
    return { status: 200, body: results.map((result) => result.body) };
  }
  if (body !== null && typeof body === 'object') {
    const result = executeOne(store, body as Record<string, unknown>);
    return { status: result.status, body: result.body };
  }
  return { status: 400, body: { errors: [{ message: 'A GraphQL query is required' }] } };
}
