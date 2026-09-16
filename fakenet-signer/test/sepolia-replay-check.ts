// Read-only check of the 00034 trace fallback against REAL Sepolia through
// an RPC without debug_traceTransaction (Alchemy free tier). Sends nothing.
//
//   SEPOLIA_RPC_URL=... yarn workspace fakenet-signer test:sepolia-replay [txHash]
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { EthereumMonitor } from '../src/modules/ethereum/EthereumMonitor';

const url = process.env.SEPOLIA_RPC_URL;
if (!url) throw new Error('SEPOLIA_RPC_URL is not set');
const txHash =
  process.argv[2] ??
  '0xa1d8215aa22bbbb6aed918a37fa703136408ed956c26382c5f933ff841e9a20e';
const SCHEMA = Buffer.from(
  JSON.stringify([{ name: 'success', type: 'bool' }]),
  'utf8'
);

const req = new ethers.FetchRequest(url);
req.timeout = 30_000;
const provider = new ethers.JsonRpcProvider(req, undefined, {
  staticNetwork: true,
});
// Count the RPC methods the monitor sends so the report shows the trace
// was tried first and replaced by exactly one eth_call.
const rpcMethods: string[] = [];
const origSend = provider.send.bind(provider);
provider.send = (async (method: string, params: unknown[]) => {
  rpcMethods.push(method);
  return origSend(method, params);
}) as typeof provider.send;

const [tx, receipt] = await Promise.all([
  provider.getTransaction(txHash),
  provider.getTransactionReceipt(txHash),
]);
assert.ok(tx && receipt, 'tx/receipt not found');
console.log(`chainId=${(await provider.getNetwork()).chainId} tx=${txHash}`);
console.log(`from=${tx.from} to=${tx.to} value=${tx.value} data=${tx.data}`);
console.log(`receipt.status=${receipt.status} block=${receipt.blockNumber}`);

const extract = (
  EthereumMonitor as unknown as {
    extractTransactionOutput: (
      tx: unknown,
      receipt: unknown,
      provider: unknown,
      schema: Buffer
    ) => Promise<{
      output: { success: boolean; output: unknown };
      rawOutput: string;
    }>;
  }
).extractTransactionOutput.bind(EthereumMonitor);

const r = await extract(tx, receipt, provider, SCHEMA);
console.log(`rpc methods sent by the monitor: ${rpcMethods.join(', ')}`);
console.log(`rawOutput=${r.rawOutput}`);
console.log(`decoded=${JSON.stringify(r.output)}`);
assert.equal(r.output.success, true);
assert.deepEqual(r.output.output, { success: true });
console.log(
  'OK: recovered output decodes to success=true with schema [{"name":"success","type":"bool"}]'
);
provider.destroy();
