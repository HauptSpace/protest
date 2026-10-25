import { Connection } from '@solana/web3.js';

import { median } from './tip_strategy';

export { median };

export interface NetworkConditions {
  /** Пользовательские (не vote) транзакции в секунду по последнему сэмплу RPC. */
  activeTransactions: number;
  /** Сколько из переданных `bundleIds` ещё в статусе Pending у Jito. */
  jitoQueueLength: number;
  medianTipLamports: number;
  recommendation: 'go' | 'wait' | 'stop';
  timestamp: number;
}

/** Общий таймаут на сбор всех метрик. */
export const NETWORK_CONDITIONS_TIMEOUT_MS = 10_000;

/** getInflightBundleStatuses принимает не больше 5 bundleId за запрос. */
const INFLIGHT_STATUS_BATCH = 5;

/** Пороги рекомендации. */
export const GO_MIN_ACTIVE_TPS = 1_000;
export const GO_MAX_QUEUE = 20;
export const WAIT_MAX_QUEUE = 50;

/** RPC-узлы с Solana ≥ 1.15 отдают это поле; web3.js 1.77 его не типизирует, но не вырезает. */
type PerfSampleWithNonVote = { numTransactions: number; samplePeriodSecs: number; numNonVoteTransactions?: number };

interface InflightStatusResponse {
  result?: { value?: Array<{ bundle_id?: string; status?: string } | null> };
  error?: { code: number; message: string };
}

/**
 * Снимает состояние сети и Jito и выдаёт рекомендацию:
 * - `go` — сеть активна (> 1000 user TPS) и у нас в очереди Jito < 20 бандлов;
 * - `wait` — в очереди < 50;
 * - `stop` — иначе.
 *
 * `jitoQueueLength` — это **наши** бандлы из `bundleIds`, которые ещё Pending:
 * публичного метода для длины общей очереди Jito нет. Без `bundleIds` — 0,
 * запрос к Jito не делается.
 */
export async function getNetworkConditions(
  rpcUrl: string,
  blockEngineUrl: string,
  recentTips?: number[],
  bundleIds: string[] = [],
): Promise<NetworkConditions> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Состояние сети не получено за ${NETWORK_CONDITIONS_TIMEOUT_MS / 1000} с`));
    }, NETWORK_CONDITIONS_TIMEOUT_MS);
  });

  try {
    const [activeTransactions, jitoQueueLength] = await Promise.race([
      Promise.all([
        getActiveTps(new Connection(rpcUrl)),
        countPendingBundles(blockEngineUrl, bundleIds, controller.signal),
      ]),
      timeout,
    ]);

    const tips = recentTips ?? [];
    return {
      activeTransactions,
      jitoQueueLength,
      medianTipLamports: tips.length === 0 ? 0 : Math.round(median(tips)),
      recommendation: recommend(activeTransactions, jitoQueueLength),
      timestamp: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function recommend(activeTransactions: number, jitoQueueLength: number): NetworkConditions['recommendation'] {
  if (activeTransactions > GO_MIN_ACTIVE_TPS && jitoQueueLength < GO_MAX_QUEUE) {
    return 'go';
  }
  if (jitoQueueLength < WAIT_MAX_QUEUE) {
    return 'wait';
  }
  return 'stop';
}

async function getActiveTps(connection: Connection): Promise<number> {
  const [sample] = (await connection.getRecentPerformanceSamples(1)) as PerfSampleWithNonVote[];
  if (!sample || sample.samplePeriodSecs <= 0) {
    throw new Error('RPC не вернул сэмпл производительности');
  }
  // Старые узлы без numNonVoteTransactions — считаем по всем транзакциям.
  const count = sample.numNonVoteTransactions ?? sample.numTransactions;
  return Math.round(count / sample.samplePeriodSecs);
}

async function countPendingBundles(
  blockEngineUrl: string,
  bundleIds: string[],
  signal: AbortSignal,
): Promise<number> {
  const unique = [...new Set(bundleIds)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += INFLIGHT_STATUS_BATCH) {
    batches.push(unique.slice(i, i + INFLIGHT_STATUS_BATCH));
  }

  const counts = await Promise.all(
    batches.map(async (batch) => {
      const response = await fetch(`https://${blockEngineUrl}/api/v1/getInflightBundleStatuses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getInflightBundleStatuses',
          params: [batch],
        }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`getInflightBundleStatuses: HTTP ${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as InflightStatusResponse;
      if (body.error) {
        throw new Error(`getInflightBundleStatuses: ${body.error.message} (code ${body.error.code})`);
      }
      return (body.result?.value ?? []).filter((entry) => entry?.status === 'Pending').length;
    }),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}
