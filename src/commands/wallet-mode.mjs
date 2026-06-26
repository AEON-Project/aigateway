/**
 * wallet-mode: switch payment mode between local session key and OKX Agentic Wallet.
 *
 * Non-interactive (Claude Code / CI friendly):
 *   Email OTP — two steps:
 *     aigateway wallet-mode okx --email user@example.com    # sends OTP
 *     aigateway wallet-mode okx --otp 123456                # verifies & saves
 *   API Key — one step (env vars inline or pre-exported):
 *     OKX_API_KEY=x OKX_SECRET_KEY=x OKX_PASSPHRASE=x aigateway wallet-mode okx
 *
 * Interactive (real terminal):
 *   aigateway wallet-mode okx     # guided wizard with readline prompts
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

export async function setWalletMode(mode, opts = {}) {
  if (mode !== 'okx' && mode !== 'session-key') {
    emitErr('wallet-mode', 'INVALID_MODE', {
      message: `Unknown mode: "${mode}". Supported: okx | session-key`,
    });
    return;
  }

  // ── session-key: flip the flag and restore address from private key ─────
  if (mode === 'session-key') {
    const config = loadConfig();
    config.mode = 'session-key';
    // Restore config.address to the session key address (may have been
    // overwritten with the OKX wallet address when switching to okx mode).
    if (config.privateKey) {
      const { privateKeyToAccount } = await import('viem/accounts');
      config.address = privateKeyToAccount(config.privateKey).address;
    }
    saveConfig(config);
    logInfo(`Switched to session-key mode. Wallet: ${config.address || '(none)'}`);
    emitOk('wallet-mode', { mode: 'session-key' }, { mode: 'session-key' });
    return;
  }

  // ── okx setup ─────────────────────────────────────────────────────────────
  await _ensureOnchainos();

  const config = loadConfig();

  // Already configured: verify session is still alive, skip re-auth if it is
  if (config.mode === 'okx' && config.address) {
    try {
      const status = await walletStatus();
      const loggedIn = status.loggedIn === true || status.data?.loggedIn === true;
      if (loggedIn) {
        logInfo(`OKX wallet already configured (${config.address}) and session is active.`);
        emitOk('wallet-mode',
          { mode: 'okx', address: config.address, alreadyConfigured: true },
          { mode: 'okx', address: config.address, alreadyConfigured: true });
        return;
      }
      logInfo('OKX session expired — re-authenticating...');
    } catch {
      // onchainos unavailable, proceed to re-auth
    }
  }

  // Path A: API Key already in env or config
  const hasApiKey = process.env.OKX_API_KEY || config.okxApiKey;
  if (hasApiKey) {
    logInfo('Using existing OKX API Key credentials.');
    await _finalise('apikey');
    return;
  }

  // Path B: --email flag (step 1 — send OTP)
  if (opts.email) {
    await _sendOtp(opts.email);
    return;
  }

  // Path C: --otp flag (step 2 — verify OTP)
  if (opts.otp) {
    await _verifyAndFinalise(opts.otp);
    return;
  }

  // Path D: interactive readline — only when stdin is a real TTY.
  // In Claude Code / agent shells, stdin.isTTY is false even if the user sees
  // a terminal; readline will silently consume chat messages and loop forever.
  if (!process.stdin.isTTY) {
    emitErr('wallet-mode', 'USE_FLAGS_IN_AGENT', {
      message: 'Interactive input is not available in this environment.',
      hint: [
        'Use flags instead:',
        '  # Email OTP (two steps):',
        '  aigateway wallet-mode okx --email your@email.com',
        '  aigateway wallet-mode okx --otp <code>',
        '  # API Key (one step):',
        '  OKX_API_KEY=xxx OKX_SECRET_KEY=xxx OKX_PASSPHRASE=xxx aigateway wallet-mode okx',
      ].join('\n'),
    });
    return;
  }
  await _interactiveSetup();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _ensureOnchainos() {
  logInfo('Checking onchainos CLI...');
  const available = await checkOnchainos();
  if (available) { logInfo('✓ onchainos is available.'); return; }

  logInfo('onchainos not found — installing...');
  try {
    await installOnchainos();
    if (!await checkOnchainos()) {
      throw new Error('onchainos still not found after install. Check your PATH.');
    }
    logInfo('✓ onchainos installed.');
  } catch (err) {
    emitErr('wallet-mode', 'OKX_CLI_INSTALL_FAILED', {
      message: err.message,
      hint: 'Manual install: curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh',
    });
    throw err;
  }
}

async function _sendOtp(email) {
  logInfo(`Sending OTP to ${email}...`);
  try {
    await loginWithEmail(email);
  } catch (err) {
    emitErr('wallet-mode', 'OKX_LOGIN_FAILED', { message: err.message });
    return;
  }
  // Persist email so --otp step can reference it (optional UX, not strictly required)
  const config = loadConfig();
  config._okxPendingEmail = email;
  saveConfig(config);

  logInfo(`✓ OTP sent to ${email}`);
  emitOk('wallet-mode', {
    mode: 'okx',
    step: 'otp_sent',
    email,
    next: `aigateway wallet-mode okx --otp <code>`,
  }, { step: 'otp_sent', email });
}

async function _verifyAndFinalise(otp) {
  logInfo('Verifying OTP...');
  try {
    await verifyOtp(otp);
    logInfo('✓ Login successful.');
  } catch (err) {
    emitErr('wallet-mode', 'OKX_LOGIN_FAILED', { message: `OTP verification failed: ${err.message}` });
    return;
  }
  await _finalise('email');
}

async function _finalise(authMethod) {
  logInfo('Reading OKX wallet EVM address...');
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
  delete config._okxPendingEmail;
  saveConfig(config);
  logInfo('✓ Saved to ~/.aigateway/config.json');
  emitOk('wallet-mode', { mode: 'okx', address, authMethod }, { mode: 'okx', address, authMethod });
}

async function _interactiveSetup() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    logInfo('');
    logInfo('Choose login method:');
    logInfo('  [1] Email + OTP  (recommended)');
    logInfo('  [2] API Key  (OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE)');
    logInfo('');

    let authMethod = null;
    while (!authMethod) {
      let ans;
      try { ans = (await rl.question('Enter choice [1-2]: ')).trim(); }
      catch {
        emitErr('wallet-mode', 'STDIN_NOT_READABLE', {
          message: 'Cannot read interactive input in this environment.',
          hint: [
            'Email OTP (two steps):',
            '  aigateway wallet-mode okx --email your@email.com',
            '  aigateway wallet-mode okx --otp <code>',
            'API Key (one step):',
            '  OKX_API_KEY=x OKX_SECRET_KEY=x OKX_PASSPHRASE=x aigateway wallet-mode okx',
          ].join('\n'),
        });
        return;
      }
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
      const otp = (await rl.question(`Enter OTP code sent to ${email}: `)).trim();
      if (!otp) { emitErr('wallet-mode', 'INVALID_INPUT', { message: 'OTP is required.' }); return; }
      try {
        await verifyOtp(otp);
        logInfo('✓ Login successful.');
      } catch (err) {
        emitErr('wallet-mode', 'OKX_LOGIN_FAILED', { message: `OTP verification failed: ${err.message}` }); return;
      }
    } else {
      logInfo('');
      logInfo('Keys are stored in ~/.aigateway/config.json (mode 0600).');
      logInfo('');
      const apiKey     = (await rl.question('Enter OKX_API_KEY:    ')).trim();
      const secretKey  = (await rl.question('Enter OKX_SECRET_KEY: ')).trim();
      const passphrase = (await rl.question('Enter OKX_PASSPHRASE: ')).trim();
      if (!apiKey || !secretKey || !passphrase) {
        emitErr('wallet-mode', 'INVALID_INPUT', { message: 'All three API Key fields are required.' }); return;
      }
      const cfg = loadConfig();
      cfg.okxApiKey = apiKey; cfg.okxSecretKey = secretKey; cfg.okxPassphrase = passphrase;
      saveConfig(cfg);
      try {
        const status = await walletStatus();
        if (!status.loggedIn) throw new Error('loggedIn=false — check credentials.');
        logInfo('✓ API Key verified.');
      } catch (err) {
        emitErr('wallet-mode', 'OKX_LOGIN_FAILED', { message: `API Key verification failed: ${err.message}` }); return;
      }
    }

    logInfo('');
    await _finalise(authMethod === 'email' ? 'email' : 'apikey');
  } finally {
    rl.close();
  }
}
