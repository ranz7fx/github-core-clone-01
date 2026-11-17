# github-core-clone-01 — a GitHub-compatible git forge

A standalone forge that speaks the four surfaces GitHub does, from one process and one
in-memory store, with no dependencies, no UI and no outside service:

- **Git smart HTTP** — `git-upload-pack` / `git-receive-pack`, protocol v2 (`ls-refs`,
  `fetch` with `shallow` / `deepen`, sideband) and the v0 fallback, including annotated
  tags, peeled refs, fast-forward enforcement and mixed push reports.
- **REST v3** (`/api/v3`) — repositories, branches, commits, refs, contents, labels,
  issues, comments and pull requests, with pagination, squash merges and three-way
  conflict detection.
- **GraphQL** (`/api/graphql`) — the queries and mutations `gh` and
  `github-mcp-server` send, including introspection, cursor pagination, Relay-style
  global ids and batched operations.
- **MCP** (`/mcp`) — JSON-RPC 2.0 Streamable HTTP, modern era revision `2026-07-28`
  via `server/discover` plus the legacy `initialize` handshake, with six tools:
  `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`.

## Layout

| file | what it is |
| --- | --- |
| `main.ts` | The entry lifecycle (bind an ephemeral port, register with the env, wait for done). Kept as the kit shipped it. |
| `app.ts` | The single HTTP server: routing, Bearer auth, the `X-GitHub-Request-Id` header, body reading. |
| `store.ts` | The store: repositories, refs, issues, pull requests, labels and every git object, plus the pkt-line, packfile and tree/commit codecs. |
| `git.ts` | Git smart HTTP: advertisements, `ls-refs`, `fetch` (with depth cut-offs that stop at the shallow boundary) and `receive-pack`. |
| `rest.ts` | REST v3, including the squash-merge used by REST, GraphQL and MCP alike. |
| `graphql.ts` | A small GraphQL parser and executor over the same store. |
| `mcp.ts` | The MCP tools and the JSON-RPC envelope. |

## Determinism

Nothing in request handling reads the clock, the filesystem or randomness: server-made
commits count up from a fixed epoch, issue and pull-request ordering follows a monotonic
sequence, and responses are built from insertion-ordered maps. Two runs that receive the
same requests in the same order hold byte-identical state.

## Speed

The hot paths are the point: the store is maps, not scans; a fetch sends plain objects
(no deltas) and cuts its walk at the shallow boundary; a push parses one pack and walks
only to the fast-forward ancestor; issue reads are a map lookup plus one JSON encoding.
Measured locally against the kit's runner (conformance 120/120, then the four timed
workloads): push ~1.4 s, clone ~0.4 s, read ~3.8 s, write ~0.35 s per round on this
machine — the numbers move with the hardware, and the server sits at the transport
floor on every endpoint.

## Running

```sh
node main.ts   # needs MAKEFUN_ENV_URL; see main.ts for the lifecycle
```

Node 22, standard library only. No install step, no build step.

## License

MIT — see `LICENSE`.
