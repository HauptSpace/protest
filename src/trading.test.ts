import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chain = vi.hoisted(() => ({
  getParsedTokenAccountsByOwner: vi.fn(),
  getTransaction: vi.fn(),
}));

vi.mock('@solana/web3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/web3.js')>()),
  Connection: class {
    getParsedTokenAccountsByOwner = chain.getParsedTokenAccountsByOwner;
    getTransaction = chain.getTransaction;
  },
}));

import {
  EXIT_STRATEGY_TIMEOUT_MS,
  ExitStrategyTimeoutError,
  PRICE_POLL_INTERVAL_MS,
  TradingConfig,
  executeExitStrategy,
} from './trading';

const MINT = Keypair.generate().publicKey;
const DECIMALS = 6;
const ONE_TOKEN = 10n ** BigInt(DECIMALS);
/** Цена продажи в симуляции: 0.001 SOL = 1 000 000 лампортов за 1 токен. */
const LAMPORTS_PER_TOKEN = 1_000_000n;

/**
 * Мини-симуляция цепочки: балансы токенов по кошелькам и транзакции продаж.
 * sellTokens списывает токены и «кладёт» в RPC транзакцию с pre/post балансами.
 */
let balances: Map<string, bigint>;
let transactions: Map<string, unknown>;
let sellCounter: number;

const sellTokens = vi.fn(async (mint: PublicKey, seller: Keypair, amount: bigint) => {
  const owner = seller.publicKey.toBase58();
  const before = balances.get(owner) ?? 0n;
  if (amount > before) {
    throw new Error('insufficient balance');
  }
  balances.set(owner, before - amount);
  const signature = `sig-${++sellCounter}`;
  const lamports = Number((amount * LAMPORTS_PER_TOKEN) / ONE_TOKEN);
  const tokenBalance = (raw: bigint) => ({
    accountIndex: 1,
    mint: mint.toBase58(),
    owner,
    uiTokenAmount: { amount: raw.toString(), decimals: DECIMALS },
  });
  transactions.set(signature, {
    transaction: { message: { staticAccountKeys: [seller.publicKey, Keypair.generate().publicKey] } },
    meta: {
      err: null,
      preBalances: [1_000_000_000, 2_039_280],
      postBalances: [1_000_000_000 + lamports, 2_039_280],
      preTokenBalances: [tokenBalance(before)],
      postTokenBalances: [tokenBalance(before - amount)],
    },
  });
  return signature;
});

const getCurrentPrice = vi.fn<(mint: PublicKey) => Promise<number>>();
const log = vi.fn();

function wallets(...amounts: bigint[]): Keypair[] {
  return amounts.map((amount) => {
    const kp = Keypair.generate();
    balances.set(kp.publicKey.toBase58(), amount);
    return kp;
  });
}

/** Цены по очереди на каждый опрос; последняя повторяется. */
function prices(...values: number[]) {
  let i = 0;
  getCurrentPrice.mockImplementation(async () => values[Math.min(i++, values.length - 1)]);
}

