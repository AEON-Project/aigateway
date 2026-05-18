# Environment Variables

All environment variables that affect the `aigateway` CLI. Resolution priority for any setting: **CLI flag > env var > `~/.aigateway/config.json` > built-in default**.

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `AIGATEWAY_SERVICE_URL` | All paid commands (`create-card`, `create-image`, `create-card-status`) | `https://ai-api.aeon.xyz` | Override the x402 service base URL. Useful for staging / local backends. |
| `EVM_PRIVATE_KEY` | All commands needing a session key | (read from config file) | Override the saved session key. Required when running in custodial / containerised mode where you don't want a config file on disk. **Treat as a secret.** |
| `AICARD_LEGACY_NOOP` | — | — | Reserved. Not currently used. |

## Config file

`~/.aigateway/config.json` (mode `0o600`). Persisted fields:

```json
{
  "serviceUrl": "https://ai-api.aeon.xyz",
  "privateKey": "0x...",
  "address": "0x...",
  "mode": "private-key",
  "mainWallet": "0x..."
}
```

- `serviceUrl` — written when overridden (rare).
- `privateKey` / `address` / `mode` — written by `wallet-init` when auto-generating a session key.
- `mainWallet` — auto-recorded after a successful `wallet-topup` so `wallet-withdraw` can default to that address.

## CLI flag priority example

```bash
# All four set, --service-url wins
AIGATEWAY_SERVICE_URL=https://env.example.com \
  aigateway create-card --amount 5 --service-url=...   # (no such flag now — env wins)

# Only env set
AIGATEWAY_SERVICE_URL=https://staging.example.com \
  aigateway create-card --amount 5

# Nothing set → built-in default https://ai-api.aeon.xyz
aigateway create-card --amount 5
```

The `--service-url` CLI flag has been removed in 0.1.0+ — use the env var or edit the config file directly.

## Production hardening

| Goal | How |
| --- | --- |
| Don't write key to disk | Set `EVM_PRIVATE_KEY` from a Vault / KMS fetch at process boot; never call `wallet-init` |
| Pin to staging in CI | `export AIGATEWAY_SERVICE_URL=https://staging-x402.aeon.xyz` in your CI environment |
| Confidential logging | Combine with `--quiet` to suppress stderr; pipe stdout to your structured logger |
| Multi-tenant | Set `EVM_PRIVATE_KEY` per request via spawn `env` option (don't leak across tenants) |

## Quick reference

```bash
# Default production
aigateway wallet-init

# Custodial server (key from Vault, no config file)
EVM_PRIVATE_KEY=$(vault kv get -field=key merchants/acme-prod) \
  aigateway create-card --amount 5 --app-id MERCHANT_ACME_001 --poll

# Staging
AIGATEWAY_SERVICE_URL=https://staging-x402.aeon.xyz \
  aigateway create-card --amount 5 --app-id YOUR_TEST_APPID --poll

# Both
AIGATEWAY_SERVICE_URL=https://staging-x402.aeon.xyz \
  EVM_PRIVATE_KEY=$STAGING_KEY \
  aigateway wallet-balance
```
