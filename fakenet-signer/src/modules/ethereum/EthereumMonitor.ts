import { ethers } from 'ethers';
// The EVM output decoding comes from the signet protocol library, the same
// schema-driven ABI decode clients run to recompute the respond bytes.
import { deserializeEvmOutput } from '@sig-net/midnight';
import {
  TransactionOutput,
  TransactionStatus,
  ServerConfig,
} from '../../types';
import { getNamespaceFromCaip2 } from '../ChainUtils';

// Give up on a confirmed tx after this many consecutive output-extraction
// failures: the source chain then gets an error response instead of the
// request hanging forever on a permanently-failing trace.
const MAX_EXTRACTION_FAILURES = 5;

export class EthereumMonitor {
  private static providerCache = new Map<string, ethers.JsonRpcProvider>();
  // Consecutive extractTransactionOutput failures per tx hash.
  private static extractionFailureCounts = new Map<string, number>();

  /**
   * Whether an RPC error means the method itself is missing or unsupported
   * (JSON-RPC -32601 or a provider's equivalent), as opposed to a transient
   * or per-transaction failure.
   */
  private static isMethodNotSupportedError(error: unknown): boolean {
    const e = error as {
      code?: unknown;
      message?: unknown;
      error?: { code?: unknown; message?: unknown };
      info?: { error?: { code?: unknown; message?: unknown } };
    };
    const codes = [e?.code, e?.error?.code, e?.info?.error?.code];
    if (codes.includes(-32601) || codes.includes('UNSUPPORTED_OPERATION')) {
      return true;
    }
    const messages = [e?.message, e?.error?.message, e?.info?.error?.message]
      .filter((m): m is string => typeof m === 'string')
      .join(' ');
    return /method not found|method not supported|does not exist|is not available|unsupported method/i.test(
      messages
    );
  }

  static async waitForTransactionAndGetOutput(
    txHash: string,
    caip2Id: string,
    outputDeserializationSchema: Buffer | number[],
    fromAddress: string,
    nonce: number,
    config: ServerConfig
  ): Promise<TransactionStatus> {
    let provider: ethers.JsonRpcProvider;

    try {
      provider = this.getProvider(caip2Id, config);
    } catch {
      return { status: 'fatal_error', reason: 'unsupported_chain' };
    }

    try {
      const receipt = await provider.getTransactionReceipt(txHash);

      if (receipt) {
        if (receipt.status === 0) {
          console.log(
            `❌ EthereumMonitor: tx ${txHash} reverted (block=${receipt.blockNumber})`
          );
          return { status: 'error', reason: 'reverted' };
        }

        const tx = await provider.getTransaction(txHash);
        if (!tx) {
          return { status: 'pending' };
        }

        try {
          const { output, rawOutput } = await this.extractTransactionOutput(
            tx,
            receipt,
            provider,
            outputDeserializationSchema
          );
          this.extractionFailureCounts.delete(txHash);
          console.log(
            `✅ EthereumMonitor: tx ${txHash} confirmed (block=${receipt.blockNumber})`
          );

          // Checkpoint 2 (post-deserialisation): 'output' here must match
          // 'transaction_output' in build_serialized_output at
          // github.com/sig-net/mpc/chain-signatures/chain-ethereum/src/respond_bidirectional.rs:122
          // (built by TransactionOutput::from_call_result): the raw return
          // bytes already ABI-decoded per the output deserialization schema,
          // or the synthesized non-contract-call default.

          return {
            status: 'success',
            success: output.success,
            output: output.output,
            rawOutput,
          };
        } catch (error) {
          // A missing debug_traceTransaction can never heal by retrying:
          // fail the request immediately so the source chain gets an error
          // response instead of an endless pending loop.
          if (this.isMethodNotSupportedError(error)) {
            this.extractionFailureCounts.delete(txHash);
            console.error(
              `EthereumMonitor: the EVM RPC configured via EVM_RPC_URL does not support debug_traceTransaction with the callTracer, so the mined call's output cannot be extracted for ${txHash}. Point EVM_RPC_URL at a node with the debug namespace enabled, e.g. a local anvil/geth/reth dev node or a provider plan that includes trace methods.`,
              error
            );
            return {
              status: 'fatal_error',
              reason: 'debug_trace_not_supported',
            };
          }

          // On a transient extraction failure the MPC emits no event and the
          // execution watcher retries on the next block
          // (execution_confirmed_event returns None,
          // chain-ethereum/src/indexer.rs:332). Report pending so the poll
          // loop retries, but cap the consecutive failures so a permanently
          // failing extraction eventually produces an error response instead
          // of hanging the request forever.
          const failures = (this.extractionFailureCounts.get(txHash) ?? 0) + 1;
          if (failures >= MAX_EXTRACTION_FAILURES) {
            this.extractionFailureCounts.delete(txHash);
            console.error(
              `EthereumMonitor: output extraction failed ${failures} times for ${txHash}, giving up`,
              error
            );
            return { status: 'fatal_error', reason: 'extraction_failed' };
          }
          this.extractionFailureCounts.set(txHash, failures);
          console.error(
            `EthereumMonitor: output extraction failed for ${txHash} (attempt ${failures}/${MAX_EXTRACTION_FAILURES}), will retry`,
            error
          );
          return { status: 'pending' };
        }
      } else {
        // No receipt - check if replaced
        const currentNonce = await provider.getTransactionCount(fromAddress);
        if (currentNonce > nonce) {
          const receiptCheck = await provider.getTransactionReceipt(txHash);
          if (!receiptCheck) {
            console.log(
              `❌ EthereumMonitor: tx ${txHash} replaced (nonce=${nonce} already used)`
            );
            return { status: 'error', reason: 'replaced' };
          }
        }

        const tx = await provider.getTransaction(txHash);
        if (!tx) {
          return { status: 'pending' };
        }

        return { status: 'pending' };
      }
    } catch {
      return { status: 'pending' };
    }
  }

