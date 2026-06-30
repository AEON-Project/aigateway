/**
 * wallet-init: check / create the wallet for the current mode.
 *
 * okx (default) → X Layer / USDG; EIP-3009, no approve step, needsTopup by USDG balance.
 * session-key   → BSC / USDT; auto-creates a local key, approve required.
 */
import {loadConfig, saveConfig, getOrCreateDeviceId, resolve} from "../config.mjs";
import {getCombinedBalance, getBalanceByAddress, getAllowance} from "../balance.mjs";
import {walletStatus} from "../okx-wallet.mjs";
import {getChainConfig} from "../chain-config.mjs";
import {
    LOW_BALANCE_THRESHOLD,
    MIN_TOPUP_USDT,
    TOPUP_PRESETS,
} from "../funding.mjs";
import {emitOk, logInfo} from "../output.mjs";

export async function initWallet(opts) {
    const config = loadConfig();
    const {appId} = opts;
    const cfg = getChainConfig();

    // ── OKX mode (default) ────────────────────────────────────────────────────
    if (config.mode === 'okx') {
        if (!config.address) {
            logInfo(`Creating Agent Wallet...`);
            logInfo(`Provider  : OKX Agentic Wallet`);
            logInfo(`Status    : Provisioning...`);
            emitOk("wallet-init", {
                ready: false, mode: 'okx', needsTopup: true, topupReason: 'okx_not_configured',
                message: "OKX wallet not configured. Run: aigateway wallet-mode okx", appId,
            }, {ready: false, mode: 'okx', appId});
            return;
        }

        // Check OKX session validity
        try {
            logInfo(`Provider  : OKX Agentic Wallet`);
            const status = await walletStatus();
            const loggedIn = status.loggedIn === true || status.data?.loggedIn === true;
            if (!loggedIn) {
                logInfo(`Status    : Provisioning...`);
                emitOk("wallet-init", {
                    ready: false, mode: 'okx', needsTopup: false, topupReason: null,
                    tokenSymbol: cfg.tokenSymbol, okxSessionExpired: true, address: config.address, appId,
                    message: "OKX session expired. Re-authenticate: aigateway wallet-mode okx --email <email>",
                }, {ready: false, mode: 'okx', okxSessionExpired: true, appId});
                return;
            }
        } catch (e) {
            logInfo(`OKX session check skipped: ${e.message}`);
        }


        let usdt = "0", bnb = "0", usdtNum = 0, chainCheckOk = true, chainCheckError = null;
        try {
            const bal = await getBalanceByAddress(config.address);
            usdt = bal.usdt;
            bnb = bal.bnb;
            usdtNum = parseFloat(usdt);
            logInfo(`Wallet: ${config.address} Ready.`);
            logInfo(`Balance: ${usdt} USDG, ${bnb} OKB`);
        } catch (e) {
            chainCheckOk = false;
            chainCheckError = e.message;
            logInfo(`Chain status check failed: ${e.message}`);
        }

        let needsTopup = false, topupReason = null;
        if (!chainCheckOk) {
            needsTopup = true;
            topupReason = "chain_check_failed";
        } else if (usdtNum < LOW_BALANCE_THRESHOLD) {
            needsTopup = true;
            topupReason = "low_balance";
        }

        emitOk("wallet-init", {
            ready: true, mode: 'okx', appId, address: config.address,
            usdt, bnb, needsTopup, topupReason,
            tokenSymbol: cfg.tokenSymbol, nativeSymbol: cfg.nativeSymbol,
            minTopup: MIN_TOPUP_USDT, presets: TOPUP_PRESETS,
            chainCheck: chainCheckOk ? "ok" : {error: chainCheckError},
        }, {ready: true, mode: 'okx', appId});
        return;
    }

    // ── session-key mode (local key, opt-in) ──────────────────────────────────
    let created = false;

    if (!config.privateKey) {
        logInfo(`Creating Agent Wallet...`);
        logInfo(`Provider  : Aeon Agentic Wallet`);
        logInfo(`Status    : Provisioning...`);
        const {generatePrivateKey, privateKeyToAccount} = await import("viem/accounts");
        const newKey = generatePrivateKey();
        const account = privateKeyToAccount(newKey);
        config.privateKey = newKey;
        config.address = account.address;
        config.mode = "private-key";
        created = true;
        saveConfig(config);
        logInfo(`Auto-created session wallet: ${config.address}`);
    } else {
        logInfo(`Wallet: ${config.address}`);
    }

    let usdt = "0", bnb = "0", usdtNum = 0, chainCheckOk = true, chainCheckError = null;

    let allowance = 0n;
    if (!created) {
        logInfo(`Provider  : Aeon Agentic Wallet`);
        logInfo(`Status    : Provisioning...`);
        try {
            const bal = await getCombinedBalance(config.privateKey);
            usdt = bal.usdt;
            bnb = bal.bnb;
            usdtNum = parseFloat(usdt);
            logInfo(`Balance: ${usdt} USDT, ${bnb} BNB`);
            allowance = await getAllowance(config.address);
            logInfo(`Allowance: ${allowance === 0n ? "0 (approve required)" : "already approved"}`);
        } catch (e) {
            chainCheckOk = false;
            chainCheckError = e.message;
            logInfo(`Chain status check failed: ${e.message}`);
        }
    } else {
        logInfo("Fresh wallet — skipping balance lookup (assumed empty).");
    }

    let needsTopup = false, topupReason = null;
    if (created) {
        needsTopup = true;
        topupReason = "first_time";
    } else if (!chainCheckOk) {
        needsTopup = true;
        topupReason = "chain_check_failed";
    } else if (usdtNum < LOW_BALANCE_THRESHOLD) {
        needsTopup = true;
        topupReason = "low_balance";
    } else if (allowance === 0n) {
        needsTopup = true;
        topupReason = "no_approve";
    }

    const deviceId = getOrCreateDeviceId();

    emitOk("wallet-init", {
        ready: true, created, appId,
        mode: config.mode || null,
        address: config.address || null,
        deviceId,
        mainWallet: config.mainWallet || null,
        serviceUrl: config.serviceUrl || null,
        usdt, bnb, needsTopup, topupReason,
        tokenSymbol: cfg.tokenSymbol, nativeSymbol: cfg.nativeSymbol,
        minTopup: MIN_TOPUP_USDT, presets: TOPUP_PRESETS,
        chainCheck: chainCheckOk ? "ok" : {error: chainCheckError},
    }, {ready: true, appId});
}
