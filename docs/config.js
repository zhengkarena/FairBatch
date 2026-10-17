// 部署后把地址填进来；也可用 URL 参数覆盖：
//   ?rpc=http://127.0.0.1:8546&chain=31337&sb=0x...&base=0x...&quote=0x...&explorer=&gas=0.2
// base / quote 留空时会自动从 SealBatch.base() / quote() 读取。
export const CONFIG = {
  chainId: 10143,
  chainName: 'Monad Testnet',
  rpcUrl: 'https://testnet-rpc.monad.xyz',
  // 主 RPC 失败/限流时自动切换（现场大家共用官方 RPC，容易被限流）
  fallbackRpcs: ['https://rpc.ankr.com/monad_testnet', 'https://monad-testnet.drpc.org', 'https://rpc-testnet.monadinfra.com', 'https://10143.rpc.thirdweb.com'],
  explorer: 'https://testnet.monadexplorer.com',
  sealBatch: '0x19680bFf57Ff85C64dAC9cd5Ae3884282f574b60',
  base: '',
  quote: '',
  onboardGasMON: '0.5', // 入场时转给会话密钥的 MON
};
