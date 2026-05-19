# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.5] — 2026-05-19

### Changed
- **Removed all Chinese-language content from source files**. All comments,
  docstrings, log messages, and SKILL.md guidance are now English-only.
  `normalizeWalletError` no longer matches CJK error strings from localised
  wallet apps; those fall through to the generic `WALLET_ERROR` code.
- SKILL.md's "Wording Discipline" section is now language-neutral: instead
  of listing Chinese phrasings, it instructs translators to keep the "wallet
  top-up" verb / noun lexically distinct from the "card face value" verb /
  noun in every target language.

### Removed
- `test/create-logic.test.mjs` — stale unit tests inherited from `aicard`
  that referenced internal functions removed during the merge (e.g.
  `inlineWalletConnectTopup`, now replaced by `funding.mjs::fundSessionKey`).
  The file was never published to npm (`test/` is not in `files`).

## [0.1.4] — 2026-05-19

### Added
- **`create-card` envelope now carries a `balance` block** (`initial`, `before`,
  `after`, `charged`, `topup`) parallel to `create-image`, so the agent can
  render the same money-flow narrative for card issuance.

### Changed
- **Both paid commands adopt an emoji-aligned card-style success template**
  with explicit balance transitions (`{initial} → {before}` for top-up;
  `{before} → {after}` for charge) on dedicated rows. The `💸 Top-up` row is
  conditional — only rendered when `balance.topup` is non-null.
  - `create-card`: header `✅ Card Issued`, rows for Order / Card / State /
    Face value / Usage / Tx / (optional) Top-up / Charged.
  - `create-image`: header `✅ Generated`, second row `🧩 Powered by Skillboss`,
    rows for Path / Format / Dimensions / Size / Tx / (optional) Top-up /
    Charged.
- SKILL.md Copy Constraints table extended with all new template rows so
  agents must reproduce the glyphs (`→`, `−`, `+`) exactly.

## [0.1.3] — 2026-05-19

### Fixed
- **`wallet-init` no longer requires `mainWallet` field in config to consider the wallet "funded".**
  Previously the decision tree was `created || !config.mainWallet ⇒ needsTopup=true`, which meant
  a session wallet that had USDT and was already approved on-chain — but whose local config had
  never recorded a `mainWallet` (e.g. funded by an external CEX transfer, or copied from another
  machine without that field) — would still be flagged as needing a top-up, sending the agent
  through a redundant `wallet-topup` flow. The decision now relies only on on-chain state
  (USDT balance ≥ `LOW_BALANCE_THRESHOLD` and `allowance > 0`). `mainWallet` is treated purely
  as a withdraw-default and has no effect on `needsTopup`.
- `topupReason` enum updated: `no_prior_funding` removed; new values are `first_time` (replaces
  the created branch), `low_balance`, `no_approve`, and `chain_check_failed`.

## [0.1.2] — 2026-05-19

### Changed
- **SKILL.md wording discipline**: the `wallet-topup` and `create-card` prompts
  now enforce strict lexical separation. Step 2 (`wallet-topup`) says "load USDT
  **into your session wallet**"; Step 3a (`create-card`) says "card
  **face value**" / "issue a card with how much". When translating to any
  non-English language, the verb / noun for each concept must remain distinct
  so users cannot conflate them.
- New "Wording Discipline" section in SKILL.md `## Copy Constraints` to lock
  this in.

## [0.1.1] — 2026-05-19

### Changed
- **`wallet-init` now reports full funding status**, not just local-key readiness. Envelope `data` adds:
  `usdt`, `bnb`, `allowance`, `needsTopup`, `topupReason` (`no_prior_funding` / `low_balance` / `no_approve`),
  `minTopup`, `presets`, `chainCheck`. Agents can decide the next step (`wallet-topup` vs. go straight to a paid
  call) from this single envelope without a separate `wallet-balance` call.
- **SKILL.md workflow re-ordered** so agents prompt the user for a top-up amount **before** invoking the first
  paid command, eliminating the previous "try-create-card → fail with `TOPUP_REQUIRED` → ask amount" UX bug.
