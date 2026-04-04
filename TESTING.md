# Testing

Uni-CLI uses [Vitest](https://vitest.dev/) with two test projects.

## Test Projects

| Project | Directory | What it tests | Requires |
|---------|-----------|---------------|----------|
| `unit` | `tests/unit/` | Core logic — registry, formatter, loader, types | Nothing |
| `adapter` | `tests/adapter/` | Adapter integration — real API calls | Network (some need browser) |

## Running Tests

```bash
# Unit tests only (fast, no network)
npm run test

# Adapter integration tests (may need network/browser)
npm run test:adapter

# All tests
npm run test:all

# Full verification (format + typecheck + lint + test + build)
npm run verify
```

## Writing Tests

### Unit Tests

Place in `tests/unit/<module>.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { format } from '../../src/output/formatter.js';

describe('formatter', () => {
  it('formats empty data as empty array in json mode', () => {
    expect(format([], undefined, 'json')).toBe('[]');
  });
});
```

### Adapter Tests

Place in `tests/adapter/<site>.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('hackernews adapter', () => {
  it('top.yaml loads and has correct metadata', () => {
    // Test adapter loading, not API calls
  });

  it('fetches top stories from live API', async () => {
    // Integration test — requires network
  });
});
```

## Conventions

- Unit tests must pass without network access
- Adapter tests that call real APIs are tagged in the `adapter` project (longer timeout)
- Every new adapter should have at least one loading test
- Use `vitest --watch` during development