  private static getProvider(
    caip2Id: string,
    config: ServerConfig
  ): ethers.JsonRpcProvider {
    const namespace = getNamespaceFromCaip2(caip2Id);
    const cacheKey = caip2Id;

    const cachedProvider = this.providerCache.get(cacheKey);
    if (cachedProvider) {
      return cachedProvider;
    }

    let url: string;
    switch (namespace) {
      case 'eip155':
        url = config.evmRpcUrl;
        break;
      default:
        throw new Error(`Unsupported chain namespace: ${namespace}`);
    }

    const fetchRequest = new ethers.FetchRequest(url);
    fetchRequest.timeout = 30_000;
    const provider = new ethers.JsonRpcProvider(fetchRequest);
    this.providerCache.set(cacheKey, provider);
    return provider;
  }

  /**
   * The top call frame of the mined transaction, read with the SAME RPC
   * method the real MPC uses (debug_traceTransaction with the callTracer,
   * top call only, github.com/sig-net/mpc
   * chain-signatures/chain-ethereum/src/indexer.rs). The frame's `output`
   * is the call's actual return data as mined (absent for a plain
   * transfer).
   */
  private static async traceTopCallOutput(
    txHash: string,
    provider: ethers.JsonRpcProvider
  ): Promise<string> {
    const callFrame = (await provider.send('debug_traceTransaction', [
      txHash,
      {
        tracer: 'callTracer',
        tracerConfig: {
          onlyTopCall: true,
        },
        timeout: '5s',
      },
    ])) as { output?: string };
    return callFrame?.output ?? '0x';
  }

