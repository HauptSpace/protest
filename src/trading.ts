import { Connection, Keypair, PublicKey } from '@solana/web3.js';

export interface TradingConfig {
  exitStrategy: 'manual' | 'target' | 'trailing' | 'dca';
  /** target: продать всё, когда цена ≥ targetPrice (в единицах getCurrentPrice). */
  targetPrice?: number;
  /** trailing: продать всё, когда цена упала на столько % от пика. */
  trailingStopPercent?: number;
  /** dca: шаги по порядку — подождать `time` мс от предыдущего шага, продать `percent`% остатка. */
  dcaIntervals?: { time: number; percent: number }[];
}

export interface TradingResult {
  /** Продано токенов, в минимальных единицах (raw amount, без учёта decimals). */
  totalSold: string;
  /** Получено SOL «на руки» в лампортах: изменение баланса продавцов, уже за вычетом комиссий. */
  totalSolReceived: string;
  /** Средняя цена продажи: SOL за 1 токен (с учётом decimals). */
  avgPrice: number;
  strategy: string;
}

type Logger = (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void;
type SellTokens = (mint: PublicKey, seller: Keypair, amount: bigint) => Promise<string>;
type GetCurrentPrice = (mint: PublicKey) => Promise<number>;

export const PRICE_POLL_INTERVAL_MS = 2_000;
export const EXIT_STRATEGY_TIMEOUT_MS = 5 * 60_000;
/** Сколько ждать появления транзакции продажи в RPC. */
export const SALE_CONFIRM_TIMEOUT_MS = 30_000;
const SALE_CONFIRM_POLL_MS = 1_000;
const LAMPORTS_PER_SOL = 1_000_000_000;
const BASIS_POINTS = 10_000n;

/**
 * Стратегия не сработала за {@link EXIT_STRATEGY_TIMEOUT_MS}. Оставшиеся токены
 * **не продаются**; то, что успели продать (DCA), лежит в `partial`.
 */
export class ExitStrategyTimeoutError extends Error {
  constructor(readonly partial: TradingResult) {
    super(`Стратегия ${partial.strategy} не завершилась за ${EXIT_STRATEGY_TIMEOUT_MS / 60_000} мин`);
    this.name = 'ExitStrategyTimeoutError';
  }
}

interface Context {
  mint: PublicKey;
  wallets: Keypair[];
  connection: Connection;
  log: Logger;
  sellTokens: SellTokens;
  totals: { sold: bigint; lamports: bigint; decimals: number | null };
}

/**
 * Исполняет стратегию выхода из позиции по токену `mint` на всех кошельках.
 *
 * `sellTokens` должна вернуть подпись транзакции продажи: по ней из RPC
 * берутся фактически проданное количество и полученные лампорты.
 */
export async function executeExitStrategy(
  mint: PublicKey,
  config: TradingConfig,
  walletKeypairs: Keypair[],
  rpcUrl: string,
  log: Logger,
  getCurrentPrice: GetCurrentPrice,
  sellTokens: SellTokens,
): Promise<TradingResult> {
  validateConfig(config);

  const ctx: Context = {
    mint,
    wallets: walletKeypairs,
    connection: new Connection(rpcUrl, 'confirmed'),
    log,
    sellTokens,
    totals: { sold: 0n, lamports: 0n, decimals: null },
  };
  const deadline = Date.now() + EXIT_STRATEGY_TIMEOUT_MS;
  const strategy = config.exitStrategy;

  switch (strategy) {
    case 'manual':
      log('info', 'Стратегия manual: автоматических продаж нет');
      break;

    case 'target': {
      const target = config.targetPrice!;
      log('info', `Стратегия target: продажа при цене ≥ ${target}`);
      const hit = await waitForPrice(ctx, getCurrentPrice, deadline, (price) => price >= target);
      if (!hit) {
        throw new ExitStrategyTimeoutError(toResult(ctx, strategy));
      }
      log('info', `Цель ${target} достигнута`);
      await sellShare(ctx, BASIS_POINTS);
      break;
    }

    case 'trailing': {
      const stop = config.trailingStopPercent!;
      let peak = 0;
      log('info', `Стратегия trailing: продажа при падении на ${stop}% от пика`);
      const hit = await waitForPrice(ctx, getCurrentPrice, deadline, (price) => {
        peak = Math.max(peak, price);
        return price <= peak * (1 - stop / 100);
      });
      if (!hit) {
        throw new ExitStrategyTimeoutError(toResult(ctx, strategy));
      }
      log('info', `Trailing stop: цена упала на ≥ ${stop}% от пика ${peak}`);
      await sellShare(ctx, BASIS_POINTS);
      break;
    }

    case 'dca': {
      const steps = config.dcaIntervals!;
      for (const [i, step] of steps.entries()) {
        if (Date.now() + step.time > deadline) {
          throw new ExitStrategyTimeoutError(toResult(ctx, strategy));
        }
        await sleep(step.time);
        log('info', `DCA шаг ${i + 1}/${steps.length}: продаём ${step.percent}% остатка`);
        await sellShare(ctx, BigInt(Math.round(step.percent * 100)));
      }
      break;
    }
  }

  const result = toResult(ctx, strategy);
  if (strategy !== 'manual') {
    log('success', `Продано ${result.totalSold}, получено ${result.totalSolReceived} лампортов`);
  }
  return result;
}

/** Опрашивает цену каждые 2 с, пока `trigger` не вернёт true или не выйдет время. */
async function waitForPrice(
  ctx: Context,
  getCurrentPrice: GetCurrentPrice,
  deadline: number,
  trigger: (price: number) => boolean,
): Promise<boolean> {
  for (;;) {
    try {
      const price = await getCurrentPrice(ctx.mint);
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`некорректная цена ${price}`);
      }
      if (trigger(price)) {
        return true;
      }
    } catch (err) {
      ctx.log('warn', `Не удалось получить цену: ${errorMessage(err)}`);
    }

    const left = deadline - Date.now();
    if (left <= 0) {
      return false;
    }
    await sleep(Math.min(PRICE_POLL_INTERVAL_MS, left));
  }
}

