import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTO_FALLBACK_TIP_LAMPORTS,
  JITO_TIP_FLOOR_HOST,
  calculateTip,
  getRecentLandedTips,
  median,
  percentileValue,
} from './tip_strategy';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('calculateTip', () => {
  it('manual → ровно lamports', async () => {
    await expect(calculateTip({ type: 'manual', lamports: 50_000 })).resolves.toBe(50_000);
  });

  it('manual с неположительной суммой → ошибка', async () => {
    await expect(calculateTip({ type: 'manual', lamports: 0 })).rejects.toThrow(/lamports/);
    await expect(calculateTip({ type: 'manual', lamports: -5 })).rejects.toThrow(/lamports/);
  });

  it('auto [1M, 2M, 3M], percentile=80 → 2.4M', async () => {
    const tip = await calculateTip(
      { type: 'auto', percentile: 80 },
      [3_000_000, 1_000_000, 2_000_000],
    );
    expect(tip).toBe(2_400_000);
  });

  it('auto без данных → fallback 1M', async () => {
    await expect(calculateTip({ type: 'auto', percentile: 80 }, [])).resolves.toBe(
      AUTO_FALLBACK_TIP_LAMPORTS,
    );
    await expect(calculateTip({ type: 'auto', percentile: 80 })).resolves.toBe(1_000_000);
  });

  it('percentile не опускается ниже minLamports', async () => {
    const tip = await calculateTip(
      { type: 'percentile', percentile: 50, minLamports: 1_000_000 },
      [10_000, 20_000, 30_000],
    );
    expect(tip).toBe(1_000_000);
  });

  it('percentile выше minLamports возвращает сам перцентиль', async () => {
    const tip = await calculateTip(
      { type: 'percentile', percentile: 80, minLamports: 1_000_000 },
      [1_000_000, 2_000_000, 3_000_000],
    );
    expect(tip).toBe(2_400_000);
  });

  it('percentile без данных → minLamports', async () => {
    await expect(
      calculateTip({ type: 'percentile', percentile: 90, minLamports: 1_500_000 }, []),
    ).resolves.toBe(1_500_000);
  });

  it('percentile вне (0, 100] → ошибка', async () => {
    await expect(calculateTip({ type: 'auto', percentile: 0 }, [1])).rejects.toThrow(/percentile/);
    await expect(calculateTip({ type: 'auto', percentile: 101 }, [1])).rejects.toThrow(/percentile/);
  });
});

describe('median', () => {
  it('нечётная и чётная длина, вход не мутируется', () => {
    const input = [3, 1, 2];
    expect(median(input)).toBe(2);
    expect(input).toEqual([3, 1, 2]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('пустой массив → ошибка', () => {
    expect(() => median([])).toThrow();
  });
});

describe('percentileValue', () => {
  it('интерполирует по рангу p·n и прижимается к краям', () => {
    expect(percentileValue([1, 2, 3], 0.8)).toBeCloseTo(2.4);
    expect(percentileValue([1, 2, 3], 0)).toBe(1);
    expect(percentileValue([1, 2, 3], 1)).toBe(3);
    expect(percentileValue([7], 0.5)).toBe(7);
  });

  it('некорректный вход → ошибка', () => {
    expect(() => percentileValue([], 0.5)).toThrow();
    expect(() => percentileValue([1], 1.5)).toThrow();
  });
});

describe('getRecentLandedTips', () => {
  const snapshot = {
    time: '2026-10-25T00:00:00Z',
    landed_tips_25th_percentile: 0.00001,
    landed_tips_50th_percentile: 0.00005,
    landed_tips_75th_percentile: 0.0001,
    landed_tips_95th_percentile: 0.001,
    landed_tips_99th_percentile: 0.01,
    ema_landed_tips_50th_percentile: 0.00004,
  };

  it('запрашивает tip_floor и переводит SOL в лампорты', async () => {
    fetchMock.mockResolvedValue(Response.json([snapshot]));

    const tips = await getRecentLandedTips(JITO_TIP_FLOOR_HOST);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://bundles.jito.wtf/api/v1/bundles/tip_floor',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(tips).toEqual([10_000, 50_000, 100_000, 1_000_000, 10_000_000]);
  });

  it('учитывает не больше limit снимков и пропускает мусорные значения', async () => {
    fetchMock.mockResolvedValue(
      Response.json([
        { ...snapshot, landed_tips_99th_percentile: null },
        { landed_tips_50th_percentile: 0.5 },
      ]),
    );

    expect(await getRecentLandedTips(JITO_TIP_FLOOR_HOST, 1)).toEqual([
      10_000, 50_000, 100_000, 1_000_000,
    ]);
  });

  it('HTTP-ошибка → throw', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));

    await expect(getRecentLandedTips(JITO_TIP_FLOOR_HOST)).rejects.toThrow(/HTTP 503/);
  });

  it('результат подходит для calculateTip', async () => {
    fetchMock.mockResolvedValue(Response.json([snapshot]));

    const tips = await getRecentLandedTips(JITO_TIP_FLOOR_HOST);
    const tip = await calculateTip({ type: 'percentile', percentile: 50, minLamports: 1_000 }, tips);

    // ранг 2.5 из 5 → между 50 000 и 100 000
    expect(tip).toBe(75_000);
  });
});
