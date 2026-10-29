# Development

MAR is strict ESM TypeScript (`NodeNext`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) with **zero runtime dependencies**. Node.js 20 or newer is required.

```bash
npm ci
npm test            # builds, then runs every test file in dist/test with node:test
npm run bench       # builds, then runs the deterministic benchmarks
npm run check       # type check only
node dist/cli.js --help
```

`dist/` is committed so that GitHub tarball installs need no toolchain. CI fails when `git diff --exit-code -- dist` is not clean, so rebuild before committing.

## Tests

All tests are deterministic and offline. They use scripted providers and local HTTP fixtures, never real model APIs.

| File | Covers |
|---|---|
| `security.test.ts` | policy rules, approval modes, audit, redaction (including split stream chunks), environment scrubbing, symlink escapes, stale-write ledger, process-tree kill, output limits, sandbox fail-closed, real bubblewrap confinement (skipped when `bwrap` is unavailable) |
| `context.test.ts` | token estimation, compaction strategies, instruction preservation |
| `agent.test.ts` | tool loop, cancellation, retries, fallbacks, overflow recovery, failure memory, verification |
| `session.test.ts` | journal and snapshot persistence, resume, legacy migration, crash repair without replay, locking |
| `concurrency.test.ts` | task manager lifecycle, dependencies, limits, shared-mode conflicts, worktree integration and conflicts, no recursive delegation |
| `tools.test.ts` | patching, edits, commands, background processes, search, Git tools, notes, memory, check detection |
| `providers*.test.ts` | request and response translation and streaming (SSE and NDJSON) for all four adapters, error taxonomy, backoff |
| `cli.test.ts` | the compiled CLI end to end: sessions, migrate, approval without a TTY, read-only, sandbox fail-closed, redaction, Ctrl+C |

`src/test/helpers.ts` provides temporary directories, a scripted provider plugin (`setScript`), configuration builders, and Git fixtures.

## Benchmarks

`scripts/bench.mjs` drives the real runtime through ten scripted scenarios: a single-file fix, a multi-file patch, a failing-then-passing check, a 250-turn compaction run, transient errors, auth fallback, parallel delegation, a worktree conflict, crash recovery, and cancellation latency. It measures MAR's behavior and overhead, **not model quality**. Pass `--json FILE` to save the results.

## Conventions

- Provider translations stay in `src/providers`. New behavior goes through the normalized `ModelAdapter` interface.
- Every new tool declares a `permission` and, if it runs commands, a `command()` extractor.
- Never report success without evidence: tool results set `ok` from real outcomes (exit codes, written bytes), and verification derives from them.
- Errors are typed (`MarError` subclasses) and surfaced. Never swallow them silently.
