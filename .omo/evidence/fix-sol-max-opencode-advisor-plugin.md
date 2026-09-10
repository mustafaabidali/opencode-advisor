# Fix — default GPT-5.6 Sol advisor level is max

Date: 2026-09-10

## TDD — default model

### RED

The config expectation was changed before the production default.

Command: `bun test test/config.test.ts`

```text
bun test v1.4.0 (34cbb9a40)

error: expect(received).toEqual(expected)

Expected: default_model "amazon-bedrock/openai.gpt-5.6-sol:max"
Received: default_model "amazon-bedrock/openai.gpt-5.6-sol:xhigh"

16 pass
1 fail
32 expect() calls
Ran 17 tests across 1 file. [8.00ms]
```

### GREEN

`DEFAULTS.default_model` was then changed to `amazon-bedrock/openai.gpt-5.6-sol:max`.

Command: `bun test test/config.test.ts`

```text
bun test v1.4.0 (34cbb9a40)

17 pass
0 fail
32 expect() calls
Ran 17 tests across 1 file. [7.00ms]
```

## Replacement receipt

The generated bundle was rebuilt with `bun run build` so the repository-wide scan also covers `dist/advisor.js`.

Command: `grep -rn "sol:xhigh" --exclude-dir=.omo --exclude-dir=node_modules .`

```text
grep exit status: 1
```

No non-historical `sol:xhigh` occurrences remain outside `.omo` and `node_modules`; Anthropic Fable `:xhigh` references remain unchanged.
