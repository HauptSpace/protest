import type { RetryConfig as RetryValue } from './submit_with_retry';
import { ApplyButton, Checkbox, ConfigProps, Errors, Field, Panel, toNumber, useDraft } from './settings_form';

interface Draft {
  maxRetries: string;
  tipIncreasePercent: string;
  blockhashRefresh: boolean;
  regionFallback: boolean;
}

export function RetryConfig({ value, onSave, busy }: ConfigProps<RetryValue>) {
  const { draft, update, dirty } = useDraft(
    value,
    (v): Draft => ({ ...v, maxRetries: String(v.maxRetries), tipIncreasePercent: String(v.tipIncreasePercent) }),
  );
  const maxRetries = toNumber(draft.maxRetries);
  const tipIncreasePercent = toNumber(draft.tipIncreasePercent);

  const errors: string[] = [];
  if (!(Number.isInteger(maxRetries) && maxRetries >= 1 && maxRetries <= 10)) {
    errors.push('Попыток — целое число от 1 до 10');
  }
  if (!(tipIncreasePercent >= 0 && tipIncreasePercent <= 500)) {
    errors.push('Рост чаевых — от 0 до 500 %');
  }

  const save = () =>
    onSave({
      retry: {
        maxRetries,
        tipIncreasePercent,
        blockhashRefresh: draft.blockhashRefresh,
        regionFallback: draft.regionFallback,
      } satisfies RetryValue,
    });

  return (
    <Panel title="Повторные попытки">
      <div className="field-grid">
        <Field label="Всего попыток" hint="Включая первую; каждая — до 30 с">
          {(id) => (
            <input id={id} type="number" min={1} max={10} step={1} value={draft.maxRetries} disabled={busy}
              onChange={(e) => update({ maxRetries: e.target.value })} />
          )}
        </Field>
        <Field label="Рост чаевых за попытку, %">
          {(id) => (
            <input id={id} type="number" min={0} step={5} value={draft.tipIncreasePercent} disabled={busy}
              onChange={(e) => update({ tipIncreasePercent: e.target.value })} />
          )}
        </Field>
        <Checkbox label="Свежий blockhash для tip-транзакции" checked={draft.blockhashRefresh} disabled={busy}
          onChange={(blockhashRefresh) => update({ blockhashRefresh })} />
        <Checkbox label="Со 2-й попытки — все регионы Jito" checked={draft.regionFallback} disabled={busy}
          onChange={(regionFallback) => update({ regionFallback })} />
      </div>
      <Errors errors={errors} />
      <div className="actions">
        <ApplyButton busy={busy} dirty={dirty} errors={errors} onClick={save} />
      </div>
    </Panel>
  );
}