- SKILL.md adds an "If `aigateway` is not found (exit 127)" fallback that instructs the agent to run
  `npm install -g @aeon-ai-pay/aigateway` once and retry.

## [0.1.0] — 2026-05-18

Initial release of **AEON AI Gateway**, merging the prior `@aeon-ai-pay/aicard` and `@aeon-ai-pay/agentos` projects into a single unified CLI and agent skill.

### Added

- Unified CLI surface (`aigateway`) supporting both **virtual card** and **AI image** capabilities backed by a shared session-key wallet.
- Commands:
  - `wallet-init` — pure-local session-wallet check / auto-create (no QR, no on-chain).
  - `wallet-topup` — WalletConnect USDT top-up (≥5 USDT, presets 5/10/20/50) + one-time facilitator approve.
  - `wallet-balance` — query session-key USDT / BNB balance + saved main wallet.
  - `wallet-gas` — main wallet → session BNB transfer (for withdraw gas).
  - `wallet-withdraw` — on-chain reclaim of USDT + BNB back to main wallet.
  - `create-card` — x402-paid virtual debit card issuance ($0.6 ~ $800), `--poll` and `--dry-run` supported.
  - `create-image` — x402-paid Skill Boss image generation, with prompt / aspect-ratio / format / model controls.
  - `create-card-status` — query the status of a `create-card` order.
  - `clean` — uninstall skill and clear npm/npx caches.
- Stable JSON envelope on stdout for every command: `{ ok, command, version, data | error }`.
- Stable `error.code` taxonomy (24 codes) mapped to four exit-code categories: `1` user / `2` timeout / `3` service / `4` internal.
- `--app-id <id>` on every command (default `TEST000001`) for merchant attribution.
- `--legacy-output` flag for consumers still parsing the pre-envelope JSON shape.
- `--verbose` / `--quiet` global logging controls.
- `--dry-run` on `create-card` for preflight validation without signing or transacting.
- Foreground auto-upgrade via `src/update-check.mjs`: every CLI invocation checks `npm view` and silently background-installs the new version + re-syncs the skill via `postinstall`.
- Multi-IDE adoption templates under `templates/` for Cursor, Windsurf, Cline / Roo Code, and Codex.
- Agent skill at `skills/aigateway/SKILL.md` with end-user workflow, copy-exact templates, and decision routing.
- Developer documentation:
  - `docs/output-schema.md` — full envelope schema per command.
  - `docs/exit-codes.md` — exit code + `error.code` reference.
  - `docs/env-vars.md` — environment variable reference.
  - `docs/troubleshooting.md` — common issues & remedies.
  - `docs/release-process.md` — release workflow + version lock-step rules.
  - `docs/ide-setup.md` — manual IDE adoption guide.
  - `docs/recipes/integrate-in-agent.md` — generic spawn-and-parse Node.js / Python wrappers.
  - `docs/recipes/error-recovery.md` — recovery actions per error code.
  - `docs/recipes/cron-issue-cards.md` — scheduled paid calls.
  - `docs/recipes/merchant-integration.md` — merchant integration patterns (user-managed vs. custodial wallet).

### Removed (compared to upstream `aicard` / `agentos`)

- `setup --check` (folded into the new `wallet-init` command).
- `setup --service-url` / per-command `--service-url` flag (use `AIGATEWAY_SERVICE_URL` env var instead).
- `aicard topup` (renamed to `wallet-topup`).
- `agentos prepare` (folded into `wallet-topup`).
- `aicard create` (renamed to `create-card`).
- `aicard wallet` / `aicard gas` / `aicard withdraw` (renamed to `wallet-balance` / `wallet-gas` / `wallet-withdraw`).
- `aicard status` (renamed to `create-card-status` to match `create-card-*` naming).
- `INVALID_USAGE` error code (no longer needed after `setup` simplification).

[Unreleased]: https://github.com/AEON-Project/aigateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AEON-Project/aigateway/releases/tag/v0.1.0
