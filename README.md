# GhostTrace

**Record once. Replay forever.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node.js >=18.18](https://img.shields.io/badge/node-%3E%3D18.18-green.svg)](https://nodejs.org)

GhostTrace is a deterministic record/replay engine for TypeScript. It captures every side effect your code produces—HTTP calls, timers, randomness, file I/O, database queries, queue operations—into a portable JSON trace. Replay that trace to get byte-identical behavior without network, disk, or infrastructure. Use the diff engine to catch behavioral regressions as contract tests.

## Quick Start

```bash
pnpm add ghosttrace
```

```typescript
import { ghost } from 'ghosttrace';

// Record a trace
const trace = await ghost.record('fetch-user', async () => {
  const res = await fetch('https://api.example.com/users/1');
  return res.json();
});

// Replay deterministically (no network)
const { output } = await ghost.replay(trace, async () => {
  const res = await fetch('https://api.example.com/users/1');
  return res.json();
});
```

## Features

**Recording** — intercept and capture:
- HTTP requests (`fetch`, `http.request`)
- Timers (`setTimeout`, `setInterval`, `Date.now`, `new Date`)
- Randomness (`Math.random`, `crypto.getRandomValues`)
- Environment variables (`process.env`)
- File system operations (`fs`, `fs/promises`)
- Database queries (adapter pattern via `wrapDb`)
- Queue operations (adapter pattern via `wrapQueue`)
- Performance marks/measures
- Arbitrary functions (`wrap`, `wrapModule`)

**Replay** — deterministic execution with recorded values as stubs. Three modes: strict, lenient, partial.

**Contract testing** — structural diff engine compares traces across runs to detect behavioral drift.

**Generation** — produce mocks, fixtures, and runnable test files from recorded traces.

**Export** — JSON, HTML (self-contained interactive viewer), Markdown, Mermaid sequence diagrams.

**CLI** — `ghost` command for init, record, replay, diff, export, inspect, and generate workflows.

**Framework integrations** — first-class helpers for Vitest, Jest, and Playwright.

**Plugin system** — extend recording/replay with custom hooks and interceptors.

**Secret redaction** — irreversible redaction runs before any trace hits disk.

## API Reference

### Core

| Function | Description |
|----------|-------------|
| `ghost.record(name, fn, options?)` | Record all side effects of `fn` into a trace |
| `ghost.replay(trace, fn, options?)` | Replay `fn` using recorded spans as deterministic stubs |
| `ghost.diff(baseline, current, options?)` | Compare two traces and return structural differences |
| `ghost.exportTrace(trace, options)` | Export a trace to JSON, HTML, Markdown, or Mermaid |
| `ghost.loadTrace(path)` | Load, validate, and migrate a trace file from disk |
| `ghost.validateTrace(input)` | Validate a trace and return machine-readable issues |

### Wrapping

| Function | Description |
|----------|-------------|
| `ghost.wrap(fn)` | Wrap a single function for recording |
| `ghost.wrapModule(mod)` | Wrap all functions on a module/object |
| `ghost.wrapDb(client, adapter)` | Wrap a database client with a typed adapter |
| `ghost.wrapQueue(client, adapter)` | Wrap a queue client with a typed adapter |

### Configuration & Tracing

| Function | Description |
|----------|-------------|
| `ghost.createTracer(config?)` | Create an isolated tracer instance with captured config |
| `ghost.defineConfig(config?)` | Validate and normalize a GhostTrace config object |

### Generation

| Function | Description |
|----------|-------------|
| `ghost.generateMocks(trace, options?)` | Generate mock functions from a recorded trace |
| `ghost.generateFixtures(trace, options?)` | Extract test fixtures from a trace |
| `ghost.generateTests(trace, options?)` | Generate runnable test files from a trace |

## CLI Usage

```bash
# Initialize a project with ghosttrace config
ghost init

# Record a trace by executing a file
ghost record ./src/handler.ts --name my-trace

# Replay a recorded trace
ghost replay ./traces/my-trace.ghosttrace.json --fn ./src/handler.ts

# Diff two traces for contract testing
ghost diff ./traces/baseline.json ./traces/current.json

# Export a trace to HTML viewer
ghost export ./traces/my-trace.json --format html --output trace.html

# Inspect trace contents
ghost inspect ./traces/my-trace.json

# Generate mocks/fixtures/tests from a trace
ghost generate ./traces/my-trace.json --type mocks --output ./src/__mocks__
ghost generate ./traces/my-trace.json --type fixtures
ghost generate ./traces/my-trace.json --type tests --framework vitest
```

## Framework Integrations

### Vitest

```typescript
import { ghostTest } from 'ghosttrace/vitest';

ghostTest('fetches user data', async () => {
  const res = await fetch('https://api.example.com/users/1');
  return res.json();
});
```

### Jest

```typescript
import { ghostTest } from 'ghosttrace/jest';

ghostTest('fetches user data', async () => {
  const res = await fetch('https://api.example.com/users/1');
  return res.json();
});
```

### Playwright

```typescript
import { ghostFixture } from 'ghosttrace/playwright';

const test = ghostFixture(base);

test('page loads with recorded API data', async ({ page, ghost }) => {
  await ghost.replay('./traces/api.json');
  await page.goto('/dashboard');
});
```

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint
```

**Requirements:** Node.js >=18.18, pnpm

## License

MIT
