/**
 * Mode-aware chain/token configuration.
 *
 * okx mode (default) → X Layer + USDG
 * session-key mode    → BSC + USDT (opt-in)
 *
 * Import getChainConfig() wherever the chain or token address depends on mode.
 */
import { bsc, xLayer } from "viem/chains";
import {
  BSC_RPC_URL, USDT_BSC,
  XLAYER_RPC_URL, USDG_XLAYER, USDG_DECIMALS,
} from "./constants.mjs";
import { loadConfig } from "./config.mjs";

export function getChainConfig(mode) {
  const m = mode ?? loadConfig().mode;
  if (m === "okx") {
    return {
      chain:         xLayer,
      rpcUrl:        XLAYER_RPC_URL,
      token:         USDG_XLAYER,
      tokenDecimals: USDG_DECIMALS,
      tokenSymbol:   "USDG",
      nativeSymbol:  "OKB",
      wcChainId:     "eip155:196",
      networkName:   "X Layer (ERC20)",
    };
  }
  // session-key (opt-in) → BSC + USDT
  return {
    chain:         bsc,
    rpcUrl:        BSC_RPC_URL,
    token:         USDT_BSC,
    tokenDecimals: 18,
    tokenSymbol:   "USDT",
    nativeSymbol:  "BNB",
    wcChainId:     "eip155:56",
    networkName:   "BNB Chain(BEP20) only",
  };
}
