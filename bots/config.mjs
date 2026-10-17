// Shared config + helpers for SealBatch bots. All settings from env.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createPublicClient, createWalletClient, http, fallback, defineChain, encodeAbiParameters, keccak256, toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
export const abi = JSON.parse(readFileSync(join(here, '..', 'abi', 'SealBatch.json'), 'utf8'));

function need(k) {
  const v = process.env[k];
  if (!v) { console.error(`missing env ${k}`); process.exit(2); }
  return v;
}

export const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
export const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);
export const SB = need('SB');
export const FUNDER_PK = need('FUNDER_PK');
export const KEEPER_PK = process.env.KEEPER_PK || FUNDER_PK;
export const BOT_COUNT = Number(process.env.BOT_COUNT || 8);
export const MID_TICK = Number(process.env.MID_TICK || 20);
export const GRIEFERS = Number(process.env.GRIEFERS || 0);
export const BOT_MON = process.env.BOT_MON || '0.3';
export const POLL_MS = Math.max(300, Number(process.env.POLL_MS || 300)); // public RPC: keep >= 300ms
export const LOG_CHUNK = BigInt(process.env.LOG_CHUNK || 100);

export const chain = defineChain({
  id: CHAIN_ID, name: `chain-${CHAIN_ID}`,
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
// retryCount/retryDelay: viem retries 429 + 5xx + network errors with exponential backoff (delay*2^n).
// cacheTime 0: viem caches getBlockNumber for pollingInterval (4s) by default, which breaks window tracking.
// 主 RPC + 备用 RPC（官方 RPC 限流时自动切换）；本地 anvil 不加备用
const FALLBACK_RPCS = RPC_URL.includes('127.0.0.1') ? [] : (process.env.FALLBACK_RPCS ||
  'https://rpc.ankr.com/monad_testnet,https://monad-testnet.drpc.org,https://rpc-testnet.monadinfra.com,https://10143.rpc.thirdweb.com').split(',').filter(Boolean);
const transport = () => fallback([RPC_URL, ...FALLBACK_RPCS].map((u) => http(u, { retryCount: 2, retryDelay: 400, timeout: 15_000 })), { retryCount: 4 });
export const pub = createPublicClient({ chain, transport: transport(), cacheTime: 0, pollingInterval: 300 });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ts = () => new Date().toISOString().slice(11, 19);
export const log = (...a) => console.log(ts(), ...a);
export const fmt = (x) => (Number(x) / 1e18).toFixed(4).replace(/\.?0+$/, '');

export const read = (functionName, args = []) => pub.readContract({ address: SB, abi, functionName, args });

let _params;
export async function params() {
  if (!_params) {
    const [genesisBlock, windowBlocks, timeoutWindows, bond, feeBps] = await Promise.all(
      ['genesisBlock', 'windowBlocks', 'timeoutWindows', 'bond', 'feeBps'].map((f) => read(f)));
    _params = { genesisBlock, windowBlocks, timeoutWindows, bond, feeBps };
  }
  return _params;
}
export async function windowAt(bn) {
  const p = await params();
  const w = (bn - p.genesisBlock) / p.windowBlocks;
  return { window: w, offset: (bn - p.genesisBlock) % p.windowBlocks };
}

export function commitHash(batchId, owner, isBuy, qty, tick, salt) {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'bool' },
      { type: 'uint128' }, { type: 'uint8' }, { type: 'bytes32' }],
    [SB, BigInt(CHAIN_ID), BigInt(batchId), owner, isBuy, BigInt(qty), Number(tick), salt]));
}

export function randomSalt() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

// Gas limits are explicit (no estimation) so a nonce is never skipped by a failed estimate
// and concurrent sends from one account stay gap-free. settle is the only heavy call.
export const GAS = {
  commit: 130_000n, reveal: 110_000n, claim: 120_000n, settle: 400_000n, cancel: 50_000n, onboard: 300_000n, // 实测最大值 ×1.2~1.3；Monad 按 gas limit 计费，别给太宽
};

/** Wallet with a local nonce counter; sends are serialized through a promise chain. */
export class Wallet {
  constructor(pk, label) {
    this.account = privateKeyToAccount(pk);
    this.address = this.account.address;
    this.label = label || this.address.slice(0, 8);
    this.client = createWalletClient({ account: this.account, chain, transport: transport(), cacheTime: 0 });
    this.nonce = null;
    this.q = Promise.resolve();
  }
  async syncNonce() {
    this.nonce = await pub.getTransactionCount({ address: this.address, blockTag: 'pending' });
  }
  /** Returns tx hash once broadcast (not mined). */
  send(fn) {
    const p = this.q.then(async () => {
      if (this.nonce === null) await this.syncNonce();
      try {
        const h = await fn(this.nonce);
        this.nonce += 1;
        return h;
      } catch (e) {
        await this.syncNonce().catch(() => {});
        throw e;
      }
    });
    this.q = p.catch(() => {});
    return p;
  }
  write(functionName, args, { value, gas } = {}) {
    return this.send((nonce) => this.client.writeContract({
      address: SB, abi, functionName, args, nonce, value, gas: gas ?? GAS[functionName],
    }));
  }
  transfer(to, value) {
    return this.send((nonce) => this.client.sendTransaction({ to, value, nonce, gas: 21_000n }));
  }
}

export async function receipt(hash) {
  return pub.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 60_000 });
}

/** getLogs in chunks (Monad RPC limits block ranges). */
export async function getLogsChunked(eventName, fromBlock, toBlock, args) {
  const ev = abi.find((x) => x.type === 'event' && x.name === eventName);
  const out = [];
  for (let b = fromBlock; b <= toBlock; b += LOG_CHUNK) {
    const e = b + LOG_CHUNK - 1n < toBlock ? b + LOG_CHUNK - 1n : toBlock;
    out.push(...await pub.getLogs({ address: SB, event: ev, args, fromBlock: b, toBlock: e }));
  }
  return out;
}

/** Run the independent Python reference (ref/clearing.py) on revealed orders. */
export function refClear(orders) {
  const r = spawnSync('python3', ['-I', join(here, '..', 'ref', 'clearing.py')], {
    input: JSON.stringify(orders.map((o) => ({ ...o, qty: String(o.qty) }))), encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

export const PHASE = ['commit', 'reveal', 'settleable', 'cancellable', 'settled', 'cancelled', 'not-started'];
