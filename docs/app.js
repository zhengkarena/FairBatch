// SealBatch 封盘 前端（无构建，ES module）
import {
  createPublicClient, createWalletClient, http, fallback, custom, defineChain,
  encodeAbiParameters, keccak256, parseEther, formatEther, parseUnits, formatUnits, isAddress,
} from './vendor/viem.js';
import { privateKeyToAccount, generatePrivateKey } from './vendor/viem.js';
import { CONFIG } from './config.js';
import { SEALBATCH_ABI, TOKEN_ABI } from './abi.js';
import { clear, priceOfTick, NUM_TICKS } from './clearing.js';
import { commitHash, randomSalt } from './hash.js';

const $ = (id) => document.getElementById(id);
const ZERO = '0x0000000000000000000000000000000000000000';
const PHASE_NAME = ['收单', '揭示', '待结算', '超时可取消', '已结算', '已取消', '未开始'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────── 配置：URL 参数 > deployment.json > config.js ─────────────
const cfg = { ...CONFIG };
async function loadConfig() {
  try {
    const r = await fetch('./deployment.json', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      const pick = (...ks) => { for (const k of ks) if (d[k] != null && d[k] !== '') return d[k]; };
      const sb = pick('sealBatch', 'SealBatch', 'sealbatch', 'address');
      if (sb) cfg.sealBatch = sb;
      const b = pick('base', 'BASE', 'baseToken'); if (b) cfg.base = b;
      const q = pick('quote', 'QUOTE', 'quoteToken'); if (q) cfg.quote = q;
      const c = pick('chainId', 'chain'); if (c) cfg.chainId = Number(c);
      const rpc = pick('rpcUrl', 'rpc'); if (rpc) cfg.rpcUrl = rpc;
      const ex = pick('explorer'); if (ex != null) cfg.explorer = ex;
    }
  } catch { /* 没有 deployment.json 也没关系 */ }
  const p = new URLSearchParams(location.search);
  if (p.get('rpc')) cfg.rpcUrl = p.get('rpc');
  if (p.get('chain')) cfg.chainId = Number(p.get('chain'));
  if (p.get('sb')) cfg.sealBatch = p.get('sb');
  if (p.get('base')) cfg.base = p.get('base');
  if (p.get('quote')) cfg.quote = p.get('quote');
  if (p.has('explorer')) cfg.explorer = p.get('explorer');
  if (p.get('gas')) cfg.onboardGasMON = p.get('gas');
  if (cfg.chainId === 31337 && !p.has('explorer')) cfg.explorer = '';
  if (cfg.chainId !== 10143 && cfg.chainName === 'Monad Testnet') cfg.chainName = `Chain ${cfg.chainId}`;
}

// ───────────── 全局状态 ─────────────
const S = {
  chain: null, pub: null, wallet: null, owner: null,
  session: null, sessionWallet: null,
  C: null, // 合约常量 {genesis, W, timeout, bond, fee}
  block: null, samples: [], avgBlockMs: null,
  batches: new Map(), // batchId -> Batch
  myAuth: false,
  freeBase: 0n, freeQuote: 0n,
  side: 'buy',
  viewBatch: null, autoView: true,
  inflight: new Set(),
  orderView: new Map(),
};

// ───────────── 日志 / 提示 ─────────────
function txLink(hash) {
  if (!hash) return '';
  const short = hash.slice(0, 10) + '…';
  return cfg.explorer ? `<a href="${cfg.explorer}/tx/${hash}" target="_blank" rel="noopener">${short}</a>` : `<span class="mono">${short}</span>`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// 主 RPC + 备用 RPC：单个出错/限流自动切到下一个（URL 指定了 ?rpc= 时只用它，便于本地调试）
function rpcTransport() {
  const urls = [cfg.rpcUrl, ...((new URLSearchParams(location.search).get('rpc')) ? [] : (cfg.fallbackRpcs || []))];
  const list = [...new Set(urls)].map((u) => http(u, { retryCount: 1, retryDelay: 300, timeout: 8_000 }));
  return list.length > 1 ? fallback(list, { retryCount: 2 }) : list[0];
}
function log(msg, kind = '', hash = '') {
  const li = document.createElement('li');
  li.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span><span class="${kind}">${esc(msg)}</span> ${txLink(hash)}`;
  $('log').prepend(li);
  while ($('log').children.length > 200) $('log').lastChild.remove();
}
function toast(msg, kind = '', hash = '') {
  const d = document.createElement('div');
  d.className = 'toast ' + kind;
  d.innerHTML = `${esc(msg)} ${txLink(hash)}`;
  $('toasts').append(d);
  setTimeout(() => d.remove(), 6000);
}
function errName(e) {
  try {
    const found = e?.walk?.((x) => x?.data?.errorName);
    if (found?.data?.errorName) return found.data.errorName;
  } catch {}
  const m = String(e?.shortMessage || e?.message || e);
  for (const n of ['WrongPhase', 'NotAuthorized', 'AlreadyCommitted', 'NoCommit', 'AlreadyRevealed', 'BadReveal',
    'InsufficientLock', 'AlreadyClaimed', 'Insufficient', 'Cooldown']) if (m.includes(n)) return n;
  return null;
}
const ERR_CN = {
  WrongPhase: '阶段不对', NotAuthorized: '未授权（会话密钥不匹配）', AlreadyCommitted: '本批已封过单',
  NoCommit: '本批没有封单', AlreadyRevealed: '已揭示', BadReveal: '揭示内容与承诺不符', InsufficientLock: '锁定余额不足',
  AlreadyClaimed: '已领取', Insufficient: '余额不足', Cooldown: '领币冷却中（10 分钟一次）',
};
function errMsg(e) {
  const n = errName(e);
  if (n) return `${ERR_CN[n] || n} (${n})`;
  return String(e?.shortMessage || e?.message || e).slice(0, 200);
}

// ───────────── 格式化 ─────────────
const fmt = (v, d = 4) => { try { const n = Number(formatUnits(BigInt(v), 18)); return n.toLocaleString('en-US', { maximumFractionDigits: d }); } catch { return '-'; } };
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '-');
const px = (t) => priceOfTick(t).toFixed(1);

// ───────────── 链与客户端 ─────────────
function makeChain() {
  return defineChain({
    id: cfg.chainId, name: cfg.chainName,
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: cfg.explorer ? { default: { name: 'Explorer', url: cfg.explorer } } : undefined,
  });
}
const sbRead = (functionName, args = []) => S.pub.readContract({ address: cfg.sealBatch, abi: SEALBATCH_ABI, functionName, args });

// ───────────── 会话密钥 ─────────────
const SK_KEY = () => `sb.sessionKey.${cfg.chainId}`;
function loadSession(create = false) {
  let pk = null;
  try { pk = localStorage.getItem(SK_KEY()); } catch {}
  if (!pk && create) {
    pk = generatePrivateKey();
    try { localStorage.setItem(SK_KEY(), pk); } catch {}
    log('已在浏览器生成会话密钥（只保存在本机 localStorage）');
  }
  if (!pk) return null;
  S.session = privateKeyToAccount(pk);
  S.sessionWallet = createWalletClient({ account: S.session, chain: S.chain, transport: rpcTransport() });
  $('sessionAddr').textContent = S.session.address;
  return S.session;
}

// 所有会话密钥交易串行发送，避免 nonce 冲突
let skQueue = Promise.resolve();
function sendSession(label, functionName, args) {
  const run = async () => {
    if (!S.sessionWallet) throw new Error('没有会话密钥，请先入场');
    const hash = await S.sessionWallet.writeContract({ address: cfg.sealBatch, abi: SEALBATCH_ABI, functionName, args, chain: S.chain });
    log(`${label} 已发送`, '', hash);
    const rc = await S.pub.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: 60_000 });
    if (rc.status !== 'success') throw new Error(`${label} 交易回滚`);
    log(`${label} 已上链 ✓`, 'ok', hash);
    toast(`${label} 成功`, 'ok', hash);
    return rc;
  };
  const p = skQueue.then(run, run);
  skQueue = p.catch(() => {});
  return p;
}
async function sendWallet(label, address, abi, functionName, args, value) {
  if (!S.wallet || !S.owner) throw new Error('请先连接钱包');
  await ensureChain();
  const hash = await S.wallet.writeContract({ account: S.owner, address, abi, functionName, args, value, chain: S.chain });
  log(`${label} 已发送`, '', hash);
  const rc = await S.pub.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: 90_000 });
  if (rc.status !== 'success') throw new Error(`${label} 交易回滚`);
  log(`${label} 已上链 ✓`, 'ok', hash);
  toast(`${label} 成功`, 'ok', hash);
  return rc;
}

// ───────────── 钱包 ─────────────
// MetaMask 新版会把错误码包在 data.originalError 里，统一取出来
const errCode = (e) => e?.code ?? e?.data?.originalError?.code ?? e?.cause?.code;
async function ensureChain() {
  const eth = window.ethereum;
  if (!eth) return;
  const hex = '0x' + cfg.chainId.toString(16);
  let cur = null;
  try { cur = await eth.request({ method: 'eth_chainId' }); } catch {}
  if (cur && parseInt(cur, 16) === cfg.chainId) { renderWalletNet(cur); return; }
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if (errCode(e) === 4001) { renderWalletNet(cur); throw new Error('你在钱包里拒绝了切换网络，请点右上角红色「钱包网络」按钮重试'); }
    // 钱包里还没有这条链（4902）或其他未知错误：都尝试先添加再切换
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hex, chainName: cfg.chainName, rpcUrls: [cfg.rpcUrl],
        nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
        blockExplorerUrls: cfg.explorer ? [cfg.explorer] : undefined,
      }],
    });
    try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); } catch {}
  }
  try { cur = await eth.request({ method: 'eth_chainId' }); } catch {}
  renderWalletNet(cur);
  if (!cur || parseInt(cur, 16) !== cfg.chainId) throw new Error('钱包还没切到 Monad 测试网（链 ID 10143）');
}
// 右上角显示「钱包」当前所在网络（左边那个绿色徽章只代表页面自己连上了 RPC）
function renderWalletNet(cur) {
  const b = $('walletNet');
  if (!b) return;
  b.hidden = false;
  const id = cur ? parseInt(cur, 16) : null;
  if (id === cfg.chainId) { b.className = 'badge ok'; b.textContent = '钱包网络：Monad 测试网 ✓'; }
  else { b.className = 'badge bad'; b.textContent = `钱包在其他网络（链 ID ${id ?? '?'}）· 点我切换`; }
}
function setOwner(addr) {
  S.owner = addr || null;
  $('ownerAddr').textContent = addr || '未连接';
  $('btnConnect').textContent = addr ? short(addr) : '连接钱包';
  S.orderView.clear();
  refreshAccount();
  renderOrders();
}
async function connect(interactive = true) {
  const eth = window.ethereum;
  if (!eth) { if (interactive) toast('没有检测到浏览器钱包（MetaMask 等）', 'err'); return; }
  try {
    const accs = await eth.request({ method: interactive ? 'eth_requestAccounts' : 'eth_accounts' });
    if (!accs?.length) return;
    S.wallet = createWalletClient({ chain: S.chain, transport: custom(eth) });
    setOwner(accs[0]);
    if (interactive) await ensureChain();
    else { try { renderWalletNet(await eth.request({ method: 'eth_chainId' })); } catch {} }
    if (!S._ethHooked) {
      S._ethHooked = true;
      eth.on?.('accountsChanged', (a) => setOwner(a?.[0]));
      eth.on?.('chainChanged', (c) => { renderWalletNet(c); log('钱包网络已切换：链 ID ' + parseInt(c, 16)); });
    }
  } catch (e) { log('连接钱包失败：' + errMsg(e), 'err'); if (interactive) toast('连接钱包失败：' + errMsg(e), 'err'); }
}

// ───────────── 订单本地存储 ─────────────
const ORD_KEY = () => `sb.orders.${cfg.chainId}.${cfg.sealBatch.toLowerCase()}.${(S.owner || '').toLowerCase()}`;
function loadOrders() { try { return JSON.parse(localStorage.getItem(ORD_KEY()) || '[]'); } catch { return []; } }
function saveOrders(list) { try { localStorage.setItem(ORD_KEY(), JSON.stringify(list)); } catch {} }
function upsertOrder(o) {
  const list = loadOrders();
  const i = list.findIndex((x) => x.batchId === o.batchId);
  if (i >= 0) list[i] = { ...list[i], ...o }; else list.unshift(o);
  saveOrders(list.slice(0, 50));
}
function removeOrder(batchId) { saveOrders(loadOrders().filter((x) => x.batchId !== batchId)); }

// ───────────── 窗口计算 ─────────────
const windowOf = (block) => (S.C ? Number((block - S.C.genesis) / S.C.W) : 0);
function localPhase(batchId, w) {
  const b = S.batches.get(batchId);
  if (b?.settled) return 4;
  if (b?.cancelled) return 5;
  if (w < batchId) return 6;
  if (w === batchId) return 0;
  if (w === batchId + 1) return 1;
  if (w < batchId + 2 + Number(S.C.timeout)) return 2;
  return 3;
}

// ───────────── 轮询：区块号 ─────────────
let blockDelay = 400;
async function pollBlock() {
  for (;;) {
    try {
      const bn = await S.pub.getBlockNumber({ cacheTime: 0 });
      if (S.block === null || bn !== S.block) {
        S.block = bn;
        S.samples.push({ b: Number(bn), t: performance.now() });
        if (S.samples.length > 40) S.samples.shift();
        if (S.samples.length >= 3) {
          const a = S.samples[0], z = S.samples[S.samples.length - 1];
          if (z.b > a.b) S.avgBlockMs = (z.t - a.t) / (z.b - a.b);
        }
        renderPipeline();
      }
      blockDelay = 400;
      setNet(true);
    } catch (e) {
      blockDelay = Math.min(blockDelay * 2, 5000);
      setNet(false, errMsg(e));
    }
    await sleep(blockDelay);
  }
}
function setNet(ok, msg) {
  const b = $('netBadge');
  b.className = 'badge ' + (ok ? 'ok' : 'bad');
  b.textContent = ok ? `${cfg.chainName} · 已连接` : 'RPC 异常，退避重试中';
  if (!ok && msg && S._lastNetErr !== msg) { S._lastNetErr = msg; log('RPC 错误：' + msg, 'err'); }
  if (ok) S._lastNetErr = null;
}

// ───────────── 流水线渲染 ─────────────
function renderPipeline() {
  if (!S.C || S.block === null) return;
  const W = Number(S.C.W);
  const off = Number(S.block - S.C.genesis);
  const w = Math.floor(off / W);
  const inWin = off % W;
  $('blockNum').textContent = S.block.toString();
  $('winNum').textContent = w;
  $('winProgress').style.width = `${((inWin + 1) / W) * 100}%`;
  $('winLeft').textContent = `批次 #${w} 收单中 · 本窗口剩余 ${W - inWin - 1} 块（共 ${W} 块/窗口）`;
  if (S.avgBlockMs) {
    $('blockTime').textContent = `${(S.avgBlockMs / 1000).toFixed(2)} 秒`;
    $('batchSecs').textContent = ((S.avgBlockMs * W) / 1000).toFixed(1);
  }
  const mine = new Set(loadOrders().map((o) => o.batchId));
  const ids = [];
  for (let i = w - 4; i <= w + 1; i++) if (i >= 0) ids.push(i);
  $('pipeline').innerHTML = ids.map((id) => {
    const ph = localPhase(id, w);
    const b = S.batches.get(id);
    const cnt = b ? `封单 ${b.commits} · 揭示 ${b.reveals}` : '…';
    let extra = '';
    if (ph === 4 && b && b.volume > 0n) extra = `<span class="cnt">@${px(b.priceTick)} · ${fmt(b.volume, 3)} SBA</span>`;
    else if (ph === 4) extra = `<span class="cnt">未成交</span>`;
    return `<div class="pb p${ph} ${mine.has(id) ? 'mine' : ''}" data-b="${id}">
      <span class="id">批次 #${id}${mine.has(id) ? ' · 我' : ''}</span>
      <span class="st">${PHASE_NAME[ph]}</span><span class="cnt">${ph === 6 ? '' : cnt}</span>${extra}</div>`;
  }).join('');
}
$('pipeline').addEventListener('click', (e) => {
  const el = e.target.closest('.pb'); if (!el) return;
  S.autoView = false; showBatch(Number(el.dataset.b));
});

// 周期刷新流水线涉及批次的链上状态（限流）
async function refreshBatches() {
  if (!S.C || S.block === null) return;
  const w = windowOf(S.block);
  const ids = [];
  for (let i = w - 4; i <= w; i++) if (i >= 0) {
    const b = S.batches.get(i);
    if (b && (b.settled || b.cancelled) && b._final) continue; // 终态不再拉
    ids.push(i);
  }
  const res = await Promise.all(ids.map((id) => sbRead('getBatch', [BigInt(id)]).then((b) => [id, b]).catch(() => null)));
  for (const r of res) if (r) { const [id, b] = r; b._final = b.settled || b.cancelled; S.batches.set(id, b); }
  renderPipeline();
}

// ───────────── 账户 / 余额 ─────────────
async function refreshAccount() {
  try {
    if (S.session) {
      const bal = await S.pub.getBalance({ address: S.session.address });
      $('sessionBal').textContent = `${Number(formatEther(bal)).toFixed(4)} MON`;
      S.sessionMon = bal;
    }
    if (!S.owner) { $('sessionAuth').textContent = ''; return; }
    const [fb, fq, sk, wm] = await Promise.all([
      sbRead('freeBase', [S.owner]), sbRead('freeQuote', [S.owner]), sbRead('sessionKey', [S.owner]),
      S.pub.getBalance({ address: S.owner }),
    ]);
    S.freeBase = fb; S.freeQuote = fq;
    $('freeBase').textContent = fmt(fb); $('freeQuote').textContent = fmt(fq, 2);
    $('walMon').textContent = Number(formatEther(wm)).toFixed(3);
    S.myAuth = !!S.session && sk.toLowerCase() === S.session.address.toLowerCase();
    const tag = $('sessionAuth');
    tag.className = 'tag ' + (S.myAuth ? 'ok' : 'bad');
    tag.textContent = S.myAuth ? '已授权' : (sk === ZERO ? '未授权' : '链上授权的是另一个密钥');
    if (cfg.base && cfg.quote) {
      const [wb, wq] = await Promise.all([
        S.pub.readContract({ address: cfg.base, abi: TOKEN_ABI, functionName: 'balanceOf', args: [S.owner] }),
        S.pub.readContract({ address: cfg.quote, abi: TOKEN_ABI, functionName: 'balanceOf', args: [S.owner] }),
      ]);
      $('walBase').textContent = fmt(wb); $('walQuote').textContent = fmt(wq, 2);
    }
    updateOrderHint();
  } catch (e) { log('读取余额失败：' + errMsg(e), 'err'); }
}

// ───────────── 入场 / 取款 ─────────────
$('btnOnboard').onclick = async () => {
  const btn = $('btnOnboard'); btn.disabled = true;
  try {
    if (!S.owner) await connect(true);
    if (!S.owner) return;
    const key = loadSession(true);
    const value = parseEther(String(cfg.onboardGasMON));
    // 换设备/换浏览器：金库已有钱或还在领币冷却期 → 只给本机新会话密钥授权，不重复领币（否则会 Cooldown 失败）
    const last = await S.pub.readContract({ address: cfg.sealBatch, abi: SEALBATCH_ABI, functionName: 'lastFaucet', args: [S.owner] });
    const cooling = last > 0n && BigInt(Math.floor(Date.now() / 1000)) < last + 600n;
    if (cooling || (S.freeBase ?? 0n) > 0n || (S.freeQuote ?? 0n) > 0n) {
      await sendWallet('授权本机会话密钥', cfg.sealBatch, SEALBATCH_ABI, 'setSessionKey', [key.address], value);
    } else {
      await sendWallet('一键入场', cfg.sealBatch, SEALBATCH_ABI, 'onboard', [key.address], value);
    }
    await refreshAccount();
  } catch (e) { log('入场失败：' + errMsg(e), 'err'); toast('入场失败：' + errMsg(e), 'err'); }
  finally { btn.disabled = false; }
};
$('btnWithdraw').onclick = async () => {
  const btn = $('btnWithdraw'); btn.disabled = true;
  try {
    if (!S.owner) await connect(true);
    if (!S.owner) return;
    await refreshAccount();
    if (S.freeBase === 0n && S.freeQuote === 0n) { toast('金库没有可用余额（锁在批次里的部分要先领取）'); return; }
    if (S.freeBase > 0n) await sendWallet('取回 SBA', cfg.sealBatch, SEALBATCH_ABI, 'withdraw', [cfg.base, S.freeBase]);
    if (S.freeQuote > 0n) await sendWallet('取回 SUSD', cfg.sealBatch, SEALBATCH_ABI, 'withdraw', [cfg.quote, S.freeQuote]);
    await refreshAccount();
  } catch (e) { log('取款失败：' + errMsg(e), 'err'); toast('取款失败：' + errMsg(e), 'err'); }
  finally { btn.disabled = false; }
};

// ───────────── 下单 ─────────────
$('sideToggle').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.side = b.dataset.side;
  for (const x of $('sideToggle').children) x.classList.toggle('on', x === b);
  updateOrderHint();
});
$('tickInput').oninput = () => {
  const t = Number($('tickInput').value);
  $('priceLabel').textContent = px(t); $('tickLabel').textContent = `(档位 ${t})`;
  updateOrderHint();
};
$('qtyInput').oninput = updateOrderHint;
function readQty() {
  const s = String($('qtyInput').value || '').trim();
  try { return parseUnits(s, 18); } catch { return 0n; }
}
function ceilMul(q, t) { const p = parseUnits(String(priceOfTick(t)), 18); return (q * p + 10n ** 18n - 1n) / 10n ** 18n; }
function checkOrder() {
  const qty = readQty(); const tick = Number($('tickInput').value);
  if (qty < 10n ** 15n) return { ok: false, msg: '数量至少 0.001 SBA' };
  if (!S.C) return { ok: false, msg: '合约未加载' };
  if (S.freeQuote < S.C.bond) return { ok: false, msg: `金库 SUSD 不足以支付保证金 ${fmt(S.C.bond, 2)}（上一笔订单可能还没领取）` };
  if (S.side === 'buy') {
    const need = ceilMul(qty, tick);
    if (need > S.freeQuote - S.C.bond) return { ok: false, msg: `买入需锁 ${fmt(need, 2)} SUSD，金库可用（扣保证金后）仅 ${fmt(S.freeQuote - S.C.bond, 2)}` };
  } else if (qty > S.freeBase) return { ok: false, msg: `卖出数量超过金库可用 ${fmt(S.freeBase)} SBA` };
  return { ok: true, qty, tick };
}
function updateOrderHint() {
  if (!S.owner) return;
  const c = checkOrder();
  $('orderHint').textContent = c.ok
    ? `将锁定金库全部可用余额（${fmt(S.freeBase)} SBA + ${fmt(S.freeQuote, 2)} SUSD，含保证金 ${fmt(S.C.bond, 2)}），链上只看到一个哈希。`
    : c.msg;
}

