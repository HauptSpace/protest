/**
 * Общие типы и конфиг приложения.
 *
 * Типы не дублируются, а реэкспортируются из модулей, где они определены, —
 * так определение одно и не разъедется. `export type` стирается при сборке:
 * импорт этого файла не тянет за собой SDK Raydium, jito-ts и т.п.
 */
import type { JitoRegion } from './jito_regions';
import type { IpfsConfig } from './ipfs';
import type { RaydiumConfig } from './raydium';
import type { RetryConfig } from './submit_with_retry';
import type { TipStrategy } from './tip_strategy';
import type { TradingConfig } from './trading';

export type { JitoRegion } from './jito_regions';
export type { TipStrategy } from './tip_strategy';
export type { RetryConfig } from './submit_with_retry';
export type { IpfsConfig } from './ipfs';
/** `initialLiquidityTokens?: bigint` — обязателен при создании пула, см. raydium.ts. */
export type { RaydiumConfig } from './raydium';
export type { TradingConfig } from './trading';
export type { NetworkConditions } from './market_monitor';
/** Вместе с `steps: CycleStep[]` — см. auto_cycle.ts. */
export type { CycleResult, CycleStep } from './auto_cycle';

export interface AppConfig {
  jitoRegions: JitoRegion[];
  tipStrategy: TipStrategy;
  priorityFeeMicroLamports: number;
  retryConfig: RetryConfig;
  ipfs: IpfsConfig | null;
  raydium: RaydiumConfig | null;
  trading: TradingConfig | null;
}

/** Конфиг для отдачи в браузер: без ключей IPFS, bigint → строка (иначе JSON.stringify упадёт). */
export interface PublicConfig extends Omit<AppConfig, 'ipfs' | 'raydium'> {
  ipfs: { provider: IpfsConfig['provider'] } | null;
  ipfsConfigured: boolean;
  raydium: (Omit<RaydiumConfig, 'initialLiquidityTokens'> & { initialLiquidityTokens?: string }) | null;
}

export interface ConfigValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export const DEFAULT_JITO_REGIONS: JitoRegion[] = [
  { id: 'mainnet', url: 'mainnet.block-engine.jito.wtf', enabled: true },
  { id: 'amsterdam', url: 'amsterdam.mainnet.block-engine.jito.wtf', enabled: true },
  { id: 'frankfurt', url: 'frankfurt.mainnet.block-engine.jito.wtf', enabled: true },
  { id: 'tokyo', url: 'tokyo.mainnet.block-engine.jito.wtf', enabled: false },
  { id: 'ny', url: 'ny.mainnet.block-engine.jito.wtf', enabled: false },
];

export const DEFAULT_CONFIG: AppConfig = {
  jitoRegions: DEFAULT_JITO_REGIONS.map((r) => ({ ...r })),
  tipStrategy: { type: 'auto', percentile: 80 },
  priorityFeeMicroLamports: 100_000,
  retryConfig: { maxRetries: 3, tipIncreasePercent: 50, blockhashRefresh: true, regionFallback: true },
  ipfs: null,
  raydium: null,
  trading: null,
};

/** Минимальные чаевые, которые принимает Jito (как в bundle_validation.ts). */
const MIN_TIP_LAMPORTS = 1_000;
/** Выше этого priority fee становится заметной статьёй расходов: 1 000 000 µl/CU × 200k CU = 0.2 SOL. */
const HIGH_PRIORITY_FEE = 1_000_000;
/** Ручные чаевые выше 0.01 SOL — вероятно, опечатка в порядке. */
const HIGH_MANUAL_TIP_LAMPORTS = 10_000_000;

/**
 * Проверяет конфиг. `errors` — с такими значениями модули упадут;
 * `warnings` — работать будет, но, вероятно, не так, как задумано.
 * Рассчитан и на конфиг, пришедший из JSON: не падает на отсутствующих полях.
 */
