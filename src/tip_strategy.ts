export type TipStrategy =
  | { type: 'manual'; lamports: number }
  | { type: 'auto'; percentile: number }
  | { type: 'percentile'; percentile: number; minLamports: number };

/** Чаевые для стратегии auto, когда нет данных о недавних бандлах. */
export const AUTO_FALLBACK_TIP_LAMPORTS = 1_000_000;

/** Хост публичного REST API Jito со статистикой приземлившихся чаевых. */
export const JITO_TIP_FLOOR_HOST = 'bundles.jito.wtf';

const LAMPORTS_PER_SOL = 1_000_000_000;
const TIP_FLOOR_TIMEOUT_MS = 10_000;

/** Поля снимка tip_floor с перцентилями приземлившихся чаевых (в SOL). */
const TIP_FLOOR_FIELDS = [
  'landed_tips_25th_percentile',
  'landed_tips_50th_percentile',
  'landed_tips_75th_percentile',
  'landed_tips_95th_percentile',
  'landed_tips_99th_percentile',
] as const;

type TipFloorSnapshot = Partial<Record<(typeof TIP_FLOOR_FIELDS)[number], unknown>>;

/**
 * Рассчитывает размер чаевых в лампортах.
 *
 * - manual — фиксированная сумма;
 * - auto — `percentile`-й перцентиль `recentTips`, без данных — 1 000 000;
 * - percentile — `percentile`-й перцентиль `recentTips`, но не меньше `minLamports`;
 *   без данных — `minLamports`.
 */
export async function calculateTip(
  strategy: TipStrategy,
  recentTips: number[] = [],
): Promise<number> {
  switch (strategy.type) {
    case 'manual':
      assertPositiveLamports(strategy.lamports, 'lamports');
      return strategy.lamports;

    case 'auto':
      assertPercentile(strategy.percentile);
      if (recentTips.length === 0) {
        return AUTO_FALLBACK_TIP_LAMPORTS;
      }
      return Math.round(percentileValue(recentTips, strategy.percentile / 100));

    case 'percentile': {
      assertPercentile(strategy.percentile);
      assertPositiveLamports(strategy.minLamports, 'minLamports');
      if (recentTips.length === 0) {
        return strategy.minLamports;
      }
      const tip = Math.round(percentileValue(recentTips, strategy.percentile / 100));
      return Math.max(tip, strategy.minLamports);
    }
  }
}

/**
 * Возвращает чаевые недавно приземлившихся бандлов в лампортах по данным
 * Jito tip floor API (`GET https://{host}/api/v1/bundles/tip_floor`).
 *
 * API отдаёт не отдельные чаевые, а снимки перцентилей (25/50/75/95/99),
 * поэтому результат — это перцентили из `limit` последних снимков,
 * отсортированные по возрастанию. Для `calculateTip` этого достаточно:
 * перцентиль считается по ним как по выборке.
 *
 * @param blockEngineUrl хост tip floor API, обычно {@link JITO_TIP_FLOOR_HOST}.
 * @param limit сколько последних снимков учитывать.
 */
export async function getRecentLandedTips(
  blockEngineUrl: string,
  limit = 1,
): Promise<number[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('limit должен быть положительным целым числом');
  }

  const response = await fetch(`https://${blockEngineUrl}/api/v1/bundles/tip_floor`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIP_FLOOR_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`tip_floor: HTTP ${response.status} ${response.statusText}`);
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error('tip_floor: ожидался массив снимков');
  }

  const tips = (body as TipFloorSnapshot[])
    .slice(0, limit)
    .flatMap((snapshot) => TIP_FLOOR_FIELDS.map((field) => snapshot[field]))
    .filter((sol): sol is number => typeof sol === 'number' && Number.isFinite(sol) && sol > 0)
    .map((sol) => Math.round(sol * LAMPORTS_PER_SOL));

  return tips.sort((a, b) => a - b);
}

export function median(arr: number[]): number {
  if (arr.length === 0) {
    throw new Error('median: пустой массив');
  }
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Перцентиль с линейной интерполяцией по рангу `p·n` (метод 4 по Hyndman & Fan):
 * для [1, 2, 3] и p = 0.8 ранг 2.4 → 2 + 0.4·(3 − 2) = 2.4.
 *
 * @param p доля от 0 до 1.
 */
export function percentileValue(arr: number[], p: number): number {
  if (arr.length === 0) {
    throw new Error('percentileValue: пустой массив');
  }
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error('percentileValue: p должен быть в диапазоне [0, 1]');
  }

  const sorted = [...arr].sort((a, b) => a - b);
  const rank = p * sorted.length; // 1-based
  if (rank <= 1) {
    return sorted[0];
  }
  if (rank >= sorted.length) {
    return sorted[sorted.length - 1];
  }

  const lower = Math.floor(rank);
  const fraction = rank - lower;
  return sorted[lower - 1] + fraction * (sorted[lower] - sorted[lower - 1]);
}

function assertPositiveLamports(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} должен быть положительным целым числом лампортов`);
  }
}

function assertPercentile(percentile: number): void {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new Error('percentile должен быть в диапазоне (0, 100]');
  }
}