async function commitOnce(o) {
  const block = await S.pub.getBlockNumber({ cacheTime: 0 });
  const batchId = windowOf(block);
  const salt = randomSalt();
  const h = commitHash({ encodeAbiParameters, keccak256 }, {
    sealBatch: cfg.sealBatch, chainId: cfg.chainId, batchId, owner: S.owner, isBuy: o.isBuy, qty: o.qty, tick: o.tick, salt,
  });
  const rec = { batchId, isBuy: o.isBuy, qty: o.qty.toString(), tick: o.tick, salt, hash: h, status: 'committing', ts: Date.now() };
  upsertOrder(rec); // 先存盐，防止交易成功但页面关闭
  try {
    const rc = await sendSession(`封单 · 批次 #${batchId}`, 'commit', [S.owner, BigInt(batchId), h]);
    upsertOrder({ batchId, status: 'committed', commitTx: rc.transactionHash });
    return batchId;
  } catch (e) { removeOrder(batchId); throw e; }
}
$('btnCommit').onclick = async () => {
  const btn = $('btnCommit'); btn.disabled = true;
  try {
    if (!S.owner) { await connect(true); if (!S.owner) return; }
    if (!S.session) { toast('请先「一键入场」生成并授权会话密钥', 'err'); return; }
    await refreshAccount();
    if (!S.myAuth) { toast('会话密钥未在链上授权，请先「一键入场」', 'err'); return; }
    if ((S.sessionMon ?? 0n) === 0n) { toast('会话密钥没有 MON 支付 gas', 'err'); return; }
    const c = checkOrder();
    if (!c.ok) { toast(c.msg, 'err'); return; }
    const o = { isBuy: S.side === 'buy', qty: c.qty, tick: c.tick };
    let bid;
    try { bid = await commitOnce(o); }
    catch (e) {
      if (errName(e) !== 'WrongPhase') throw e;
      log('窗口刚好切换，等下一个窗口重试一次…');
      const w0 = windowOf(S.block ?? 0n);
      for (let i = 0; i < 40 && windowOf(await S.pub.getBlockNumber({ cacheTime: 0 })) <= w0; i++) await sleep(300);
      bid = await commitOnce(o);
    }
    toast(`已封单到批次 #${bid}，将自动揭示 / 结算 / 领取`, 'ok');
    S.autoView = false; showBatch(bid);
    refreshAccount(); renderOrders(); renderPipeline();
  } catch (e) { log('封单失败：' + errMsg(e), 'err'); toast('封单失败：' + errMsg(e), 'err'); }
  finally { btn.disabled = false; }
};

