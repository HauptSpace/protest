import type { TipStrategy } from './tip_strategy';
import { ApplyButton, ConfigProps, Errors, Field, Panel, toNumber, useDraft } from './settings_form';

export interface TipStrategyValue {
  type: 'manual' | 'auto' | 'percentile';
  lamports?: number;
  percentile?: number;
  minLamports?: number;
}

interface Draft {
  type: TipStrategyValue['type'];
  lamports: string;
  percentile: string;
  minLamports: string;
}

const MIN_TIP_LAMPORTS = 1_000;

const toDraft = (v: TipStrategyValue): Draft => ({
  type: v.type,
  lamports: String(v.lamports ?? 10_000),
  percentile: String(v.percentile ?? 75),
  minLamports: String(v.minLamports ?? 10_000),
});

/** Черновик → стратегия для calculateTip + ошибки валидации. */
function parse(d: Draft): { strategy: TipStrategy | null; errors: string[] } {
  const errors: string[] = [];
  const lamports = toNumber(d.lamports);
  const percentile = toNumber(d.percentile);
  const minLamports = toNumber(d.minLamports);

  if (d.type === 'manual' && !(Number.isInteger(lamports) && lamports >= MIN_TIP_LAMPORTS)) {
    errors.push(`Чаевые — целое число не меньше ${MIN_TIP_LAMPORTS} лампортов`);
  }
  if (d.type !== 'manual' && !(percentile > 0 && percentile <= 100)) {
    errors.push('Перцентиль — от 0 (не включая) до 100');
  }
  if (d.type === 'percentile' && !(Number.isInteger(minLamports) && minLamports >= MIN_TIP_LAMPORTS)) {
    errors.push(`Минимум — целое число не меньше ${MIN_TIP_LAMPORTS} лампортов`);
  }
  if (errors.length > 0) {
    return { strategy: null, errors };
  }

  const strategy: TipStrategy =
    d.type === 'manual'
      ? { type: 'manual', lamports }
      : d.type === 'auto'
        ? { type: 'auto', percentile }
        : { type: 'percentile', percentile, minLamports };
  return { strategy, errors };
}

export function TipStrategyConfig({ value, onSave, busy }: ConfigProps<TipStrategyValue>) {
  const { draft, update, dirty } = useDraft(value, toDraft);
  const { strategy, errors } = parse(draft);

  return (
    <Panel title="Чаевые Jito">
      <div className="field-grid">
        <Field label="Стратегия">
          {(id) => (
            <select
              id={id}
              value={draft.type}
              disabled={busy}
              onChange={(e) => update({ type: e.target.value as Draft['type'] })}
            >
              <option value="manual">Фиксированная сумма</option>
              <option value="auto">Авто (перцентиль, без данных — 0.001 SOL)</option>
              <option value="percentile">Перцентиль с минимумом</option>
            </select>
          )}
        </Field>

        {draft.type === 'manual' && (
          <Field label="Чаевые, лампорты">
            {(id) => (
              <input id={id} type="number" min={MIN_TIP_LAMPORTS} step={1} value={draft.lamports} disabled={busy}
                onChange={(e) => update({ lamports: e.target.value })} />
            )}
          </Field>
        )}

        {draft.type !== 'manual' && (
          <Field label="Перцентиль, %" hint="75–95 — типично для быстрого попадания в блок">
            {(id) => (
              <input id={id} type="number" min={1} max={100} step={1} value={draft.percentile} disabled={busy}
                onChange={(e) => update({ percentile: e.target.value })} />
            )}
          </Field>
        )}

        {draft.type === 'percentile' && (
          <Field label="Минимум, лампорты">
            {(id) => (
              <input id={id} type="number" min={MIN_TIP_LAMPORTS} step={1} value={draft.minLamports} disabled={busy}
                onChange={(e) => update({ minLamports: e.target.value })} />
            )}
          </Field>
        )}
      </div>
      <Errors errors={errors} />
      <div className="actions">
        <ApplyButton busy={busy} dirty={dirty} errors={errors} onClick={() => strategy && onSave({ tipStrategy: strategy })} />
      </div>
    </Panel>
  );
}
