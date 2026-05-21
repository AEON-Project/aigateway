# Recipe — Integrate `aigateway` Inside Your Agent

This recipe shows how to invoke `aigateway` from inside an agent product (Node.js, Python, or anything that can spawn a subprocess) and parse the JSON envelope reliably.

## Prerequisites

- `@aeon-ai-pay/aigateway` installed (globally for system-wide use, or as a dependency in your project).
- A working session wallet — run `aigateway wallet-init` once on the host.
- First-time funding done with `aigateway wallet-topup --amount 5` (one-time WalletConnect flow + facilitator `approve`). After this, all `sb invoke` calls are gasless and headless-friendly.

> ⚠️ `wallet-topup` opens a browser window with a WalletConnect QR code. If your agent runs headless or in containers without a display, fund the session wallet ahead of time on a workstation, then ship the `~/.aigateway/config.json` (or its `privateKey`) to the runtime host. Agents should never embed user main-wallet private keys.

## Node.js — Spawn & Parse Envelope

```js
import { spawn } from "node:child_process";

function runAigateway(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("aigateway", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.stderr.on("data", (b) => { stderr += b; });
    child.on("close", (code) => {
      let envelope;
      try {
        envelope = JSON.parse(stdout.trim().split("\n").pop());
      } catch {
        return reject(new Error(`Could not parse envelope. stderr: ${stderr}`));
      }
      resolve({ exitCode: code, envelope, stderr });
    });
  });
}

// Example: invoke an AI tool (image generation) via the x402 paid entry point
const { envelope, exitCode } = await runAigateway([
  "--quiet",
  "sb", "invoke",
  "--model", "replicate/black-forest-labs/flux-schnell",
  "--inputs", JSON.stringify({ prompt: "a cyberpunk fox", aspect_ratio: "1:1" }),
  "--app-id", "MY_AGENT_001",
]);

if (envelope.ok) {
  const { model, transaction, downloaded, balance } = envelope.data;
  console.log(`Done (${model}) tx=${transaction}`);
  for (const d of downloaded) console.log(`Saved: ${d.localPath} (${d.sizeHuman})`);
  console.log(`Charged ${balance.charged} USDT, remaining ${balance.after}`);
} else {
  // See docs/recipes/error-recovery.md for code-by-code guidance
  console.error(`Failed [${envelope.error.code}] (exit ${exitCode}):`, envelope.error.message);
}
```

### Why `--quiet`?

`--quiet` silences progress logs on stderr. The stdout envelope is one line of JSON either way — but suppressing stderr makes child-process orchestration cleaner.

### Why `.split("\n").pop()`?

The envelope is **always the last line on stdout**. Tools that wrap the binary (npx, npm, asdf, fnm) may inject preamble lines; taking the last line is robust.

## Python — Spawn & Parse Envelope

```python
import json, subprocess

def run_aigateway(args):
    result = subprocess.run(
        ["aigateway", "--quiet", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    envelope = json.loads(result.stdout.strip().splitlines()[-1])
    return result.returncode, envelope

exit_code, env = run_aigateway([
    "sb", "invoke",
    "--model", "replicate/black-forest-labs/flux-schnell",
    "--inputs", json.dumps({"prompt": "a cyberpunk fox"}),
])
if env["ok"]:
    for d in env["data"]["downloaded"]:
        print("Saved:", d["localPath"])
else:
    print(f"Failed [{env['error']['code']}] exit={exit_code}: {env['error']['message']}")
```

## Discovering Models — `sb tools`

Before calling `sb invoke`, fetch the live catalog with `sb tools` to pick a valid `model` and learn the expected `inputs` schema:

```bash
# Single model + effectiveSchema (most useful for agents)
aigateway --quiet sb tools --model replicate/black-forest-labs/flux-schnell | jq '.data'

# All models in a category
aigateway --quiet sb tools --category image | jq '.data.categories[0].models[].id'

# Cheapest tier across all categories
aigateway --quiet sb tools --tier price
```

The catalog is fetched live from the server each call (no local cache). Each model carries `price`, `priceUnit`, `tier`, and an optional `inputsOverride`; each category carries `defaultInputsSchema`.

## Probing Without Cost

`sb invoke` performs client-side validation of `--model` and `--inputs` against the live catalog **before** any x402 round-trip. Invalid model ids and missing/invalid fields return `INVALID_MODEL_ID` / `MISSING_INPUTS` / `INVALID_INPUTS` locally, with zero USDT spent.

For wallet-only smoke tests, `aigateway wallet-balance` is read-only and never signs anything.

## Exit Code Strategy

Treat exit codes as a fast filter, then branch on `error.code` for nuance:

```js
switch (exitCode) {
  case 0: /* success */ break;
  case 1: /* user / config — surface to caller for correction */ break;
  case 2: /* timeout — safe to retry the same command */ break;
  case 3: /* network / service — exponential backoff retry */ break;
  case 4: /* internal — log + fail loud */ break;
}
```

See [exit-codes.md](../exit-codes.md) for the full mapping.
