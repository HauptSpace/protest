import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlockhashWatcher } from './blockhash_ws';
import { JitoRegion } from './jito_regions';
import { RETRY_DELAY_MS, RetryConfig, submitBundleWithRetry } from './submit_with_retry';
import { TipStrategy } from './tip_strategy';

type SubmitFn = Parameters<typeof submitBundleWithRetry>[7];
type CalcTipFn = Parameters<typeof submitBundleWithRetry>[8];

const BASE_TIP = 1_000_000;
const INITIAL_BLOCKHASH = 'InitialHash';
const STRATEGY: TipStrategy = { type: 'auto', percentile: 75 };
const REGIONS: JitoRegion[] = [
  { id: 'mainnet', url: 'mainnet.test', enabled: true },
  { id: 'tokyo', url: 'tokyo.test', enabled: false },
];
const TRANSACTIONS = [] as VersionedTransaction[];
const tipPayer = Keypair.generate();

const submitFn = vi.fn<SubmitFn>();
const calcTipFn = vi.fn<CalcTipFn>();
const log = vi.fn();
let watcher: BlockhashWatcher;

function config(overrides: Partial<RetryConfig> = {}): RetryConfig {
  return {
    maxRetries: 3,
    tipIncreasePercent: 20,
    blockhashRefresh: true,
    regionFallback: false,
    ...overrides,
  };
}

function landed(region = 'mainnet') {
  return { bundleId: `bundle-${region}`, region, tipAccount: 'TipAccount1' };
}

/** Запускает отправку и прокручивает все паузы между попытками. */
async function run(retry: RetryConfig) {
  const promise = submitBundleWithRetry(
    TRANSACTIONS,
    REGIONS,
    STRATEGY,
    retry,
    watcher,
    tipPayer,
    INITIAL_BLOCKHASH,
    submitFn,
    calcTipFn,
    log,
  );
  promise.catch(() => {});
  await vi.runAllTimersAsync();
  return promise;
}

function submitted(call: number) {
  const [, regions, opts] = submitFn.mock.calls[call];
  return { regions, ...opts };
}

beforeEach(() => {
  vi.useFakeTimers();
  submitFn.mockReset();
  calcTipFn.mockReset().mockResolvedValue(BASE_TIP);
  log.mockReset();
  // Без start() watcher в сеть не ходит — подменяем только getCurrent.
  watcher = new BlockhashWatcher('https://rpc.example.test');
  vi.spyOn(watcher, 'getCurrent').mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('submitBundleWithRetry', () => {
  it('успех с первой попытки → attempts=1, базовые чаевые', async () => {
    submitFn.mockResolvedValueOnce(landed());

    const result = await run(config());

    expect(result).toEqual({ ...landed(), attempts: 1, tipLamports: BASE_TIP });
    expect(submitFn).toHaveBeenCalledTimes(1);
    expect(submitted(0)).toMatchObject({
      tipPayer,
      tipLamports: BASE_TIP,
      recentBlockhash: INITIAL_BLOCKHASH,
    });
    expect(calcTipFn).toHaveBeenCalledWith(STRATEGY);
  });

  it('первая падает, вторая успешна → attempts=2, чаевые выросли', async () => {
    submitFn.mockRejectedValueOnce(new Error('all regions failed')).mockResolvedValueOnce(landed());

    const result = await run(config({ tipIncreasePercent: 20 }));

    expect(result.attempts).toBe(2);
    expect(result.tipLamports).toBe(1_200_000);
    expect(submitted(0).tipLamports).toBe(1_000_000);
    expect(submitted(1).tipLamports).toBe(1_200_000);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('all regions failed'));
  });

  it('все попытки падают → throw с последней ошибкой в cause', async () => {
    const lastError = new Error('third failure');
    submitFn
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockRejectedValueOnce(lastError);

    const error = await run(config({ maxRetries: 3 })).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/3 попыток/);
    expect((error as Error).cause).toBe(lastError);
    expect(submitFn).toHaveBeenCalledTimes(3);
    expect(submitted(2).tipLamports).toBe(1_400_000);
    expect(log).toHaveBeenCalledWith('error', expect.any(String));
  });

  it('ждёт 2 с между попытками и не ждёт после последней', async () => {
    submitFn.mockRejectedValue(new Error('down'));

    const promise = submitBundleWithRetry(
      TRANSACTIONS, REGIONS, STRATEGY, config({ maxRetries: 2 }), watcher, tipPayer,
      INITIAL_BLOCKHASH, submitFn, calcTipFn, log,
    );
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
    expect(submitFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(submitFn).toHaveBeenCalledTimes(2);
    await expect(promise).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('blockhashRefresh: берёт свежий blockhash из watcher', async () => {
    vi.mocked(watcher.getCurrent)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ blockhash: 'FreshHash', slot: 100 });
    submitFn.mockRejectedValueOnce(new Error('expired')).mockResolvedValueOnce(landed());

    await run(config({ blockhashRefresh: true }));

    expect(submitted(0).recentBlockhash).toBe(INITIAL_BLOCKHASH);
    expect(submitted(1).recentBlockhash).toBe('FreshHash');
  });

  it('без blockhashRefresh всегда initialBlockhash', async () => {
    vi.mocked(watcher.getCurrent).mockReturnValue({ blockhash: 'FreshHash', slot: 100 });
    submitFn.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(landed());

    await run(config({ blockhashRefresh: false }));

    expect(submitted(0).recentBlockhash).toBe(INITIAL_BLOCKHASH);
    expect(submitted(1).recentBlockhash).toBe(INITIAL_BLOCKHASH);
    expect(watcher.getCurrent).not.toHaveBeenCalled();
  });

  it('regionFallback: со второй попытки включает все регионы', async () => {
    submitFn.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(landed('tokyo'));

    const result = await run(config({ regionFallback: true }));

    expect(submitted(0).regions).toBe(REGIONS);
    expect(submitted(1).regions.every((r) => r.enabled)).toBe(true);
    expect(REGIONS[1].enabled).toBe(false); // исходный массив не мутируется
    expect(result.region).toBe('tokyo');
  });

  it('ошибка calcTipFn считается неудачной попыткой', async () => {
    calcTipFn.mockRejectedValueOnce(new Error('tip api down'));
    submitFn.mockResolvedValueOnce(landed());

    const result = await run(config());

    expect(result.attempts).toBe(2);
    expect(submitFn).toHaveBeenCalledTimes(1);
  });

  it('некорректный maxRetries → ошибка без отправки', async () => {
    await expect(run(config({ maxRetries: 0 }))).rejects.toThrow(/maxRetries/);
    expect(submitFn).not.toHaveBeenCalled();
  });
});