// ───────────── 自动 keeper：揭示 → 结算 → 领取 ─────────────
async function keeperTick() {
  if (!S.owner || !S.C) return;
  const list = loadOrders().filter((o) => o.status !== 'done' && o.status !== 'failed');
  for (const o of list) {
    try {
      const bid = BigInt(o.batchId);
      const [ph, ord] = await Promise.all([sbRead('phaseOf', [bid]), sbRead('getOrder', [bid, S.owner])]);
      const committed = ord.commitHash !== '0x' + '0'.repeat(64);
      if (!committed) {
        // 封单交易没上链：窗口过了就标失败
        if (Number(ph) !== 0 && Number(ph) !== 6 && Date.now() - (o.ts || 0) > 15_000) upsertOrder({ batchId: o.batchId, status: 'failed' });
        continue;
      }
      if (o.status === 'committing') upsertOrder({ batchId: o.batchId, status: 'committed' });
      const key = (a) => `${a}:${o.batchId}`;
      const fire = (action, label, fn, args) => {
        if (S.inflight.has(key(action))) return;
        if (!S.session || !S.myAuth && action === 'reveal') return;
        S.inflight.add(key(action));
        sendSession(label, fn, args)
          .catch((e) => {
            // 结算/取消/领取任何人都能做：被 keeper 或别人抢先完成时交易会回滚，属于正常情况，下一轮循环会读到最新状态
            if (['settle', 'cancel', 'claim'].includes(action)) { log(`${label}：已由他人完成（keeper 抢先），无需重复`, 'info'); return; }
            const n = errName(e); if (!['WrongPhase', 'AlreadyRevealed', 'AlreadyClaimed'].includes(n)) log(`${label} 失败：${errMsg(e)}`, 'err');
          })
          .finally(() => setTimeout(() => S.inflight.delete(key(action)), 1500));
      };
      const p = Number(ph);
      if (p === 1 && !ord.revealed) fire('reveal', `自动揭示 · 批次 #${o.batchId}`, 'reveal', [S.owner, bid, o.isBuy, BigInt(o.qty), o.tick, o.salt]);
      else if (p === 2) fire('settle', `自动结算 · 批次 #${o.batchId}`, 'settle', [bid]);
      else if (p === 3) fire('cancel', `超时取消 · 批次 #${o.batchId}`, 'cancel', [bid]);
      else if ((p === 4 || p === 5) && !ord.claimed) fire('claim', `自动领取 · 批次 #${o.batchId}`, 'claim', [S.owner, bid]);
      else if ((p === 4 || p === 5) && ord.claimed) {
        upsertOrder({ batchId: o.batchId, status: 'done' });
        if (S.autoView || S.viewBatch === o.batchId) showBatch(o.batchId);
        refreshAccount();
      }
    } catch (e) { log(`订单 #${o.batchId} 状态读取失败：${errMsg(e)}`, 'err'); }
  }
}

