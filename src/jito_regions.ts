import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import { validateTip, validateTransactions } from './bundle_validation';

export interface JitoRegion {
  id: string;
  url: string;
  enabled: boolean;
}

/** Список регионов по умолчанию; определён в types.ts вместе с остальным конфигом. */
export { DEFAULT_JITO_REGIONS } from './types';

export interface MultiRegionSubmitResult {
  /** UUID бандла, выданный Block Engine победившего региона. */
  bundleId: string;
  /** id региона, ответившего первым. */
  region: string;
  /** Tip-аккаунт (base58), на который ушли чаевые в принятом бандле. */
  tipAccount: string;
}

export interface MultiRegionSubmitOptions {
  /** Кошелёк, который платит чаевые и подписывает tip-транзакцию. */
  tipPayer: Keypair;
  /** Размер чаевых в лампортах. */
  tipLamports: number;
  /** Blockhash для tip-транзакции. */
  recentBlockhash: string;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'success';
export type Logger = (level: LogLevel, msg: string) => void;

/** Общий дедлайн на получение tip-аккаунтов и отправку бандла во все регионы. */
export const MULTI_REGION_TIMEOUT_MS = 30_000;

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

/**
 * Отправляет один и тот же бандл во все включённые регионы Jito параллельно
 * и возвращает результат региона, который первым принял бандл.
 *
 * Для каждого региона берётся свой случайный tip-аккаунт, поэтому tip-транзакции
 * различаются, но пользовательские транзакции одинаковы: приземлиться может
 * только один из бандлов, двойной оплаты чаевых не будет.
 *
 * Запросы проигравших регионов не отменяются — дополнительные копии бандла
 * лишь повышают шанс попасть в блок.
 */
export async function submitBundleMultiRegion(
  transactions: VersionedTransaction[],
  regions: JitoRegion[],
  options: MultiRegionSubmitOptions,
  log: Logger,
): Promise<MultiRegionSubmitResult> {
  validateTransactions(transactions);
  validateTip(options.tipLamports);

  const enabled = regions.filter((region) => region.enabled);
  if (enabled.length === 0) {
    throw new Error('Нет включённых регионов Jito для отправки бандла');
  }

  // Пользовательские транзакции одинаковы для всех регионов — кодируем один раз.
  const encoded = transactions.map(encodeTransaction);
  const deadline = new AbortController();

  const attempts = enabled.map(async (region) => {
    try {
      const result = await submitToRegion(region, encoded, options, deadline.signal);
      log('info', `[${region.id}] бандл принят: ${result.bundleId}`);
      return result;
    } catch (err) {
      log('warn', `[${region.id}] ошибка отправки: ${errorMessage(err)}`);
      throw err;
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadline.abort();
      reject(
        new Error(
          `Ни один регион Jito не принял бандл за ${MULTI_REGION_TIMEOUT_MS / 1000} с`,
        ),
      );
    }, MULTI_REGION_TIMEOUT_MS);
  });

  log('info', `Отправка бандла в регионы: ${enabled.map((r) => r.id).join(', ')}`);

  try {
    // Promise.any — первый *успешный* регион; Promise.race с таймаутом — общий дедлайн.
    const winner = await Promise.race([Promise.any(attempts), timeout]);
    log('success', `Бандл ${winner.bundleId} принят регионом ${winner.region}`);
    return winner;
  } catch (err) {
    const message =
      err instanceof AggregateError
        ? `Все регионы Jito отклонили бандл: ${err.errors.map(errorMessage).join('; ')}`
        : errorMessage(err);
    log('error', message);
    throw new Error(message, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

async function submitToRegion(
  region: JitoRegion,
  encodedTransactions: string[],
  options: MultiRegionSubmitOptions,
  signal: AbortSignal,
): Promise<MultiRegionSubmitResult> {
  const tipAccounts = await jsonRpc<string[]>(
    `https://${region.url}/api/v1/getTipAccounts`,
    'getTipAccounts',
    [],
    signal,
  );
  if (!Array.isArray(tipAccounts) || tipAccounts.length === 0) {
    throw new Error('Block Engine вернул пустой список tip-аккаунтов');
  }
  const tipAccount = new PublicKey(
    tipAccounts[Math.floor(Math.random() * tipAccounts.length)],
  );

  const tipTx = buildTipTransaction(options, tipAccount);
  const bundleId = await jsonRpc<string>(
    `https://${region.url}/api/v1/bundles`,
    'sendBundle',
    [[...encodedTransactions, encodeTransaction(tipTx)], { encoding: 'base64' }],
    signal,
  );
  if (typeof bundleId !== 'string' || bundleId.length === 0) {
    throw new Error('Block Engine не вернул bundleId');
  }

  return { bundleId, region: region.id, tipAccount: tipAccount.toBase58() };
}

function buildTipTransaction(
  { tipPayer, tipLamports, recentBlockhash }: MultiRegionSubmitOptions,
  tipAccount: PublicKey,
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: tipPayer.publicKey,
    recentBlockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: tipPayer.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([tipPayer]);
  return tx;
}

async function jsonRpc<T>(
  url: string,
  method: string,
  params: unknown[],
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`${method}: HTTP ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as JsonRpcResponse<T>;
  if (body.error) {
    throw new Error(`${method}: ${body.error.message} (code ${body.error.code})`);
  }
  if (body.result === undefined) {
    throw new Error(`${method}: пустой ответ`);
  }
  return body.result;
}

function encodeTransaction(tx: VersionedTransaction): string {
  return Buffer.from(tx.serialize()).toString('base64');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