/**
 * Продаёт `share / 10000` текущего баланса на каждом кошельке параллельно.
 * Ошибка одного кошелька логируется и не мешает остальным.
 */
async function sellShare(ctx: Context, share: bigint): Promise<void> {
  await Promise.all(
    ctx.wallets.map(async (wallet) => {
      const who = shortKey(wallet.publicKey);
      try {
        const { amount: balance, decimals } = await getTokenBalance(ctx, wallet.publicKey);
        if (decimals !== null) {
          ctx.totals.decimals = decimals;
        }
        const amount = (balance * share) / BASIS_POINTS;
        if (amount === 0n) {
          ctx.log('info', `[${who}] нечего продавать`);
          return;
        }

        const signature = await ctx.sellTokens(ctx.mint, wallet, amount);
        const sale = await confirmSale(ctx, signature, wallet.publicKey);
        if (!sale) {
          ctx.log('warn', `[${who}] продажа ${signature} не найдена в RPC за ${SALE_CONFIRM_TIMEOUT_MS / 1000} с — в итог не учтена`);
          return;
        }
        ctx.totals.sold += sale.sold ?? amount;
        ctx.totals.lamports += sale.lamports;
        ctx.log('info', `[${who}] продано ${sale.sold ?? amount}, получено ${sale.lamports} лампортов (${signature})`);
      } catch (err) {
        ctx.log('error', `[${who}] продажа не удалась: ${errorMessage(err)}`);
      }
    }),
  );
}

async function getTokenBalance(
  ctx: Context,
  owner: PublicKey,
): Promise<{ amount: bigint; decimals: number | null }> {
  const { value } = await ctx.connection.getParsedTokenAccountsByOwner(owner, { mint: ctx.mint });
  let amount = 0n;
  let decimals: number | null = null;
  for (const account of value) {
    const tokenAmount = account.account.data.parsed?.info?.tokenAmount as
      | { amount: string; decimals: number }
      | undefined;
    if (tokenAmount) {
      amount += BigInt(tokenAmount.amount);
      decimals = tokenAmount.decimals;
    }
  }
  return { amount, decimals };
}

