import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getRecentPerformanceSamples, connectionUrls } = vi.hoisted(() => ({
  getRecentPerformanceSamples: vi.fn(),
  connectionUrls: [] as string[],
}));

vi.mock('@solana/web3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/web3.js')>()),
  Connection: class {
    constructor(url: string) {
      connectionUrls.push(url);
    }
    getRecentPerformanceSamples = getRecentPerformanceSamples;
  },
}));

import {
  NETWORK_CONDITIONS_TIMEOUT_MS,
  getNetworkConditions,
  median,
  recommend,
} from './market_monitor';

const RPC_URL = 'https://rpc.example.test';
const BLOCK_ENGINE = 'mainnet.block-engine.test';
const fetchMock = vi.fn<typeof fetch>();

/** Сэмпл за 60 с с заданным user TPS (vote-транзакции добавлены для реализма). */
function sampleWithTps(nonVoteTps: number) {
  return {
    slot: 300_000_000,
    numSlots: 150,
    samplePeriodSecs: 60,
    numTransactions: nonVoteTps * 60 + 180_000,
    numNonVoteTransactions: nonVoteTps * 60,
  };
}

/** Ответ getInflightBundleStatuses: `pending` бандлов Pending, остальные Landed. */
function inflight(ids: string[], pending: number): Response {
  return Response.json({
    jsonrpc: '2.0',
    id: 1,
    result: {
      context: { slot: 1 },
      value: ids.map((bundle_id, i) => ({
        bundle_id,
        status: i < pending ? 'Pending' : 'Landed',
        landed_slot: i < pending ? null : 1,
      })),
    },
  });
}

function ids(count: number, prefix = 'b'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

/** Jito-заглушка: все переданные бандлы — Pending. */
function allPending(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const [batch] = JSON.parse(String(init?.body)).params as [string[]];
  return Promise.resolve(inflight(batch, batch.length));
}

beforeEach(() => {
  getRecentPerformanceSamples.mockReset();
  connectionUrls.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('getNetworkConditions', () => {
  it('активная сеть и короткая очередь → go', async () => {
    getRecentPerformanceSamples.mockResolvedValue([sampleWithTps(1_500)]);
    fetchMock.mockResolvedValue(inflight(ids(5), 3));

    const result = await getNetworkConditions(RPC_URL, BLOCK_ENGINE, [10_000, 30_000, 20_000], ids(5));

    expect(result).toMatchObject({
      activeTransactions: 1_500,
      jitoQueueLength: 3,
      medianTipLamports: 20_000,
      recommendation: 'go',
    });
    expect(connectionUrls).toEqual([RPC_URL]);
    expect(getRecentPerformanceSamples).toHaveBeenCalledWith(1);
  });

  it('активность ниже 1000 TPS → wait', async () => {
    getRecentPerformanceSamples.mockResolvedValue([sampleWithTps(400)]);
    fetchMock.mockResolvedValue(inflight(ids(5), 2));

    const result = await getNetworkConditions(RPC_URL, BLOCK_ENGINE, [], ids(5));

    expect(result.activeTransactions).toBe(400);
    expect(result.recommendation).toBe('wait');
  });

  it('очередь больше 50 → stop, даже при высокой активности', async () => {
    getRecentPerformanceSamples.mockResolvedValue([sampleWithTps(5_000)]);
    fetchMock.mockImplementation(allPending);

    const result = await getNetworkConditions(RPC_URL, BLOCK_ENGINE, [], ids(55));

    expect(result.jitoQueueLength).toBe(55);
    expect(result.recommendation).toBe('stop');
  });

  it('спрашивает Jito пачками по 5 и считает только Pending', async () => {
    getRecentPerformanceSamples.mockResolvedValue([sampleWithTps(1_500)]);
    fetchMock.mockImplementation(allPending);

    const bundleIds = [...ids(12), 'b0', 'b1']; // дубликаты не считаются дважды
    const result = await getNetworkConditions(RPC_URL, BLOCK_ENGINE, undefined, bundleIds);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mainnet.block-engine.test/api/v1/getInflightBundleStatuses');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: 'getInflightBundleStatuses',
      params: [['b0', 'b1', 'b2', 'b3', 'b4']],
    });
    expect(result.jitoQueueLength).toBe(12);
  });

  it('без bundleIds не ходит в Jito, очередь = 0', async () => {
    getRecentPerformanceSamples.mockResolvedValue([sampleWithTps(1_500)]);

    const result = await getNetworkConditions(RPC_URL, BLOCK_ENGINE);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ jitoQueueLength: 0, medianTipLamports: 0, recommendation: 'go' });
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('узел без numNonVoteTransactions → считает по всем транзакциям', async () => {
    getRecentPerformanceSamples.mockResolvedValue([
      { slot: 1, numSlots: 150, samplePeriodSecs: 60, numTransactions: 120_000 },
    ]);

    const result = await getNetworkConditions(RPC_URL, BLOCK_ENGINE);

    expect(result.activeTransactions).toBe(2_000);
  });

  it('пустой ответ RPC → throw', async () => {
    getRecentPerformanceSamples.mockResolvedValue([]);

    await expect(getNetworkConditions(RPC_URL, BLOCK_ENGINE)).rejects.toThrow(/сэмпл/);
  });

  it('ошибка Jito → throw', async () => {
    getRecentPerformanceSamples.mockResolvedValue([sampleWithTps(1_500)]);
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));

    await expect(getNetworkConditions(RPC_URL, BLOCK_ENGINE, [], ids(1))).rejects.toThrow(/HTTP 429/);
  });

  it('таймаут 10 с → throw и отмена запроса к Jito', async () => {
    vi.useFakeTimers();
    getRecentPerformanceSamples.mockResolvedValue([sampleWithTps(1_500)]);
    let aborted = false;
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );

    const promise = getNetworkConditions(RPC_URL, BLOCK_ENGINE, [], ids(1));
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(NETWORK_CONDITIONS_TIMEOUT_MS);

    await expect(promise).rejects.toThrow(/10 с/);
    expect(aborted).toBe(true);
  });
});

describe('recommend', () => {
  it('границы порогов', () => {
    expect(recommend(1_001, 19)).toBe('go');
    expect(recommend(1_000, 0)).toBe('wait'); // нужно строго больше 1000
    expect(recommend(5_000, 20)).toBe('wait'); // нужно строго меньше 20
    expect(recommend(5_000, 49)).toBe('wait');
    expect(recommend(5_000, 50)).toBe('stop');
  });
});

describe('median', () => {
  it('реэкспорт из tip_strategy', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});
