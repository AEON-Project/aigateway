/**
 * wallet-mode: switch between local session key and OKX Agentic Wallet.
 *
 * `wallet-mode okx`  — interactive wizard: installs onchainos CLI, guides through
 *                      email-OTP or API-Key login, saves mode + EVM address to config.
 * `wallet-mode session-key` — revert to the default local session-key mode.
 */
import { createInterface } from 'node:readline/promises';
import { loadConfig, saveConfig } from '../config.mjs';
import {
  checkOnchainos,
  installOnchainos,
  loginWithEmail,
  verifyOtp,
  walletStatus,
  getOkxEvmAddress,
} from '../okx-wallet.mjs';
import { emitOk, emitErr, logInfo } from '../output.mjs';

function isTTY() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export async function setWalletMode(mode, opts = {}) {
  if (mode !== 'okx' && mode !== 'session-key') {
    emitErr('wallet-mode', 'INVALID_MODE', {
      message: `Unknown mode: "${mode}". Supported: okx | session-key`,
    });
    return;
  }

  // ── session-key: just flip the flag ───────────────────────────────────────
  if (mode === 'session-key') {
    const config = loadConfig();
    config.mode = 'session-key';
    saveConfig(config);
    logInfo('Switched to session-key mode.');
    emitOk('wallet-mode', { mode: 'session-key' }, { mode: 'session-key' });
    return;
  }

  // ── okx: full setup wizard ────────────────────────────────────────────────

  // Non-TTY fast path: API keys already in env or config — skip interactive steps.
  if (!isTTY()) {
    const config = loadConfig();
    const hasApiKey = process.env.OKX_API_KEY || config.okxApiKey;
    if (!hasApiKey) {
      emitErr('wallet-mode', 'TTY_REQUIRED', {
        message:
          'Interactive setup requires a TTY. ' +
          'Set OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE env vars first, ' +
          'then run: aigateway wallet-mode okx',
      });
      return;
    }
    await _saveOkxMode('apikey');
    return;
  }

  // Step 1 — ensure onchainos is installed
  logInfo('');
  logInfo('Step 1/3 — Checking onchainos CLI...');
  let available = await checkOnchainos();
  if (!available) {
    logInfo('onchainos not found — installing now...');
    try {
      await installOnchainos();
      available = await checkOnchainos();
      if (!available) throw new Error('Installation succeeded but onchainos is still not on PATH. Check your shell PATH.');
      logInfo('✓ onchainos installed successfully.');
    } catch (err) {
      emitErr('wallet-mode', 'OKX_CLI_INSTALL_FAILED', {
        message: err.message,
        hint: 'Manual install: curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh',
      });
      return;
    }
  } else {
    logInfo('✓ onchainos CLI is available.');
  }

  // Step 2 — choose auth method
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    logInfo('');
    logInfo('Step 2/3 — Choose login method:');
    logInfo('  [1] Email + OTP  (recommended)');
    logInfo('  [2] API Key  (OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE)');
    logInfo('');

    let authMethod = null;
    while (!authMethod) {
      const ans = (await rl.question('Enter choice [1-2]: ')).trim();
      if (ans === '1') authMethod = 'email';
      else if (ans === '2') authMethod = 'apikey';
      else logInfo('Please enter 1 or 2.');
    }

    if (authMethod === 'email') {
      const email = (await rl.question('Enter your OKX account email: ')).trim();
      if (!email) { emitErr('wallet-mode', 'INVALID_INPUT', { message: 'Email is required.' }); return; }

      logInfo(`Sending OTP to ${email}...`);
      try {
        await loginWithEmail(email);
        logInfo(`✓ OTP sent to ${email}`);
      } catch (err) {
        emitErr('wallet-mode', 'OKX_LOGIN_FAILED', { message: err.message }); return;
      }

      const otp = (await rl.question(`Enter the OTP code sent to ${email}: `)).trim();
      if (!otp) { emitErr('wallet-mode', 'INVALID_INPUT', { message: 'OTP is required.' }); return; }

      try {
        await verifyOtp(otp);
        logInfo('✓ Login successful.');
      } catch (err) {
        emitErr('wallet-mode', 'OKX_LOGIN_FAILED', { message: `OTP verification failed: ${err.message}` }); return;
      }
    } else {
      // API Key flow
      logInfo('');
      logInfo('Keys are stored in ~/.aigateway/config.json (file permissions: 0600).');
      logInfo('');
      const apiKey    = (await rl.question('Enter OKX_API_KEY:    ')).trim();
      const secretKey = (await rl.question('Enter OKX_SECRET_KEY: ')).trim();
      const passphrase = (await rl.question('Enter OKX_PASSPHRASE: ')).trim();

      if (!apiKey || !secretKey || !passphrase) {
        emitErr('wallet-mode', 'INVALID_INPUT', { message: 'All three API Key fields are required.' }); return;
      }

      // Persist before calling walletStatus so buildEnv() picks them up
      const config = loadConfig();
      config.okxApiKey     = apiKey;
      config.okxSecretKey  = secretKey;
      config.okxPassphrase = passphrase;
      saveConfig(config);

      try {
        const status = await walletStatus();
        if (!status.loggedIn) throw new Error('Wallet shows loggedIn=false — check your API Key credentials.');
        logInfo('✓ API Key authentication successful.');
      } catch (err) {
        emitErr('wallet-mode', 'OKX_LOGIN_FAILED', { message: `API Key verification failed: ${err.message}` }); return;
      }
    }

    // Step 3 — read EVM address and persist mode
    logInfo('');
    logInfo('Step 3/3 — Reading OKX wallet EVM address...');
    await _saveOkxMode(authMethod);
  } finally {
    rl.close();
  }
}

async function _saveOkxMode(authMethod) {
  let address;
  try {
    address = await getOkxEvmAddress();
    logInfo(`✓ OKX wallet: ${address} (BSC)`);
  } catch (err) {
    emitErr('wallet-mode', 'OKX_WALLET_NOT_FOUND', { message: err.message });
    return;
  }

  const config = loadConfig();
  config.mode    = 'okx';
  config.address = address;
  saveConfig(config);

  logInfo('');
  logInfo('✓ Saved to ~/.aigateway/config.json');
  emitOk('wallet-mode', { mode: 'okx', address, authMethod }, { mode: 'okx', address, authMethod });
}