/**
 * Ждёт транзакцию продажи в RPC и считает по ней изменение баланса продавца:
 * лампорты (post − pre, уже за вычетом комиссий) и проданные токены.
 * `null` — транзакция так и не появилась; ошибка — транзакция упала on-chain.
 */
async function confirmSale(
  ctx: Context,
  signature: string,
  seller: PublicKey,
): Promise<{ lamports: bigint; sold: bigint | null } | null> {
  const giveUpAt = Date.now() + SALE_CONFIRM_TIMEOUT_MS;
  for (;;) {
    const tx = await ctx.connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.meta) {
      if (tx.meta.err) {
        throw new Error(`транзакция ${signature} упала: ${JSON.stringify(tx.meta.err)}`);
      }
      const index = tx.transaction.message.staticAccountKeys.findIndex((key) => key.equals(seller));
      if (index === -1) {
        throw new Error(`продавец не найден в транзакции ${signature}`);
      }
      const lamports = BigInt(tx.meta.postBalances[index] - tx.meta.preBalances[index]);
      const sellerBase58 = seller.toBase58();
      const mintBase58 = ctx.mint.toBase58();
      const tokenSum = (balances: typeof tx.meta.preTokenBalances) => {
        const own = (balances ?? []).filter((b) => b.owner === sellerBase58 && b.mint === mintBase58);
        return own.length === 0 ? null : own.reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
      };
      const pre = tokenSum(tx.meta.preTokenBalances);
      const post = tokenSum(tx.meta.postTokenBalances) ?? 0n; // закрытый ATA пропадает из post
      return { lamports, sold: pre === null ? null : pre - post };
    }
    if (Date.now() >= giveUpAt) {
      return null;
    }
    await sleep(SALE_CONFIRM_POLL_MS);
  }
}

function toResult(ctx: Context, strategy: string): TradingResult {
  const { sold, lamports, decimals } = ctx.totals;
  const tokens = Number(sold) / 10 ** (decimals ?? 0);
  return {
    totalSold: sold.toString(),
    totalSolReceived: lamports.toString(),
    avgPrice: sold === 0n ? 0 : Number(lamports) / LAMPORTS_PER_SOL / tokens,
    strategy,
  };
}

function validateConfig(config: TradingConfig): void {
  switch (config.exitStrategy) {
    case 'manual':
      return;
    case 'target':
      if (!(typeof config.targetPrice === 'number' && config.targetPrice > 0)) {
        throw new Error('target: нужен targetPrice > 0');
      }
      return;
    case 'trailing': {
      const p = config.trailingStopPercent;
      if (!(typeof p === 'number' && p > 0 && p < 100)) {
        throw new Error('trailing: нужен trailingStopPercent в диапазоне (0, 100)');
      }
      return;
    }
    case 'dca': {
      const steps = config.dcaIntervals;
      if (!steps || steps.length === 0) {
        throw new Error('dca: нужен хотя бы один шаг в dcaIntervals');
      }
      for (const { time, percent } of steps) {
        if (!(Number.isFinite(time) && time >= 0)) {
          throw new Error('dca: time должен быть ≥ 0 мс');
        }
        if (!(Number.isFinite(percent) && percent > 0 && percent <= 100)) {
          throw new Error('dca: percent должен быть в диапазоне (0, 100]');
        }
      }
      const total = steps.reduce((sum, s) => sum + s.time, 0);
      if (total > EXIT_STRATEGY_TIMEOUT_MS) {
        throw new Error(`dca: сумма задержек ${total} мс больше таймаута ${EXIT_STRATEGY_TIMEOUT_MS} мс`);
      }
      return;
    }
    default:
      throw new Error(`Неизвестная стратегия: ${String((config as { exitStrategy: unknown }).exitStrategy)}`);
  }
}

function shortKey(key: PublicKey): string {
  const s = key.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
