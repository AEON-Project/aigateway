# Release Process

## Versioning

We follow [SemVer](https://semver.org/):

- **Patch** (`0.1.0` → `0.1.1`) — bug fixes, doc edits, no breaking change.
- **Minor** (`0.1.0` → `0.2.0`) — new commands, new flags, new error codes. Existing envelope schema preserved.
- **Major** (`0.1.0` → `1.0.0`) — breaking envelope schema, renamed command, removed flag.

## Two version numbers, kept in lock-step

| File | Field |
| --- | --- |
| `package.json` | `version` |
| `skills/aigateway/SKILL.md` | frontmatter `metadata.version` |

**Both must move together** every release. The npm version drives `update-check.mjs`; the skill version drives `npx skills add` re-copy to IDE folders.

## Release checklist

1. Ensure `main` is clean and CI-green.

2. Bump both versions to the same value:

   ```bash
   # 1. package.json
   npm version patch --no-git-tag-version    # or `minor`, `major`, or explicit "0.1.1"

   # 2. SKILL.md frontmatter
   sed -i.bak -E 's/^(  version: ").*"/\1'"$(jq -r .version package.json)"'"/' skills/aigateway/SKILL.md
   rm skills/aigateway/SKILL.md.bak
   ```

3. Update `CHANGELOG.md` with notable changes.

4. Commit and tag:

   ```bash
   VERSION=$(jq -r .version package.json)
   git add package.json skills/aigateway/SKILL.md CHANGELOG.md
   git commit -m "release $VERSION"
   git tag "v$VERSION"
   git push && git push --tags
   ```

5. Publish:

   ```bash
   npm publish --access public
   ```

6. Verify:

   ```bash
   npm view @aeon-ai-pay/aigateway version       # should show the new version
   aigateway --version                             # local still old until next call triggers auto-upgrade
   ```

## What happens for users after publish

`src/update-check.mjs` runs on every CLI invocation. Within a few seconds of the next `aigateway <cmd>` call by any user, they will:

1. See `[update] @aeon-ai-pay/aigateway 0.1.0 → 0.1.1, upgrading in background...` on stderr.
2. The current command still completes normally.
3. A detached child process runs `npm install -g @aeon-ai-pay/aigateway@0.1.1` + `node scripts/postinstall.mjs`, which calls `npx skills add ... -g -y --copy`.
4. The new `SKILL.md` is re-installed into every detected IDE skill folder (Cursor / Claude Code / Codex / Windsurf / Cline / …).
5. Next invocation uses the new CLI and the new agent reads the new skill.

Upgrade results land in `~/.aigateway/update.log`.

## Rolling back

`npm` releases are immutable. If you cut a bad release:

1. Publish a **new** patch with the fix (`0.1.2`), don't try to overwrite.
2. If users are blocked, you can `npm deprecate @aeon-ai-pay/aigateway@0.1.1 "Use 0.1.2 instead"` so new installs skip it.

## Pre-release (optional)

For staging / beta:

```bash
npm version 0.2.0-beta.1 --no-git-tag-version
# bump SKILL.md version manually to 0.2.0-beta.1
npm publish --tag beta --access public

# Users opt-in:
npm install -g @aeon-ai-pay/aigateway@beta
```

`update-check.mjs` reads the `latest` tag by default, so beta users won't be silently bumped to `latest` until you mark a stable release.

## When not to ship

- **Breaking envelope schema change** without a major bump. Downstream agents and merchants parse the envelope; renaming `data.orderNo` to `data.id` will break them.
- **Renaming a command** without a major bump (and at least one release of deprecation warnings).
- **`--service-url` re-added or removed** — keep config / env-var contract stable.
