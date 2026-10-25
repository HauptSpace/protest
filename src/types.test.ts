import { describe, expect, it } from 'vitest';

import { DEFAULT_JITO_REGIONS as REGIONS_FROM_JITO_MODULE } from './jito_regions';
import { AppConfig, DEFAULT_CONFIG, DEFAULT_JITO_REGIONS, toPublicConfig, validateConfig } from './types';

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return structuredClone({ ...DEFAULT_CONFIG, ...overrides });
}

describe('DEFAULT_CONFIG', () => {
  it('значения из ТЗ и проходит validateConfig без ошибок и предупреждений', () => {
    expect(DEFAULT_CONFIG.jitoRegions.filter((r) => r.enabled).map((r) => r.id)).toEqual([
      'mainnet',
      'amsterdam',
      'frankfurt',
    ]);
    expect(DEFAULT_CONFIG.jitoRegions).toHaveLength(5);
    expect(DEFAULT_CONFIG.tipStrategy).toEqual({ type: 'auto', percentile: 80 });
    expect(DEFAULT_CONFIG.priorityFeeMicroLamports).toBe(100_000);
    expect(DEFAULT_CONFIG.retryConfig).toEqual({
      maxRetries: 3,
      tipIncreasePercent: 50,
      blockhashRefresh: true,
      regionFallback: true,
    });
    expect([DEFAULT_CONFIG.ipfs, DEFAULT_CONFIG.raydium, DEFAULT_CONFIG.trading]).toEqual([null, null, null]);

    expect(validateConfig(DEFAULT_CONFIG)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('один список регионов на весь проект; DEFAULT_CONFIG держит свою копию', () => {
    expect(REGIONS_FROM_JITO_MODULE).toBe(DEFAULT_JITO_REGIONS);
    expect(DEFAULT_CONFIG.jitoRegions).toEqual(DEFAULT_JITO_REGIONS);
    expect(DEFAULT_CONFIG.jitoRegions).not.toBe(DEFAULT_JITO_REGIONS);
  });
});

describe('validateConfig', () => {
  const errorsOf = (c: AppConfig) => validateConfig(c).errors.join('\n');

  it('jitoRegions: пустой список и ни одного включённого — ошибки', () => {
    expect(errorsOf(cfg({ jitoRegions: [] }))).toMatch(/хотя бы один регион/);
    expect(errorsOf(cfg({ jitoRegions: [{ id: 'a', url: 'a', enabled: false }] }))).toMatch(/ни один регион не включён/);
  });

  it('tipStrategy: неизвестный type, manual ≤ 0, percentile вне 0–100', () => {
    expect(errorsOf(cfg({ tipStrategy: { type: 'magic' } as never }))).toMatch(/tipStrategy.type/);
    expect(errorsOf(cfg({ tipStrategy: { type: 'manual', lamports: 0 } }))).toMatch(/больше 0/);
    expect(errorsOf(cfg({ tipStrategy: { type: 'manual', lamports: 500 } }))).toMatch(/меньше 1000/);
    expect(errorsOf(cfg({ tipStrategy: { type: 'auto', percentile: 0 } }))).toMatch(/percentile/);
    expect(errorsOf(cfg({ tipStrategy: { type: 'auto', percentile: 101 } }))).toMatch(/percentile/);
    expect(errorsOf(cfg({ tipStrategy: { type: 'percentile', percentile: 50, minLamports: 0 } }))).toMatch(/minLamports/);
    expect(validateConfig(cfg({ tipStrategy: { type: 'manual', lamports: 50_000 } })).ok).toBe(true);
  });

  it('retryConfig.maxRetries: 1–10', () => {
    const retry = (maxRetries: number) => cfg({ retryConfig: { ...DEFAULT_CONFIG.retryConfig, maxRetries } });
    expect(errorsOf(retry(0))).toMatch(/maxRetries/);
    expect(errorsOf(retry(11))).toMatch(/maxRetries/);
    expect(errorsOf(retry(2.5))).toMatch(/maxRetries/);
    expect(validateConfig(retry(10)).ok).toBe(true);
    expect(validateConfig(retry(10)).warnings.join()).toMatch(/blockhash истечёт/);
  });

  it('priorityFeeMicroLamports: ≥ 0, очень большой — предупреждение', () => {
    expect(errorsOf(cfg({ priorityFeeMicroLamports: -1 }))).toMatch(/priorityFee/);
    expect(validateConfig(cfg({ priorityFeeMicroLamports: 0 })).ok).toBe(true);
    const high = validateConfig(cfg({ priorityFeeMicroLamports: 5_000_000 }));
    expect(high.ok).toBe(true);
    expect(high.warnings.join()).toMatch(/дорого/);
  });

  it('ipfs и raydium проверяются, если заданы', () => {
    expect(errorsOf(cfg({ ipfs: { provider: 'pinata', apiKey: '', secret: 's' } }))).toMatch(/apiKey и secret/);
    expect(errorsOf(cfg({ ipfs: { provider: 'arweave', apiKey: 'k', secret: 's' } }))).toMatch(/только pinata/);

    const raydium = validateConfig(
      cfg({ raydium: { poolType: 'amm', initialLiquiditySol: 5, lockLp: true, lockPeriodDays: 30 } }),
    );
    expect(raydium.ok).toBe(true);
    expect(raydium.warnings.join('\n')).toMatch(/initialLiquidityTokens не задан[\s\S]*бессрочная/);
  });

  it('не падает на конфиге с пропущенными полями (из JSON)', () => {
    const broken = {} as AppConfig;
    const result = validateConfig(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe('toPublicConfig', () => {
  const full = (): AppConfig =>
    cfg({
      ipfs: { provider: 'pinata', apiKey: 'PINATA-KEY-123', secret: 'PINATA-SECRET-456' },
      raydium: { poolType: 'clmm', initialLiquiditySol: 5, initialLiquidityTokens: 10n ** 15n, lockLp: true, lockPeriodDays: 0 },
      trading: { exitStrategy: 'dca', dcaIntervals: [{ time: 1000, percent: 100 }] },
    });

  it('не отдаёт ключи IPFS, вместо них ipfsConfigured', () => {
    const pub = toPublicConfig(full());

    expect(pub.ipfs).toEqual({ provider: 'pinata' });
    expect(pub.ipfsConfigured).toBe(true);
    const json = JSON.stringify(pub);
    expect(json).not.toContain('PINATA-KEY-123');
    expect(json).not.toContain('PINATA-SECRET-456');
  });

  it('ipfsConfigured=false без ipfs или с пустыми ключами', () => {
    expect(toPublicConfig(cfg()).ipfsConfigured).toBe(false);
    expect(toPublicConfig(cfg()).ipfs).toBeNull();
    expect(toPublicConfig(cfg({ ipfs: { provider: 'pinata', apiKey: 'k', secret: '' } })).ipfsConfigured).toBe(false);
  });

  it('bigint превращается в строку — результат сериализуется в JSON', () => {
    const pub = toPublicConfig(full());

    expect(pub.raydium?.initialLiquidityTokens).toBe('1000000000000000');
    expect(() => JSON.stringify(pub)).not.toThrow();
  });

  it('правки результата не меняют исходный конфиг', () => {
    const source = full();
    const pub = toPublicConfig(source);

    pub.jitoRegions[0].enabled = false;
    pub.retryConfig.maxRetries = 99;
    pub.trading!.dcaIntervals![0].percent = 1;

    expect(source.jitoRegions[0].enabled).toBe(true);
    expect(source.retryConfig.maxRetries).toBe(3);
    expect(source.trading!.dcaIntervals![0].percent).toBe(100);
  });
});
