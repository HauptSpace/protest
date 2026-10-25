import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCycle } from './auto_cycle';

const log = vi.fn();

const ok = () => vi.fn(async () => true as const);
const delayed = <T,>(ms: number, value: T) =>
  vi.fn(() => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms)));

async function run(steps: Parameters<typeof runCycle>[0], timeoutMs = 10_000) {
  const promise = runCycle(steps, log, timeoutMs);
  await vi.runAllTimersAsync();
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  log.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runCycle', () => {
  it('3 шага, все true → completed, все done', async () => {
    const result = await run([
      { name: 'a', fn: ok() },
      { name: 'b', fn: ok() },
      { name: 'c', fn: ok() },
    ]);

    expect(result.status).toBe('completed');
    expect(result.steps).toEqual([
      { name: 'a', status: 'done' },
      { name: 'b', status: 'done' },
      { name: 'c', status: 'done' },
    ]);
    expect(result.reason).toBeUndefined();
    expect(log).toHaveBeenCalledWith('info', '[1/3] a: старт');
    expect(log).toHaveBeenCalledWith('success', '[3/3] c: готово');
  });

  it('2 true, 3-й бросает → failed на 3-м, причина из ошибки', async () => {
    const result = await run([
      { name: 'a', fn: ok() },
      { name: 'b', fn: ok() },
      { name: 'c', fn: async () => { throw new Error('RPC down'); } },
    ]);

    expect(result.status).toBe('failed');
    expect(result.steps.map((s) => s.status)).toEqual(['done', 'done', 'failed']);
    expect(result.reason).toBe('Шаг «c»: RPC down');
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('RPC down'));
  });

  it('false останавливает цикл, следующие шаги не запускаются', async () => {
    const after = ok();

    const result = await run([
      { name: 'check', fn: async () => false },
      { name: 'after', fn: after },
    ]);

    expect(result).toMatchObject({ status: 'failed', reason: 'Шаг «check» вернул false' });
    expect(result.steps.map((s) => s.status)).toEqual(['failed', 'pending']);
    expect(after).not.toHaveBeenCalled();
  });

  it('skip → продолжает к следующему шагу', async () => {
    const third = ok();

    const result = await run([
      { name: 'a', fn: ok() },
      { name: 'b', fn: async () => 'skip' as const },
      { name: 'c', fn: third },
    ]);

    expect(result.status).toBe('completed');
    expect(result.steps.map((s) => s.status)).toEqual(['done', 'skipped', 'done']);
    expect(third).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('warn', '[2/3] b: пропущен');
  });

  it('все шаги skip → skipped', async () => {
    const result = await run([
      { name: 'a', fn: async () => 'skip' as const },
      { name: 'b', fn: async () => 'skip' as const },
    ]);

    expect(result.status).toBe('skipped');
  });

  it('общий бюджет превышен во время шага → failed', async () => {
    const result = await run(
      [
        { name: 'fast', fn: delayed(400, true) },
        { name: 'slow', fn: delayed(5_000, true) },
        { name: 'never', fn: ok() },
      ],
      1_000,
    );

    expect(result.status).toBe('failed');
    expect(result.steps.map((s) => s.status)).toEqual(['done', 'failed', 'pending']);
    expect(result.reason).toBe('Бюджет 1000 мс исчерпан на шаге «slow»');
    expect(result.duration).toBe(1_000);
  });

  it('бюджет общий на все шаги, а не на каждый', async () => {
    const result = await run(
      [
        { name: 'a', fn: delayed(600, true) },
        { name: 'b', fn: delayed(600, true) },
      ],
      1_000,
    );

    expect(result.status).toBe('failed');
    expect(result.steps.map((s) => s.status)).toEqual(['done', 'failed']);
  });

  it('duration — фактическое время цикла', async () => {
    const result = await run([
      { name: 'a', fn: delayed(250, true) },
      { name: 'b', fn: delayed(150, true) },
    ]);

    expect(result.duration).toBe(400);
  });

  it('синхронное исключение fn тоже даёт failed, а не падение runCycle', async () => {
    const result = await run([
      {
        name: 'sync',
        fn: () => {
          throw new Error('boom');
        },
      },
    ]);

    expect(result).toMatchObject({ status: 'failed', reason: 'Шаг «sync»: boom' });
  });

  it('ошибка с текстом «Бюджет…» из шага не путается с таймаутом', async () => {
    const result = await run([{ name: 'x', fn: async () => { throw new Error('Бюджет кампании исчерпан'); } }]);

    expect(result.reason).toBe('Шаг «x»: Бюджет кампании исчерпан');
  });

  it('пустой список шагов → completed; некорректный timeout → throw', async () => {
    expect((await run([])).status).toBe('completed');
    await expect(runCycle([], log, 0)).rejects.toThrow(/timeoutMs/);
  });

  it('возвращаемые steps — копия, повторный вызов независим', async () => {
    const steps = [{ name: 'a', fn: ok() }];
    const first = await run(steps);
    first.steps[0].status = 'failed';

    const second = await run(steps);

    expect(second.steps[0].status).toBe('done');
  });
});
