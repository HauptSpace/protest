import { ApplyButton, ConfigProps, Errors, Field, Panel, toNumber, useDraft } from './settings_form';

/** Потолок от опечатки: 10 000 000 µlamports/CU ≈ 2 SOL за транзакцию в 200k CU. */
const MAX_PRIORITY_FEE = 10_000_000;

export function PriorityFeeConfig({ value, onSave, busy }: ConfigProps<number>) {
  const { draft, setDraft, dirty } = useDraft(value, (v) => String(v));
  const fee = toNumber(draft);
  const errors =
    Number.isInteger(fee) && fee >= 0 && fee <= MAX_PRIORITY_FEE
      ? []
      : [`Целое число от 0 до ${MAX_PRIORITY_FEE.toLocaleString('ru-RU')}`];

  return (
    <Panel title="Priority fee">
      <div className="field-grid">
        <Field label="Цена, µlamports за CU" hint="Итог за транзакцию = цена × лимит compute units / 1 000 000">
          {(id) => (
            <input id={id} type="number" min={0} step={1} value={draft} disabled={busy}
              onChange={(e) => setDraft(e.target.value)} />
          )}
        </Field>
      </div>
      <Errors errors={errors} />
      <div className="actions">
        <ApplyButton busy={busy} dirty={dirty} errors={errors} onClick={() => onSave({ priorityFeeMicroLamports: fee })} />
      </div>
    </Panel>
  );
}
