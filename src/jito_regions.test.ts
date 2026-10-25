import {
  Keypair,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_JITO_REGIONS,
  JitoRegion,
  MULTI_REGION_TIMEOUT_MS,
  submitBundleMultiRegion,
} from './jito_regions';

const TIP_ACCOUNTS = [Keypair.generate().publicKey.toBase58()];
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const TIP_LAMPORTS = 10_000;

interface RegionBehavior {
  bundleId?: string;
  /** Задержка ответа sendBundle, мс. */
  delayMs?: number;
  /** Если задано — sendBundle возвращает JSON-RPC ошибку. */
  fail?: string;
  /** Запрос не завершается, пока его не отменят через AbortSignal. */
  hang?: boolean;
}

interface RpcRequest {
  host: string;
  path: string;
  method: string;
  params: unknown[];
}

let behaviors: Record<string, RegionBehavior>;
let requests: RpcRequest[];
const fetchMock = vi.fn(mockFetch);

async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const { method, params } = JSON.parse(String(init?.body)) as {
    method: string;
    params: unknown[];
  };
  requests.push({ host: url.host, path: url.pathname, method, params });

  const behavior = behaviors[url.host] ?? {};
  if (method === 'getTipAccounts') {
    return rpcResult(TIP_ACCOUNTS);
  }

  if (behavior.hang) {
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
  await new Promise((resolve) => setTimeout(resolve, behavior.delayMs ?? 0));
  if (behavior.fail) {
    return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: behavior.fail } });
  }
  return rpcResult(behavior.bundleId ?? `bundle-${url.host}`);
}

function rpcResult(result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id: 1, result });
}

function region(id: string, enabled = true): JitoRegion {
  return { id, url: `${id}.block-engine.test`, enabled };
}

function signedTransaction(): VersionedTransaction {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [],
        data: Buffer.alloc(0),
      }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return tx;
}

/** Запускает отправку и прокручивает фейковые таймеры до её завершения. */
async function submit(regions: JitoRegion[], advanceMs = 1_000) {
  const log = vi.fn();
  const promise = submitBundleMultiRegion(
    [signedTransaction()],
    regions,
    { tipPayer: Keypair.generate(), tipLamports: TIP_LAMPORTS, recentBlockhash: BLOCKHASH },
    log,
  );
  // Чтобы проверка ошибки не считалась необработанным отказом до expect.
  promise.catch(() => {});
  await vi.advanceTimersByTimeAsync(advanceMs);
  return { promise, log };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  behaviors = {};
  requests = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('submitBundleMultiRegion', () => {
  it('возвращает регион, ответивший первым, когда отвечают оба', async () => {
    const [fast, slow] = [region('fast'), region('slow')];
    behaviors[slow.url] = { bundleId: 'bundle-slow', delayMs: 200 };
    behaviors[fast.url] = { bundleId: 'bundle-fast', delayMs: 50 };

    // Медленный регион идёт первым в списке — побеждает всё равно быстрый.
    const { promise, log } = await submit([slow, fast]);

    await expect(promise).resolves.toEqual({
      bundleId: 'bundle-fast',
      region: 'fast',
      tipAccount: TIP_ACCOUNTS[0],
    });
    expect(log).toHaveBeenCalledWith('success', expect.stringContaining('bundle-fast'));
  });

  it('возвращает второй регион, если первый упал', async () => {
    const [broken, healthy] = [region('broken'), region('healthy')];
    behaviors[broken.url] = { fail: 'bundle rejected', delayMs: 10 };
    behaviors[healthy.url] = { bundleId: 'bundle-healthy', delayMs: 100 };

    const { promise, log } = await submit([broken, healthy]);

    await expect(promise).resolves.toMatchObject({
      bundleId: 'bundle-healthy',
      region: 'healthy',
    });
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('[broken]'));
    expect(log).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('бросает ошибку, если упали все регионы', async () => {
    const regions = [region('a'), region('b')];
    behaviors[regions[0].url] = { fail: 'rate limited' };
    behaviors[regions[1].url] = { fail: 'invalid bundle' };

    const { promise, log } = await submit(regions);

    await expect(promise).rejects.toThrow(/Все регионы.*rate limited.*invalid bundle/);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('[a]'));
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('[b]'));
    expect(log).toHaveBeenCalledWith('error', expect.any(String));
  });

  it('отправляет бандл только в включённые регионы', async () => {
    const { promise } = await submit(DEFAULT_JITO_REGIONS);
    await promise;

    const enabledHosts = DEFAULT_JITO_REGIONS.filter((r) => r.enabled).map((r) => r.url);
    const hosts = new Set(requests.map((r) => r.host));
    expect([...hosts].sort()).toEqual([...enabledHosts].sort());
    expect(hosts).not.toContain('tokyo.mainnet.block-engine.jito.wtf');
    expect(hosts).not.toContain('ny.mainnet.block-engine.jito.wtf');
  });

  it('сначала запрашивает tip-аккаунты, затем шлёт бандл с tip-транзакцией в конце', async () => {
    const target = region('only');
    const { promise } = await submit([target]);
    await promise;

    expect(requests.map((r) => `${r.path} ${r.method}`)).toEqual([
      '/api/v1/getTipAccounts getTipAccounts',
      '/api/v1/bundles sendBundle',
    ]);

    const [encoded, config] = requests[1].params as [string[], { encoding: string }];
    expect(config).toEqual({ encoding: 'base64' });
    expect(encoded).toHaveLength(2);

    const tipTx = VersionedTransaction.deserialize(Buffer.from(encoded[1], 'base64'));
    const { staticAccountKeys, compiledInstructions } = tipTx.message;
    const [ix] = compiledInstructions;
    const transfer = SystemInstruction.decodeTransfer(
      new TransactionInstruction({
        programId: staticAccountKeys[ix.programIdIndex],
        keys: ix.accountKeyIndexes.map((i) => ({
          pubkey: staticAccountKeys[i],
          isSigner: tipTx.message.isAccountSigner(i),
          isWritable: tipTx.message.isAccountWritable(i),
        })),
        data: Buffer.from(ix.data),
      }),
    );
    expect(transfer.toPubkey.toBase58()).toBe(TIP_ACCOUNTS[0]);
    expect(transfer.lamports).toBe(BigInt(TIP_LAMPORTS));
    expect(tipTx.message.recentBlockhash).toBe(BLOCKHASH);
  });

  it('бросает ошибку по общему таймауту 30 с', async () => {
    const regions = [region('a'), region('b')];
    behaviors[regions[0].url] = { hang: true };
    behaviors[regions[1].url] = { hang: true };

    const { promise } = await submit(regions, MULTI_REGION_TIMEOUT_MS);

    await expect(promise).rejects.toThrow(/30 с/);
  });

  it('бросает ошибку, если нет включённых регионов', async () => {
    const { promise } = await submit([region('off', false)]);

    await expect(promise).rejects.toThrow(/Нет включённых регионов/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
