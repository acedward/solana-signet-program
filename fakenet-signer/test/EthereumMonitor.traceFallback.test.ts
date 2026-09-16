// Unit test for the local 00034 patch (Q62 Option C): when the EVM RPC
// rejects debug_traceTransaction as unsupported, EthereumMonitor recovers
// the mined call's return data by an eth_call replay at the parent block.
// No RPC is contacted: the provider is a hand-rolled fake.
//
//   yarn workspace fakenet-signer test:trace-fallback
import assert from 'node:assert/strict';
import { EthereumMonitor } from '../src/modules/ethereum/EthereumMonitor';

// The on-chain schema is the JSON schema's bytes (NUL padding tolerated).
const SCHEMA = Buffer.from(
  JSON.stringify([{ name: 'success', type: 'bool' }]),
  'utf8'
);
const TRUE_WORD =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const tx = {
  hash: '0x' + 'ab'.repeat(32),
  from: '0x484738a67858305eDfC139B194ed430fe4d8e56b',
  to: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  data: '0xa9059cbb' + '00'.repeat(64),
  value: 0n,
};
const okReceipt = { status: 1, blockNumber: 11_717_606 };
const revertedReceipt = { status: 0, blockNumber: 11_717_606 };

type Fake = {
  send: (method: string, params: unknown[]) => Promise<unknown>;
  call: (req: Record<string, unknown>) => Promise<string>;
  sends: string[];
  calls: Record<string, unknown>[];
};

function fakeProvider(opts: {
  trace: 'ok' | Error;
  callResult?: string | Error;
}): Fake {
  const p: Fake = {
    sends: [],
    calls: [],
    async send(method) {
      p.sends.push(method);
      if (method !== 'debug_traceTransaction') {
        throw new Error(`unexpected send ${method}`);
      }
      if (opts.trace instanceof Error) throw opts.trace;
      return { output: TRUE_WORD };
    },
    async call(req) {
      p.calls.push(req);
      if (opts.callResult instanceof Error) throw opts.callResult;
      return opts.callResult ?? TRUE_WORD;
    },
  };
  return p;
}

// Private static; reached the way the monitor's own poll loop reaches it.
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

function rpcError(code: number | string, message: string): Error {
  // ethers v6 wraps a JSON-RPC error it cannot coalesce as
  // { code: 'UNKNOWN_ERROR', error: { code, message } }.
  const e = new Error('could not coalesce error') as Error & {
    code: string;
    error: { code: number | string; message: string };
  };
  e.code = 'UNKNOWN_ERROR';
  e.error = { code, message };
  return e;
}

const cases: Array<[string, () => Promise<void>]> = [
  [
    'trace available: trace output is used, eth_call is never made',
    async () => {
      const p = fakeProvider({ trace: 'ok', callResult: '0x' });
      const r = await extract(tx, okReceipt, p, SCHEMA);
      assert.equal(r.rawOutput, TRUE_WORD);
      assert.deepEqual(p.sends, ['debug_traceTransaction']);
      assert.equal(p.calls.length, 0);
      assert.equal(r.output.success, true);
    },
  ],
  [
    'trace rejected -32601: eth_call replay at parent block, same from/to/data/value',
    async () => {
      const p = fakeProvider({
        trace: rpcError(
          -32601,
          'the method debug_traceTransaction does not exist/is not available'
        ),
      });
      const r = await extract(tx, okReceipt, p, SCHEMA);
      assert.deepEqual(p.sends, ['debug_traceTransaction']);
      assert.equal(p.calls.length, 1);
      assert.deepEqual(p.calls[0], {
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        blockTag: okReceipt.blockNumber - 1,
      });
      assert.equal(r.rawOutput, TRUE_WORD);
      assert.equal(r.output.success, true);
      assert.deepEqual(r.output.output, { success: true });
    },
  ],
  [
    'trace rejected the Alchemy way (-32600 "is not available on the Free tier"): replay is used',
    async () => {
      const p = fakeProvider({
        trace: rpcError(
          -32600,
          'debug_traceTransaction is not available on the Free tier - upgrade to Pay As You Go, or Enterprise for access.'
        ),
      });
      const r = await extract(tx, okReceipt, p, SCHEMA);
      assert.equal(p.calls.length, 1);
      assert.equal(r.rawOutput, TRUE_WORD);
    },
  ],
  [
    'trace rejected but receipt status 0: no replay, throws as reverted',
    async () => {
      const p = fakeProvider({ trace: rpcError(-32601, 'method not found') });
      await assert.rejects(extract(tx, revertedReceipt, p, SCHEMA), /reverted/);
      assert.equal(p.calls.length, 0);
    },
  ],
  [
    'other trace failure (timeout): rethrown unchanged, no replay',
    async () => {
      const boom = new Error('execution timeout');
      const p = fakeProvider({ trace: boom });
      await assert.rejects(
        extract(tx, okReceipt, p, SCHEMA),
        (e) => e === boom
      );
      assert.equal(p.calls.length, 0);
    },
  ],
  [
    'plain value transfer with trace unsupported: replay runs, non-call default output',
    async () => {
      const p = fakeProvider({
        trace: rpcError(-32601, 'method not found'),
        callResult: '0x',
      });
      const r = await extract({ ...tx, data: '0x' }, okReceipt, p, SCHEMA);
      assert.equal(r.rawOutput, '0x');
      assert.deepEqual(r.output.output, {
        success: true,
        isFunctionCall: false,
      });
    },
  ],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(e);
  }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
