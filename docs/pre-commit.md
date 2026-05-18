# Pre-Commit Hooks

This repo uses [`simple-git-hooks`](https://github.com/toplenboren/simple-git-hooks) to enforce
quality checks before commits leave your machine. Hooks are installed automatically by the
`prepare` script when you run `pnpm install`.

## What runs

### `pre-commit`

Runs `pnpm exec lint-staged` against the staged file set:

- `*.{ts,js,mjs,cjs,json,md,yml,yaml}` -> `biome check --no-errors-on-unmatched --files-ignore-unknown=true`
- `apps/inference/**/*.py` -> `ruff check --fix`

Only staged files are checked, so the hook stays fast even in a large repo. Any auto-fixes
applied by Biome or Ruff are re-staged automatically by `lint-staged`.

### `commit-msg`

Runs `pnpm exec commitlint --edit $1` against the commit message.

Rules (see `commitlint.config.js`):

- Type must be one of: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `ci`, `build`, `revert`, `style`.
- Subject must not be `UPPER-CASE`, `Start-Case`, or `PascalCase`.
- Body lines should stay under 100 chars (warning, not blocking).

## Bypassing in emergencies

```bash
git commit --no-verify -m "fix: [break-glass] revert broken migration"
```

`--no-verify` skips both the `pre-commit` and `commit-msg` hooks. This is **discouraged** and
is visible in the commit metadata. Per `docs/branch-protection.md`, any break-glass commit
must be tagged `[break-glass]` in the subject and reviewed post-hoc.

## Troubleshooting

**Hooks didn't run after cloning.** Re-install:

```bash
pnpm install        # runs `prepare` -> `simple-git-hooks`
# or, to re-register without a full install:
pnpm exec simple-git-hooks
```

**`commitlint` not found.** Ensure `pnpm install` finished. The hook calls
`pnpm exec commitlint`, which resolves the local devDependency.

**Biome / Ruff reports unexpected files.** Check `biome.json` `files.ignore` and the
`lint-staged` glob in `package.json`. The Python glob is scoped to `apps/inference/**/*.py`
so JS/TS workspaces are unaffected.

**Hook is slow.** `lint-staged` only touches staged files. If you staged a huge batch,
expect a proportional wait. Stage smaller, more focused changesets.

## Verifying the hooks work

After `pnpm install`:

1. **Pre-commit block test.** Stage a TypeScript file containing `import fs from "fs"`
   (violates Biome's `useNodejsImportProtocol` rule, which is set to `error` in `biome.json`),
   then `git commit -m "test: trigger biome"`. The commit must be rejected with a Biome diagnostic.
2. **Commit-msg block test.** `git commit --allow-empty -m "bad message"` must be rejected by
   commitlint (no conventional type prefix). Then retry with `git commit --allow-empty -m "chore: valid"`
   to confirm the happy path.
