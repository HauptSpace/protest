import type { TradingConfig as TradingValue } from './trading';
import { ApplyButton, ConfigProps, Errors, Field, Panel, toNumber, useDraft } from './settings_form';

/** Общий таймаут стратегии в trading.ts — сумма пауз DCA не может его превышать. */
const STRATEGY_TIMEOUT_SEC = 300;

interface DcaRow {
  /** Пауза перед шагом в секундах (в конфиг уходит в мс). */
  seconds: string;
  percent: string;
}

interface Draft {
  exitStrategy: TradingValue['exitStrategy'];
  targetPrice: string;
  trailingStopPercent: string;
  dca: DcaRow[];
}

const toDraft = (v: TradingValue): Draft => ({
  exitStrategy: v.exitStrategy,
  targetPrice: v.targetPrice?.toString() ?? '',
  trailingStopPercent: String(v.trailingStopPercent ?? 15),
  dca: (v.dcaIntervals ?? [{ time: 30_000, percent: 50 }, { time: 60_000, percent: 100 }]).map((s) => ({
    seconds: String(s.time / 1000),
    percent: String(s.percent),
  })),
});

function parse(d: Draft): { config: TradingValue; errors: string[] } {
  const errors: string[] = [];
  const config: TradingValue = { exitStrategy: d.exitStrategy };

  if (d.exitStrategy === 'target') {
    config.targetPrice = toNumber(d.targetPrice);
    if (!(config.targetPrice > 0)) errors.push('Целевая цена — больше 0');
  }
  if (d.exitStrategy === 'trailing') {
    config.trailingStopPercent = toNumber(d.trailingStopPercent);
    if (!(config.trailingStopPercent > 0 && config.trailingStopPercent < 100)) {
      errors.push('Trailing stop — от 0 до 100 % (не включая)');
    }
  }
  if (d.exitStrategy === 'dca') {
    config.dcaIntervals = d.dca.map((row) => ({ time: toNumber(row.seconds) * 1000, percent: toNumber(row.percent) }));
    if (config.dcaIntervals.length === 0) errors.push('Добавьте хотя бы один шаг');
    config.dcaIntervals.forEach(({ time, percent }, i) => {
      if (!(time >= 0)) errors.push(`Шаг ${i + 1}: пауза — 0 секунд или больше`);
      if (!(percent > 0 && percent <= 100)) errors.push(`Шаг ${i + 1}: процент — от 0 до 100`);
    });
    const total = config.dcaIntervals.reduce((sum, s) => sum + s.time, 0) / 1000;
    if (total > STRATEGY_TIMEOUT_SEC) errors.push(`Сумма пауз ${total} с больше лимита ${STRATEGY_TIMEOUT_SEC} с`);
  }
  return { config, errors };
}

export function TradingConfig({ value, onSave, busy }: ConfigProps<TradingValue>) {
  const { draft, update, dirty } = useDraft(value, toDraft);
  const { config, errors } = parse(draft);

  const setRow = (index: number, patch: Partial<DcaRow>) =>
    update({ dca: draft.dca.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  const lastPercent = draft.dca.at(-1)?.percent;

  return (
    <Panel title="Стратегия выхода">
      <div className="field-grid">
        <Field label="Стратегия">
          {(id) => (
            <select id={id} value={draft.exitStrategy} disabled={busy}
              onChange={(e) => update({ exitStrategy: e.target.value as Draft['exitStrategy'] })}>
              <option value="manual">Вручную</option>
              <option value="target">Целевая цена</option>
              <option value="trailing">Trailing stop</option>
              <option value="dca">DCA (частями по времени)</option>
            </select>
          )}
        </Field>

        {draft.exitStrategy === 'target' && (
          <Field label="Целевая цена, SOL за токен">
            {(id) => (
              <input id={id} type="number" min={0} step="any" value={draft.targetPrice} disabled={busy}
                onChange={(e) => update({ targetPrice: e.target.value })} />
            )}
          </Field>
        )}

        {draft.exitStrategy === 'trailing' && (
          <Field label="Падение от пика, %">
            {(id) => (
              <input id={id} type="number" min={1} max={99} step={1} value={draft.trailingStopPercent} disabled={busy}
                onChange={(e) => update({ trailingStopPercent: e.target.value })} />
            )}
          </Field>
        )}
      </div>

      {draft.exitStrategy === 'dca' && (
        <div className="dca">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Пауза перед шагом, с</th>
                <th>Продать % остатка</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {draft.dca.map((row, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <input type="number" min={0} step={1} aria-label={`Пауза шага ${i + 1}`} value={row.seconds}
                      disabled={busy} onChange={(e) => setRow(i, { seconds: e.target.value })} />
                  </td>
                  <td>
                    <input type="number" min={1} max={100} step={1} aria-label={`Процент шага ${i + 1}`} value={row.percent}
                      disabled={busy} onChange={(e) => setRow(i, { percent: e.target.value })} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-ghost" aria-label={`Удалить шаг ${i + 1}`} disabled={busy}
                      onClick={() => update({ dca: draft.dca.filter((_, j) => j !== i) })}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn" disabled={busy}
            onClick={() => update({ dca: [...draft.dca, { seconds: '30', percent: '100' }] })}>
            + Шаг
          </button>
          {draft.dca.length > 0 && lastPercent !== '100' && (
            <p className="warning" role="note">Последний шаг не 100 % — часть токенов останется непроданной.</p>
          )}
        </div>
      )}

      <Errors errors={errors} />
      <div className="actions">
        <ApplyButton busy={busy} dirty={dirty} errors={errors} onClick={() => onSave({ trading: config })} />
      </div>
    </Panel>
  );
}