async function run(config: TradingConfig, keypairs: Keypair[], advanceMs = EXIT_STRATEGY_TIMEOUT_MS) {
  const promise = executeExitStrategy(
    MINT, config, keypairs, 'https://rpc.example.test', log, getCurrentPrice, sellTokens,
  );
  promise.catch(() => {});
  await vi.advanceTimersByTimeAsync(advanceMs);
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  balances = new Map();
  transactions = new Map();
  sellCounter = 0;
  sellTokens.mockClear();
  getCurrentPrice.mockReset();
  log.mockReset();
  chain.getParsedTokenAccountsByOwner.mockReset().mockImplementation(async (owner: PublicKey) => ({
    context: { slot: 1 },
    value: [
      {
        pubkey: Keypair.generate().publicKey,
        account: {
          data: {
            parsed: {
              info: {
                tokenAmount: {
                  amount: (balances.get(owner.toBase58()) ?? 0n).toString(),
                  decimals: DECIMALS,
                },
              },
            },
          },
        },
      },
    ],
  }));
  chain.getTransaction.mockReset().mockImplementation(async (sig: string) => transactions.get(sig) ?? null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('executeExitStrategy', () => {
  it('manual → пустой результат, ничего не продаёт', async () => {
    const result = await run({ exitStrategy: 'manual' }, wallets(100n * ONE_TOKEN));

    expect(result).toEqual({ totalSold: '0', totalSolReceived: '0', avgPrice: 0, strategy: 'manual' });
    expect(sellTokens).not.toHaveBeenCalled();
    expect(getCurrentPrice).not.toHaveBeenCalled();
  });

  it('target: цена дошла до цели → продаёт всё на всех кошельках', async () => {
    prices(0.0005, 0.0008, 0.001);
    const keypairs = wallets(100n * ONE_TOKEN, 50n * ONE_TOKEN);

    const result = await run({ exitStrategy: 'target', targetPrice: 0.001 }, keypairs);

    expect(getCurrentPrice).toHaveBeenCalledTimes(3);
    expect(sellTokens).toHaveBeenCalledTimes(2);
    expect(sellTokens).toHaveBeenCalledWith(MINT, keypairs[0], 100n * ONE_TOKEN);
    expect(sellTokens).toHaveBeenCalledWith(MINT, keypairs[1], 50n * ONE_TOKEN);
    expect(result).toEqual({
      totalSold: (150n * ONE_TOKEN).toString(),
      totalSolReceived: '150000000', // 150 токенов × 0.001 SOL = 0.15 SOL
      avgPrice: 0.001,
      strategy: 'target',
    });
  });

  it('target: опрашивает цену раз в 2 с', async () => {
    prices(0.0001);
    const promise = executeExitStrategy(
      MINT, { exitStrategy: 'target', targetPrice: 1 }, wallets(ONE_TOKEN), 'https://rpc', log,
      getCurrentPrice, sellTokens,
    );
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(getCurrentPrice).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PRICE_POLL_INTERVAL_MS);
    expect(getCurrentPrice).toHaveBeenCalledTimes(2);
  });

  it('trailing: рост, затем падение на 10% от пика → продажа', async () => {
    prices(1.0, 1.5, 2.0, 1.9, 1.85, 1.79);
    const keypairs = wallets(10n * ONE_TOKEN);

    const result = await run({ exitStrategy: 'trailing', trailingStopPercent: 10 }, keypairs);

    // 2.0 — пик, 1.9 и 1.85 выше стопа 1.8, 1.79 — ниже
    expect(getCurrentPrice).toHaveBeenCalledTimes(6);
    expect(sellTokens).toHaveBeenCalledTimes(1);
    expect(sellTokens).toHaveBeenCalledWith(MINT, keypairs[0], 10n * ONE_TOKEN);
    expect(result.totalSold).toBe((10n * ONE_TOKEN).toString());
  });

  it('trailing: падение без нового пика меньше порога → не продаёт', async () => {
    prices(1.0, 0.95, 0.91);

    await expect(
      run({ exitStrategy: 'trailing', trailingStopPercent: 10 }, wallets(ONE_TOKEN)),
    ).rejects.toBeInstanceOf(ExitStrategyTimeoutError);
    expect(sellTokens).not.toHaveBeenCalled();
  });

  it('dca: 2 шага → 2 продажи, процент от остатка', async () => {
    const keypairs = wallets(100n * ONE_TOKEN);

    const result = await run(
      {
        exitStrategy: 'dca',
        dcaIntervals: [
          { time: 10_000, percent: 50 },
          { time: 20_000, percent: 100 },
        ],
      },
      keypairs,
    );

    expect(sellTokens).toHaveBeenCalledTimes(2);
    expect(sellTokens.mock.calls[0][2]).toBe(50n * ONE_TOKEN); // 50% от 100
    expect(sellTokens.mock.calls[1][2]).toBe(50n * ONE_TOKEN); // 100% от оставшихся 50
    expect(result.totalSold).toBe((100n * ONE_TOKEN).toString());
    expect(result.strategy).toBe('dca');
  });

  it('dca: ждёт time мс перед каждым шагом', async () => {
    const promise = executeExitStrategy(
      MINT,
      { exitStrategy: 'dca', dcaIntervals: [{ time: 10_000, percent: 50 }, { time: 5_000, percent: 50 }] },
      wallets(100n * ONE_TOKEN), 'https://rpc', log, getCurrentPrice, sellTokens,
    );
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(9_999);
    expect(sellTokens).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sellTokens).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sellTokens).toHaveBeenCalledTimes(2);
    await promise;
  });

  it('target не достигнут за 5 мин → ExitStrategyTimeoutError, без продаж', async () => {
    prices(0.0001);

    const error = await run({ exitStrategy: 'target', targetPrice: 1 }, wallets(ONE_TOKEN)).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ExitStrategyTimeoutError);
    expect((error as ExitStrategyTimeoutError).partial.totalSold).toBe('0');
    expect(sellTokens).not.toHaveBeenCalled();
  });

  it('ошибка цены не останавливает опрос', async () => {
    getCurrentPrice
      .mockRejectedValueOnce(new Error('price api down'))
      .mockResolvedValueOnce(Number.NaN)
      .mockResolvedValue(2);

    const result = await run({ exitStrategy: 'target', targetPrice: 1 }, wallets(ONE_TOKEN));

    expect(result.totalSold).toBe(ONE_TOKEN.toString());
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('price api down'));
  });

  it('ошибка продажи на одном кошельке не мешает остальным', async () => {
    prices(2);
    const keypairs = wallets(ONE_TOKEN, 2n * ONE_TOKEN);
    sellTokens.mockRejectedValueOnce(new Error('slippage exceeded'));

    const result = await run({ exitStrategy: 'target', targetPrice: 1 }, keypairs);

    expect(sellTokens).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('slippage exceeded'));
    expect(BigInt(result.totalSold)).toBeGreaterThan(0n);
  });

  it('упавшая on-chain транзакция не учитывается в итоге', async () => {
    prices(2);
    const keypairs = wallets(ONE_TOKEN);
    chain.getTransaction.mockResolvedValueOnce({
      transaction: { message: { staticAccountKeys: [keypairs[0].publicKey] } },
      meta: { err: { InstructionError: [0, 'Custom'] }, preBalances: [1], postBalances: [0] },
    });

    const result = await run({ exitStrategy: 'target', targetPrice: 1 }, keypairs);

    expect(result.totalSold).toBe('0');
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('упала'));
  });

  it('пустой кошелёк пропускается без вызова sellTokens', async () => {
    prices(2);

    await run({ exitStrategy: 'target', targetPrice: 1 }, wallets(0n));

    expect(sellTokens).not.toHaveBeenCalled();
  });

  it('некорректный конфиг → ошибка до любых действий', async () => {
    const keypairs = wallets(ONE_TOKEN);
    await expect(run({ exitStrategy: 'target' }, keypairs)).rejects.toThrow(/targetPrice/);
    await expect(run({ exitStrategy: 'trailing', trailingStopPercent: 0 }, keypairs)).rejects.toThrow(
      /trailingStopPercent/,
    );
    await expect(run({ exitStrategy: 'dca', dcaIntervals: [] }, keypairs)).rejects.toThrow(/dca/);
    await expect(
      run({ exitStrategy: 'dca', dcaIntervals: [{ time: EXIT_STRATEGY_TIMEOUT_MS + 1, percent: 50 }] }, keypairs),
    ).rejects.toThrow(/таймаута/);
    expect(getCurrentPrice).not.toHaveBeenCalled();
    expect(sellTokens).not.toHaveBeenCalled();
  });
});