// ───────────── 我的订单 ─────────────
async function renderOrders() {
  const body = $('ordersBody');
  if (!S.owner) { body.innerHTML = '<tr><td colspan="8" class="empty">连接钱包后显示</td></tr>'; return; }
  const list = loadOrders();
  if (!list.length) { body.innerHTML = '<tr><td colspan="8" class="empty">还没有订单</td></tr>'; return; }
  const rows = await Promise.all(list.slice(0, 15).map(async (o) => {
    let v = S.orderView.get(o.batchId);
    if (!v || !v.final) {
      try {
        const bid = BigInt(o.batchId);
        const [ph, ord, fill, prev] = await Promise.all([
          sbRead('phaseOf', [bid]), sbRead('getOrder', [bid, S.owner]), sbRead('fillOf', [bid, S.owner]), sbRead('previewClaim', [bid, S.owner]),
        ]);
        v = { ph: Number(ph), ord, fill, prev, final: ord.claimed };
        S.orderView.set(o.batchId, v);
      } catch { v = v || null; }
    }
    return [o, v];
  }));
  body.innerHTML = rows.map(([o, v]) => {
    const revealed = v?.ord?.revealed;
    const side = revealed ? (o.isBuy ? '<span class="side-buy">买入</span>' : '<span class="side-sell">卖出</span>') : '🔒 已封单';
    let st = o.status === 'failed' ? '未上链' : o.status === 'committing' ? '封单中…' : v ? PHASE_NAME[v.ph] : '…';
    if (v?.ord?.claimed) st = '已领取';
    else if (v && v.ph === 4 && !revealed) st = '已结算（弃标·保证金罚没）';
    const fill = v && v.ph === 4 ? `${fmt(v.fill)} SBA` : '-';
    const prev = v && (v.ph === 4 || v.ph === 5) && !v.ord.claimed ? `${fmt(v.prev[0])} SBA + ${fmt(v.prev[1], 2)} SUSD` : '-';
    const canClaim = v && (v.ph === 4 || v.ph === 5) && !v.ord.claimed && o.status !== 'failed';
    return `<tr><td>#${o.batchId}</td><td>${side}</td><td class="mono">${fmt(o.qty)}</td><td class="mono">${revealed ? px(o.tick) : '🔒'}</td>
      <td>${st}</td><td class="mono">${fill}</td><td class="mono">${prev}</td>
      <td>${canClaim ? `<button class="btn ghost sm" data-claim="${o.batchId}">领取</button>` : ''}
      <button class="btn ghost sm" data-view="${o.batchId}">看板</button></td></tr>`;
  }).join('');
}
$('ordersBody').addEventListener('click', async (e) => {
  const c = e.target.closest('[data-claim]'); const vw = e.target.closest('[data-view]');
  if (vw) { S.autoView = false; showBatch(Number(vw.dataset.view)); return; }
  if (!c) return;
  const bid = BigInt(c.dataset.claim);
  try {
    if (S.sessionWallet) await sendSession(`领取 · 批次 #${bid}`, 'claim', [S.owner, bid]);
    else await sendWallet(`领取 · 批次 #${bid}`, cfg.sealBatch, SEALBATCH_ABI, 'claim', [S.owner, bid]);
    S.orderView.delete(Number(bid)); renderOrders(); refreshAccount();
  } catch (e2) { toast('领取失败：' + errMsg(e2), 'err'); log('领取失败：' + errMsg(e2), 'err'); }
});