  /**
   * LOCAL PATCH (project 00034, Q62 Option C). The mined call's return data
   * when the RPC has no debug namespace (e.g. Alchemy's free tier rejects
   * debug_traceTransaction): replay the mined transaction with eth_call
   * (same from/to/data/value) against the state at the mined block's
   * PARENT and take its return data. The receipt's status is the
   * authoritative success flag and is checked by the caller first.
   *
   * Demo-grade caveat: this is NOT byte-identical to the MPC's method. An
   * eth_call replay reads pre-block state, so a call whose result depends
   * on writes earlier in the same block (or on the exact position in the
   * block) can return different data than the mined trace would. For a
   * single ERC20 transfer from an address nothing else touches the two
   * agree. Prefer a traced RPC when one exists: the trace path stays the
   * first choice and this code is never reached on anvil/geth/reth.
   */
  private static async replayCallOutput(
    tx: ethers.TransactionResponse,
    receipt: ethers.TransactionReceipt,
    provider: ethers.JsonRpcProvider
  ): Promise<string> {
    if (receipt.status !== 1) {
      // The caller already reports a status-0 receipt as 'reverted' before
      // asking for the output; keep the same verdict here rather than
      // fabricating return data for a failed call.
      throw new Error(
        `eth_call replay fallback: tx ${tx.hash} has receipt status ${String(
          receipt.status
        )} (reverted), no return data to recover`
      );
    }
    const blockTag = receipt.blockNumber - 1;
    console.warn(
      `⚠️  EthereumMonitor: EVM_RPC_URL does not support debug_traceTransaction; recovering the output of ${tx.hash} by eth_call replay at block ${blockTag} (parent of ${receipt.blockNumber}). Local 00034 patch, demo-grade: reads pre-block state, not the mined trace.`
    );
    return provider.call({
      from: tx.from,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      blockTag,
    });
  }

  /**
   * The top call's return data: the MPC's trace first, the eth_call replay
   * only when the RPC reports that debug_traceTransaction itself is
   * missing or unsupported. Any other trace failure is rethrown unchanged
   * so the caller's retry/cap logic is untouched.
   */
  private static async topCallOutput(
    tx: ethers.TransactionResponse,
    receipt: ethers.TransactionReceipt,
    provider: ethers.JsonRpcProvider
  ): Promise<string> {
    try {
      return await this.traceTopCallOutput(tx.hash, provider);
    } catch (error) {
      if (!this.isMethodNotSupportedError(error)) {
        throw error;
      }
      return this.replayCallOutput(tx, receipt, provider);
    }
  }

  private static async extractTransactionOutput(
    tx: ethers.TransactionResponse,
    receipt: ethers.TransactionReceipt,
    provider: ethers.JsonRpcProvider,
    outputDeserializationSchema: Buffer | number[]
  ): Promise<{ output: TransactionOutput; rawOutput: string }> {
    // Contract call = calldata longer than 2 bytes, matching is_contract_call
    // in github.com/sig-net/mpc/chain-signatures/chain-ethereum/src/event_parsing.rs:19
    const isContractCall = ethers.dataLength(tx.data) > 2;

    // Checkpoint 1 (pre-deserialisation): 'rawOutput' must match the raw
    // 'trace_output' bytes in
    // github.com/sig-net/mpc/chain-signatures/chain-ethereum/src/indexer.rs:280.
    // Same method as the MPC (debug_traceTransaction, callTracer, top call
    // only), so this is the mined call's ACTUAL return data. Local 00034
    // patch: when the RPC lacks debug_traceTransaction, fall back to an
    // eth_call replay of the mined tx (see replayCallOutput for the caveat).
    const rawOutput = await this.topCallOutput(tx, receipt, provider);

    // This is the Ethereum monitor, so the output deserialisation format is
    // always ABI: the MPC hardcodes it as OUTPUT_DESERIALIZATION_FORMAT in
    // github.com/sig-net/mpc/chain-signatures/chain-ethereum/src/respond_bidirectional.rs:10
    // and its decode gate is `SerDeserFormat::Abi if is_contract_call`
    // (respond_bidirectional.rs:122), which reduces to just is_contract_call.
    if (isContractCall) {
      // Schema-driven ABI decode via the signet library (mirrors the MPC's
      // delegation to alloy). Accepts the raw NUL-padded on-chain schema
      // bytes and throws on an empty/malformed schema, which the caller
      // reports as pending so the poll loop retries.
      const decodedOutput = deserializeEvmOutput(
        Uint8Array.from(outputDeserializationSchema),
        rawOutput
      );

      return { output: { success: true, output: decodedOutput }, rawOutput };
    } else {
      return {
        output: {
          success: true,
          output: {
            success: true,
            isFunctionCall: false,
          },
        },
        rawOutput,
      };
    }
  }
}
