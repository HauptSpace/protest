export interface CycleStep {
  name: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
}

export interface CycleResult {
  /**
   * completed — все шаги done или skipped (и хотя бы один done или шагов нет);
   * skipped — все шаги пропущены;
   * failed — шаг вернул false, бросил исключение или вышел общий бюджет времени.
   */
  status: 'completed' | 'skipped' | 'failed';
  steps: CycleStep[];
  /** Длительность цикла, мс. */
  duration: number;
  reason?: string;
}

type Logger = (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void;

/**
 * Выполняет шаги по порядку:
 * - `true` → done, следующий шаг;
 * - `"skip"` → skipped, следующий шаг;
 * - `false` или исключение → failed, цикл останавливается.
 *
 * `timeoutMs` — общий бюджет на весь цикл. Если он вышел во время шага, шаг
 * помечается failed, а цикл завершается. Сам `fn` при этом **не прерывается**
 * (у него нет AbortSignal) — его результат просто игнорируется.
 */
export async function runCycle(
  steps: Array<{ name: string; fn: () => Promise<boolean | 'skip'> }>,
  log: Logger,
  timeoutMs: number,
): Promise<CycleResult> {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error('timeoutMs должен быть положительным числом');
  }

  const started = Date.now();
  const deadline = started + timeoutMs;
  const state: CycleStep[] = steps.map(({ name }) => ({ name, status: 'pending' }));
  const finish = (status: CycleResult['status'], reason?: string): CycleResult => ({
    status,
    steps: state.map((s) => ({ ...s })),
    duration: Date.now() - started,
    ...(reason === undefined ? {} : { reason }),
  });

  for (const [i, { name, fn }] of steps.entries()) {
    const step = state[i];
    const label = `[${i + 1}/${steps.length}] ${name}`;

    const left = deadline - Date.now();
    if (left <= 0) {
      step.status = 'failed';
      const reason = `Бюджет ${timeoutMs} мс исчерпан до шага «${name}»`;
      log('error', `${label}: ${reason}`);
      return finish('failed', reason);
    }

    step.status = 'running';
    log('info', `${label}: старт`);

    let outcome: Awaited<ReturnType<typeof fn>>;
    try {
      outcome = await withTimeout(fn, left, `Бюджет ${timeoutMs} мс исчерпан на шаге «${name}»`);
    } catch (err) {
      step.status = 'failed';
      const reason = err instanceof Error ? err.message : String(err);
      log('error', `${label}: ошибка — ${reason}`);
      return finish('failed', err instanceof BudgetExceededError ? reason : `Шаг «${name}»: ${reason}`);
    }

    if (outcome === true) {
      step.status = 'done';
      log('success', `${label}: готово`);
    } else if (outcome === 'skip') {
      step.status = 'skipped';
      log('warn', `${label}: пропущен`);
    } else {
      step.status = 'failed';
      const reason = `Шаг «${name}» вернул ${String(outcome)}`;
      log('error', `${label}: не выполнен`);
      return finish('failed', reason);
    }
  }

  const allSkipped = state.length > 0 && state.every((s) => s.status === 'skipped');
  const result = finish(allSkipped ? 'skipped' : 'completed');
  log(allSkipped ? 'warn' : 'success', `Цикл ${allSkipped ? 'пропущен' : 'завершён'} за ${result.duration} мс`);
  return result;
}

class BudgetExceededError extends Error {}

/** Ждёт `fn()` не дольше `ms`; синхронное исключение fn тоже превращается в отказ. */
async function withTimeout<T>(fn: () => Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BudgetExceededError(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
