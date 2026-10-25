/**
 * Пример сборки всех модулей вместе. Компилируется вместе с проектом
 * (проверено tsc), но в сборку dist не входит.
 */
import { Keypair, VersionedTransaction } from '@solana/web3.js';

import { BlockhashInfo, BlockhashWatcher } from '../src/blockhash_ws';
import { DEFAULT_JITO_REGIONS, submitBundleMultiRegion } from '../src/jito_regions';
import { RetryResult, submitBundleWithRetry } from '../src/submit_with_retry';
import {
  JITO_TIP_FLOOR_HOST,
  TipStrategy,
  calculateTip,
  getRecentLandedTips,
} from '../src/tip_strategy';

type Level = 'info' | 'warn' | 'error' | 'success';
const log = (level: Level, msg: string) => console.log(`[${level}] ${msg}`);

/** 1. При старте приложения: один watcher на всё время работы. */
export async function startBlockhashWatcher(rpcUrl: string): Promise<BlockhashWatcher> {
  const watcher = new BlockhashWatcher(rpcUrl);
  watcher.on('error', (err) => log('warn', `blockhash watcher: ${err.message}`));
  watcher.start();
  await waitForFirstBlockhash(watcher, 15_000);
  return watcher;
}

/** 2. На каждый бандл: свежий blockhash → транзакции → чаевые → отправка с ретраями. */
export async function sendBundle(
  watcher: BlockhashWatcher,
  tipPayer: Keypair,
  /** Строит и подписывает пользовательские транзакции под переданный blockhash. */
  buildTransactions: (blockhash: string) => Promise<VersionedTransaction[]>,
): Promise<RetryResult> {
  const blockhash = watcher.getCurrent()?.blockhash;
  if (!blockhash) {
    throw new Error('Нет актуального blockhash: watcher не подключён');
  }
  const transactions = await buildTransactions(blockhash);

  // Данные о чаевых загружаем один раз и замыкаем в calcTipFn:
  // submitBundleWithRetry зовёт calcTipFn(strategy) без recentTips,
  // и без этой обёртки auto/percentile всегда уходили бы в fallback.
  const recentTips = await getRecentLandedTips(JITO_TIP_FLOOR_HOST).catch((err: unknown) => {
    log('warn', `tip floor недоступен, используем fallback: ${String(err)}`);
    return [];
  });
  const strategy: TipStrategy = { type: 'percentile', percentile: 75, minLamports: 10_000 };

  return submitBundleWithRetry(
    transactions,
    DEFAULT_JITO_REGIONS,
    strategy,
    { maxRetries: 3, tipIncreasePercent: 25, blockhashRefresh: true, regionFallback: true },
    watcher,
    tipPayer,
    blockhash,
    submitBundleMultiRegion,
    (s) => calculateTip(s, recentTips),
    log,
  );
}

/** 3. При остановке приложения: watcher.stop(). */

function waitForFirstBlockhash(watcher: BlockhashWatcher, timeoutMs: number): Promise<BlockhashInfo> {
  const current = watcher.getCurrent();
  if (current) {
    return Promise.resolve(current);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Нет blockhash за ${timeoutMs} мс`)),
      timeoutMs,
    );
    watcher.on('update', (info) => {
      clearTimeout(timer);
      resolve(info);
    });
  });
}
