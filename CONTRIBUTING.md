# Contributing

Contributions that improve format fidelity, portability, accessibility, performance, or the reading workflow are welcome.

## Development Setup

1. Install Node.js 22.13 or newer.
2. Run `npm ci`.
3. Run `npx playwright install chromium` if you will run browser tests.
4. Start the application with `npm run dev`.

Before submitting a change, run:

```sh
npm run check
npm audit
```

## Provider Parser Changes

Provider history formats are external and can change without notice. Parser changes should:

- Prefer official documentation or schemas over assumptions from one transcript.
- Preserve unknown records and raw source JSON.
- Avoid modifying, moving, or deleting provider files.
- Keep malformed lines isolated so valid records remain readable.
- Add a minimal synthetic fixture and focused assertions.
- Remove personal paths, prompts, tokens, API keys, source code, and identifiers from fixtures.

Do not commit real session histories. Even apparently harmless traces can contain local paths, repository content, environment values, or credentials in tool output.

## Pull Requests

Keep changes scoped and explain user-visible behavior. Include screenshots for deliberate UI changes and tests for parser, indexing, export, or security changes. Generated build output, browser traces, local databases, logs, and exploratory repositories must not be committed.