// ───────────── 清算看板 ─────────────
async function findLatestSettled() {
  if (!S.C || S.block === null) return null;
  const w = windowOf(S.block);
  for (let i = w - 2; i >= Math.max(0, w - 30); i--) {
    let b = S.batches.get(i);
    if (!b) { try { b = await sbRead('getBatch', [BigInt(i)]); b._final = b.settled || b.cancelled; S.batches.set(i, b); } catch { continue; } }
    if (b.settled && b.commits > 0) return i;
  }
  return null;
}
let showSeq = 0;
async function showBatch(id) {
  if (id == null || id < 0 || !Number.isFinite(id)) return;
  const seq = ++showSeq;
  S.viewBatch = id; $('batchInput').value = id;
  try {
    const bid = BigInt(id);
    const [b, book, ph] = await Promise.all([sbRead('getBatch', [bid]), sbRead('getBook', [bid]), sbRead('phaseOf', [bid])]);
    if (seq !== showSeq) return;
    const [buys, sells] = book;
    const r = clear(buys, sells);
    drawCurve(r, b);
    const unrevealed = Number(b.commits) - Number(b.reveals);
    $('batchStats').innerHTML = [
      ['状态', PHASE_NAME[Number(ph)]], ['封单 / 揭示', `${b.commits} / ${b.reveals}`],
      ['弃标（未揭示）', unrevealed], ['罚金池', `${fmt(b.slashPool, 2)} SUSD`],
    ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')
      + (b.slashPool > 0n ? '<div class="stat wide"><div class="k">罚金将补偿给本批成交者</div></div>' : '');
    const side = (s) => ['无', '买方按比例', '卖方按比例'][Number(s)] ?? s;
    const fields = [
      ['清算价', (x) => (x.volume > 0n ? `${px(x.priceTick)} (档 ${x.priceTick})` : '-'), (x) => (x.volume > 0n ? Number(x.priceTick) : -1)],
      ['成交量', (x) => `${fmt(x.volume, 6)} SBA`, (x) => BigInt(x.volume)],
      ['配给方', (x) => side(x.rationedSide), (x) => Number(x.rationedSide)],
      ['边际档', (x) => (Number(x.rationedSide) ? `档 ${x.marginalTick}` : '-'), (x) => (Number(x.rationedSide) ? Number(x.marginalTick) : -1)],
      ['rNum', (x) => BigInt(x.rNum).toString(), (x) => BigInt(x.rNum)],
      ['rDen', (x) => BigInt(x.rDen).toString(), (x) => BigInt(x.rDen)],
    ];
    let allOk = true;
    $('cmpBody').innerHTML = fields.map(([name, show, key]) => {
      const chainV = b.settled ? show(b) : '未结算';
      const ok = b.settled ? key(b) === key(r) : null;
      if (ok === false) allOk = false;
      return `<tr><td>${name}</td><td>${chainV}</td><td>${show(r)}</td><td>${ok === null ? '·' : ok ? '✅' : '❌'}</td></tr>`;
    }).join('');
    const vd = $('cmpVerdict');
    if (b.settled) { vd.className = 'verdict ' + (allOk ? 'ok' : 'bad'); vd.textContent = allOk ? '✅ 链上结果与浏览器独立复算完全一致' : '❌ 链上结果与复算不一致'; }
    else if (b.cancelled) { vd.className = 'verdict na'; vd.textContent = '本批已取消，锁仓与保证金全额退回'; }
    else { vd.className = 'verdict na'; vd.textContent = '尚未结算：右列为按当前已揭示订单的预测'; }
  } catch (e) { log(`读取批次 #${id} 失败：${errMsg(e)}`, 'err'); }
}
$('bPrev').onclick = () => { S.autoView = false; showBatch((S.viewBatch ?? 1) - 1); };
$('bNext').onclick = () => { S.autoView = false; showBatch((S.viewBatch ?? -1) + 1); };
$('bLatest').onclick = async () => { S.autoView = true; const id = await findLatestSettled(); if (id != null) showBatch(id); else toast('最近 30 批没有已结算且有封单的批次'); };
$('batchInput').onchange = () => { S.autoView = false; showBatch(Number($('batchInput').value)); };

function drawCurve(r, b) {
  const cv = $('curve');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 600, H = cv.clientHeight || 300;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const L = 48, R = 14, T = 14, B = 30;
  const toNum = (x) => Number(formatUnits(x, 18));
  const D = r.D.map(toNum), Sv = r.S.map(toNum);
  const maxY = Math.max(1e-9, ...D, ...Sv) * 1.1;
  const X = (t) => L + (t / (NUM_TICKS - 1)) * (W - L - R);
  const Y = (q) => H - B - (q / maxY) * (H - T - B);
  // 网格
  g.strokeStyle = '#242c3d'; g.fillStyle = '#8a93a6'; g.font = '11px ui-monospace, Menlo, monospace'; g.lineWidth = 1;
  for (let t = 0; t <= 40; t += 4) { g.beginPath(); g.moveTo(X(t), T); g.lineTo(X(t), H - B); g.stroke(); g.fillText(px(t), X(t) - 12, H - 10); }
  for (let i = 0; i <= 4; i++) { const q = (maxY / 4) * i; g.beginPath(); g.moveTo(L, Y(q)); g.lineTo(W - R, Y(q)); g.stroke(); g.fillText(q.toFixed(q < 10 ? 2 : 0), 4, Y(q) + 4); }
  const empty = D[0] === 0 && Sv[NUM_TICKS - 1] === 0;
  if (empty) { g.fillStyle = '#8a93a6'; g.font = '14px sans-serif'; g.fillText('本批没有已揭示的订单', W / 2 - 70, H / 2); return; }
  // 阶梯曲线
  const step = (arr, color) => {
    g.strokeStyle = color; g.lineWidth = 2; g.beginPath();
    for (let t = 0; t < NUM_TICKS; t++) {
      const x0 = X(Math.max(0, t - 0.5)), x1 = X(Math.min(40, t + 0.5));
      if (t === 0) g.moveTo(x0, Y(arr[t])); else g.lineTo(x0, Y(arr[t]));
      g.lineTo(x1, Y(arr[t]));
    }
    g.stroke();
  };
  step(D, '#22c55e'); step(Sv, '#ef4444');
  const res = b?.settled ? b : r;
  if (res.volume > 0n) {
    const cx = X(Number(res.priceTick)), cy = Y(toNum(res.volume));
    g.strokeStyle = '#facc15'; g.setLineDash([4, 4]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx, T); g.lineTo(cx, H - B); g.moveTo(L, cy); g.lineTo(W - R, cy); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#facc15'; g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.fill();
    g.font = '12px sans-serif';
    const label = `${b?.settled ? '清算' : '预测'} ${px(res.priceTick)} · ${toNum(res.volume).toFixed(3)} SBA`;
    g.fillText(label, Math.min(cx + 8, W - R - 160), Math.max(cy - 8, T + 12));
  }
}
window.addEventListener('resize', () => { if (S.viewBatch != null) showBatch(S.viewBatch); });

// ───────────── 定时任务（限流 + 出错退避） ─────────────
function loop(fn, base) {
  let d = base;
  (async () => {
    for (;;) {
      try { await fn(); d = base; } catch (e) { d = Math.min(d * 2, 10_000); log('后台任务出错：' + errMsg(e), 'err'); }
      await sleep(d);
    }
  })();
}

// ───────────── 启动 ─────────────
async function init() {
  await loadConfig();
  $('gasAmt').textContent = cfg.onboardGasMON;
  S.chain = makeChain();
  S.pub = createPublicClient({ chain: S.chain, transport: rpcTransport() });
  $('btnConnect').onclick = () => connect(true);
  $('walletNet').onclick = () => ensureChain().then(() => toast('钱包已切到 Monad 测试网', 'ok')).catch((e) => toast(errMsg(e), 'err'));
  $('btnClearLog').onclick = () => { $('log').innerHTML = ''; };
  loadSession(false);
  if (!isAddress(cfg.sealBatch) || cfg.sealBatch === ZERO) {
    log('未配置 SealBatch 合约地址：请编辑 config.js、放置 deployment.json 或使用 ?sb=0x… 参数', 'err');
    setNet(false); $('netBadge').textContent = '未配置合约地址';
    return;
  }
  // 合约常量
  for (let i = 0; ; i++) {
    try {
      const [genesis, W, timeout, bond, fee, base, quote] = await Promise.all([
        sbRead('genesisBlock'), sbRead('windowBlocks'), sbRead('timeoutWindows'), sbRead('bond'), sbRead('feeBps'),
        cfg.base ? cfg.base : sbRead('base'), cfg.quote ? cfg.quote : sbRead('quote'),
      ]);
      S.C = { genesis, W, timeout, bond, fee };
      cfg.base = base; cfg.quote = quote;
      $('bondAmt').textContent = fmt(bond, 2);
      log(`合约已加载：${short(cfg.sealBatch)} · 每窗口 ${W} 块 · 超时 ${timeout} 窗口 · 手续费 ${fee} bps`, 'ok');
      break;
    } catch (e) {
      setNet(false, errMsg(e));
      await sleep(Math.min(1000 * 2 ** i, 8000));
    }
  }
  pollBlock();
  await connect(false);
  loop(refreshBatches, 2000);
  loop(refreshAccount, 4000);
  loop(keeperTick, 1500);
  loop(async () => { for (const [k, v] of S.orderView) if (!v?.final) S.orderView.delete(k); await renderOrders(); }, 3000);
  loop(async () => {
    if (S.autoView) { const id = await findLatestSettled(); if (id != null && id !== S.viewBatch) showBatch(id); }
    else if (S.viewBatch != null) { const b = S.batches.get(S.viewBatch); if (!b?._final) showBatch(S.viewBatch); }
  }, 3000);
  // 首屏看板
  const first = await findLatestSettled();
  showBatch(first ?? Math.max(0, windowOf(S.block ?? S.C.genesis)));
}
init().catch((e) => log('初始化失败：' + errMsg(e), 'err'));
