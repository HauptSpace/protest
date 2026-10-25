import type { VersionedTransaction, Keypair } from '@solana/web3.js';
import type { JitoRegion } from './jito_regions.js';
import type { TipStrategy } from './tip_strategy.js';
import type { BlockhashWatcher } from './blockhash_ws.js';

type Logger = (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void;

export interface RetryConfig {
  /** Общее число попыток (не «повторов сверх первой»): попытки 0..maxRetries-1. */
  maxRetries: number;
  /** На сколько процентов от базовых чаевых поднимать их с каждой попыткой. */
  tipIncreasePercent: number;
  /** Брать свежий blockhash из watcher для tip-транзакции на каждой попытке. */
  blockhashRefresh: boolean;
  /** Со второй попытки слать бандл во все регионы, включая выключенные. */
  regionFallback: boolean;
}

export interface RetryResult {
  bundleId: string;
  region: string;
  tipAccount: string;
  /** Номер успешной попытки, начиная с 1. */
  attempts: number;
  tipLamports: number;
}

/** Пауза между неудачной попыткой и следующей. */
export const RETRY_DELAY_MS = 2_000;

/**
 * Отправляет бандл через `submitFn`, повторяя при ошибке с ростом чаевых,
 * свежим blockhash и (опционально) расширенным набором регионов.
 */
export async function submitBundleWithRetry(
  transactions: VersionedTransaction[],
  regions: JitoRegion[],
  tipStrategy: TipStrategy,
  retry: RetryConfig,
  blockhashWatcher: BlockhashWatcher,
  tipPayer: Keypair,
  initialBlockhash: string,
  submitFn: (
    txs: VersionedTransaction[],
    regions: JitoRegion[],
    opts: { tipPayer: Keypair; tipLamports: number; recentBlockhash: string },
    log: Logger,
  ) => Promise<{ bundleId: string; region: string; tipAccount: string }>,
  calcTipFn: (strategy: TipStrategy, recent?: number[]) => Promise<number>,
  log: Logger,
): Promise<RetryResult> {
  validateRetryConfig(retry);

  let lastError: unknown;
  for (let attempt = 0; attempt < retry.maxRetries; attempt++) {
    const label = `Попытка ${attempt + 1}/${retry.maxRetries}`;
    try {
      const baseTip = await calcTipFn(tipStrategy);
      // Лампорты — целые; округляем после надбавки.
      const tipLamports = Math.round(baseTip * (1 + (attempt * retry.tipIncreasePercent) / 100));
      const recentBlockhash = retry.blockhashRefresh
        ? (blockhashWatcher.getCurrent()?.blockhash ?? initialBlockhash)
        : initialBlockhash;
      const attemptRegions =
        retry.regionFallback && attempt > 0
          ? regions.map((region) => ({ ...region, enabled: true }))
          : regions;

      log('info', `${label}: tip ${tipLamports} lamports, blockhash ${recentBlockhash}`);
      const result = await submitFn(
        transactions,
        attemptRegions,
        { tipPayer, tipLamports, recentBlockhash },
        log,
      );
      return { ...result, attempts: attempt + 1, tipLamports };
    } catch (err) {
      lastError = err;
      log('warn', `${label} не удалась: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < retry.maxRetries - 1) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  const message = `Бандл не отправлен за ${retry.maxRetries} попыток`;
  log('error', message);
  throw new Error(message, { cause: lastError });
}

function validateRetryConfig({ maxRetries, tipIncreasePercent }: RetryConfig): void {
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 1) {
    throw new Error('maxRetries должен быть целым числом не меньше 1');
  }
  if (!Number.isFinite(tipIncreasePercent) || tipIncreasePercent < 0) {
    throw new Error('tipIncreasePercent должен быть неотрицательным числом');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