export function validateConfig(cfg: AppConfig): ConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Регионы Jito
  if (!Array.isArray(cfg.jitoRegions) || cfg.jitoRegions.length === 0) {
    errors.push('jitoRegions: нужен хотя бы один регион');
  } else {
    if (!cfg.jitoRegions.some((r) => r.enabled)) {
      errors.push('jitoRegions: ни один регион не включён — бандлы некуда отправлять');
    }
    cfg.jitoRegions.forEach((r, i) => {
      if (!r.id || !r.url) errors.push(`jitoRegions[${i}]: нужны id и url`);
    });
    const ids = cfg.jitoRegions.map((r) => r.id);
    if (new Set(ids).size !== ids.length) warnings.push('jitoRegions: повторяющиеся id');
  }

  // Чаевые
  const tip = cfg.tipStrategy as Partial<Record<string, unknown>> | undefined;
  switch (tip?.type) {
    case 'manual': {
      const lamports = tip.lamports;
      if (!(typeof lamports === 'number' && Number.isInteger(lamports) && lamports > 0)) {
        errors.push('tipStrategy.lamports: целое число больше 0');
      } else if (lamports < MIN_TIP_LAMPORTS) {
        errors.push(`tipStrategy.lamports: Jito не принимает чаевые меньше ${MIN_TIP_LAMPORTS} лампортов`);
      } else if (lamports > HIGH_MANUAL_TIP_LAMPORTS) {
        warnings.push(`tipStrategy.lamports: ${lamports / 1e9} SOL за бандл — проверьте, не лишний ли ноль`);
      }
      break;
    }
    case 'auto':
    case 'percentile': {
      const p = tip.percentile;
      if (!(typeof p === 'number' && p > 0 && p <= 100)) {
        errors.push('tipStrategy.percentile: от 0 (не включая) до 100');
      }
      if (tip.type === 'percentile') {
        const min = tip.minLamports;
        if (!(typeof min === 'number' && Number.isInteger(min) && min >= MIN_TIP_LAMPORTS)) {
          errors.push(`tipStrategy.minLamports: целое число не меньше ${MIN_TIP_LAMPORTS}`);
        }
      }
      break;
    }
    default:
      errors.push(`tipStrategy.type: ожидалось manual | auto | percentile, получено ${String(tip?.type)}`);
  }

  // Priority fee
  const fee = cfg.priorityFeeMicroLamports;
  if (!(typeof fee === 'number' && Number.isInteger(fee) && fee >= 0)) {
    errors.push('priorityFeeMicroLamports: целое число ≥ 0');
  } else if (fee > HIGH_PRIORITY_FEE) {
    warnings.push(`priorityFeeMicroLamports: ${fee} — дорого, ~${(fee * 200_000) / 1e15} SOL на транзакцию в 200k CU`);
  }

  // Ретраи
  const retry = cfg.retryConfig;
  if (!(Number.isInteger(retry?.maxRetries) && retry.maxRetries >= 1 && retry.maxRetries <= 10)) {
    errors.push('retryConfig.maxRetries: целое число от 1 до 10');
  } else if (retry.maxRetries > 3) {
    warnings.push('retryConfig.maxRetries > 3: без пересборки транзакций их blockhash истечёт раньше последних попыток');
  }
  if (!(typeof retry?.tipIncreasePercent === 'number' && retry.tipIncreasePercent >= 0)) {
    errors.push('retryConfig.tipIncreasePercent: число ≥ 0');
  }

  // Необязательные блоки
  if (cfg.ipfs) {
    if (cfg.ipfs.provider !== 'pinata') errors.push('ipfs.provider: сейчас поддерживается только pinata');
    if (!cfg.ipfs.apiKey || !cfg.ipfs.secret) errors.push('ipfs: нужны apiKey и secret');
  }
  if (cfg.raydium) {
    if (cfg.raydium.initialLiquidityTokens === undefined) {
      warnings.push('raydium.initialLiquidityTokens не задан — создание пула потребует его');
    }
    if (cfg.raydium.lockLp && cfg.raydium.lockPeriodDays > 0) {
      warnings.push('raydium.lockPeriodDays не используется: блокировка Raydium бессрочная');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Конфиг без секретов — для отдачи во фронтенд или логов.
 * Возвращает новые объекты: правки результата не трогают исходный конфиг.
 */
export function toPublicConfig(cfg: AppConfig): PublicConfig {
  const { ipfs, raydium, trading, ...rest } = cfg;
  return {
    ...rest,
    jitoRegions: cfg.jitoRegions.map((r) => ({ ...r })),
    tipStrategy: { ...cfg.tipStrategy },
    retryConfig: { ...cfg.retryConfig },
    ipfs: ipfs ? { provider: ipfs.provider } : null,
    ipfsConfigured: Boolean(ipfs?.apiKey && ipfs.secret),
    raydium: raydium
      ? {
          ...raydium,
          initialLiquidityTokens: raydium.initialLiquidityTokens?.toString(),
        }
      : null,
    trading: trading
      ? { ...trading, dcaIntervals: trading.dcaIntervals?.map((s) => ({ ...s })) }
      : null,
  };
}
