/**
 * OKX Agentic Wallet integration: wraps the `onchainos` CLI as a remote EVM signer.
 *
 * API keys (okxApiKey / okxSecretKey / okxPassphrase) stored in ~/.aigateway/config.json
 * are automatically injected as env vars when spawning onchainos, so the caller never has
 * to set OKX_* env vars manually after running `aigateway wallet-mode okx`.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from './config.mjs';

const execFileAsync = promisify(execFile);

function buildEnv() {
  const config = loadConfig();
  const env = { ...process.env };
  if (config.okxApiKey    && !env.OKX_API_KEY)    env.OKX_API_KEY    = config.okxApiKey;
  if (config.okxSecretKey && !env.OKX_SECRET_KEY) env.OKX_SECRET_KEY = config.okxSecretKey;
  if (config.okxPassphrase && !env.OKX_PASSPHRASE) env.OKX_PASSPHRASE = config.okxPassphrase;
  return env;
}

async function run(args, { timeout = 30_000 } = {}) {
  try {
    const { stdout } = await execFileAsync('onchainos', args, {
      env: buildEnv(),
      timeout,
    });
    const text = stdout.trim();
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        'onchainos CLI not found. Run: aigateway wallet-mode okx  to install automatically.',
      );
    }
    const msg = ((err.stderr || err.stdout || '').trim()) || err.message;
    throw new Error(msg);
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export async function checkOnchainos() {
  try {
    await execFileAsync('onchainos', ['--version'], {
      env: buildEnv(),
      timeout: 5_000,
    });
    return true;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

export async function installOnchainos() {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const [cmd, ...args] = isWin
      ? ['powershell', '-Command', 'irm https://raw.githubusercontent.com/okx/onchainos-skills/main/install.ps1 | iex']
      : ['sh', '-c', 'curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh'];
    const proc = spawn(cmd, args, { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`onchainos installation failed (exit code ${code})`));
    });
    proc.on('error', (err) => reject(new Error(`Failed to run installer: ${err.message}`)));
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function loginWithEmail(email) {
  return run(['wallet', 'login', email]);
}

export async function verifyOtp(otp) {
  return run(['wallet', 'verify', otp]);
}

export async function walletStatus() {
  return run(['wallet', 'status']);
}

// Logout + clear all stored onchainos credentials (~/.onchainos/session.json etc).
// Needed when the user switches to a different email/account: an alive session
// otherwise short-circuits re-auth and keeps returning the old wallet address.
export async function logout() {
  return run(['wallet', 'logout']);
}

// ─── Address discovery ────────────────────────────────────────────────────────

export async function getOkxEvmAddress() {
  const result = await run(['wallet', 'balance']);
  const isEvm = (v) => typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v);

  // Preferred: explicit top-level field.
  if (isEvm(result.evmAddress)) return result.evmAddress;

  // The account's EVM address is the same on every EVM chain (HD EOA). Read it
  // from the wallet `address` key of any tokenAsset — never from `tokenAddress`
  // (a token *contract*) or `payTo` etc., so field ordering can't fool us.
  const assets = result.data?.details?.flatMap((d) => d?.tokenAssets ?? []) ?? [];
  for (const a of assets) {
    if (isEvm(a?.address)) return a.address;
  }

  // Fallback: match the `"address"` key specifically (not any 0x string).
  const match = JSON.stringify(result).match(/"address"\s*:\s*"(0x[a-fA-F0-9]{40})"/);
  if (!match) {
    throw new Error(
      'Cannot read OKX wallet EVM address. ' +
      'Make sure you are logged in: onchainos wallet login <email>',
    );
  }
  return match[1];
}

// ─── Signing (used by createOkxX402Api in x402.mjs) ──────────────────────────

// EIP-712 sign: returns hex signature string (0x...)
export async function signEIP712WithOkx(address, typedData) {
  // viem omits EIP712Domain from types; onchainos requires the full standard EIP-712 JSON
  // (https://eips.ethereum.org/EIPS/eip-712) including EIP712Domain in types.
  const domainFields = [];
  const d = typedData.domain || {};
  if (d.name         !== undefined) domainFields.push({ name: 'name',              type: 'string'  });
  if (d.version      !== undefined) domainFields.push({ name: 'version',           type: 'string'  });
  if (d.chainId      !== undefined) domainFields.push({ name: 'chainId',           type: 'uint256' });
  if (d.verifyingContract !== undefined) domainFields.push({ name: 'verifyingContract', type: 'address' });
  if (d.salt         !== undefined) domainFields.push({ name: 'salt',              type: 'bytes32' });

  const fullTypedData = {
    types: { EIP712Domain: domainFields, ...typedData.types },
    primaryType: typedData.primaryType,
    domain: typedData.domain,
    message: typedData.message,
  };

  // BigInt values must be converted to decimal strings for JSON serialization
  const messageJson = JSON.stringify(fullTypedData, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v
  );
  const result = await run([
    'wallet', 'sign-message',
    '--chain', 'xlayer',
    '--type',  'eip712',
    '--message', messageJson,
    '--from',  address,
    '--force',
  ], { timeout: 60_000 });
  const signature = result.signature || result.data?.signature;
  if (!signature) {
    throw new Error(`OKX EIP-712 signing failed: ${JSON.stringify(result)}`);
  }
  return signature;
}

// Contract call (approve etc.): returns txHash string
export async function contractCallWithOkx(address, { to, data }) {
  const result = await run([
    'wallet', 'contract-call',
    '--to',         to,
    '--chain',      'xlayer',
    '--input-data', data,
    '--from',       address,
    '--force',
  ], { timeout: 120_000 });
  // onchainos returns { ok: true, data: { txHash, orderId } }
  const txHash = result.txHash || result.data?.txHash;
  if (!txHash) {
    throw new Error(`OKX contract-call failed: ${JSON.stringify(result)}`);
  }
  return txHash;
}

// ─── Approve facilitator (used by wallet-topup in OKX mode) ─────────────────

export async function approveFacilitatorWithOkx(address) {
  const { encodeFunctionData, maxUint256 } = await import('viem');
  const { USDT_BSC, FACILITATOR_ADDRESS } = await import('./constants.mjs');
  const data = encodeFunctionData({
    abi: [{
      name: 'approve', type: 'function', stateMutability: 'nonpayable',
      inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
      outputs: [{ name: '', type: 'bool' }],
    }],
    functionName: 'approve',
    args: [FACILITATOR_ADDRESS, maxUint256],
  });
  return contractCallWithOkx(address, { to: USDT_BSC, data });
}

// ─── Transfer (used by wallet-withdraw) ──────────────────────────────────────

export async function walletSendWithOkx({ recipient, amount, tokenAddress, chain = 'xlayer' }) {
  const args = [
    'wallet', 'send',
    '--readable-amount', String(amount),
    '--recipient',      recipient,
    '--chain',          chain,
    '--force',
  ];
  if (tokenAddress) args.push('--contract-token', tokenAddress);
  const result = await run(args, { timeout: 120_000 });
  const txHash = result.txHash || result.data?.txHash;
  if (!txHash) {
    throw new Error(`OKX wallet send failed: ${JSON.stringify(result)}`);
  }
  return txHash;
}
