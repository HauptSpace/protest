import { ApplyButton, ConfigProps, Errors, Field, Panel, stableKey, useDraft, useValidation } from './settings_form';

export interface ExchangeKeysValue {
  exchange: string;
  apiKey: string;
  secret: string;
}

export const EXCHANGES = ['binance', 'bybit', 'okx', 'mexc', 'gate', 'kucoin'] as const;

export function ExchangeKeysConfig({ value, onSave, onValidate, busy }: ConfigProps<ExchangeKeysValue>) {
  const { draft, update, dirty } = useDraft(value, (v) => ({ ...v }));
  const validation = useValidation(onValidate, stableKey(draft));
  const patch = { exchangeKeys: draft };

  const errors: string[] = [];
  if (draft.apiKey.trim() === '') errors.push('Укажите API key');
  if (draft.secret.trim() === '') errors.push('Укажите secret');

  // Биржа из сохранённого значения может отсутствовать в списке — не теряем её.
  const exchanges: string[] = EXCHANGES.includes(draft.exchange as (typeof EXCHANGES)[number])
    ? [...EXCHANGES]
    : [draft.exchange, ...EXCHANGES];

  return (
    <Panel title="Ключи биржи">
      <div className="field-grid">
        <Field label="Биржа">
          {(id) => (
            <select id={id} value={draft.exchange} disabled={busy} onChange={(e) => update({ exchange: e.target.value })}>
              {exchanges.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="API key">
          {(id) => (
            <input id={id} type="password" autoComplete="off" spellCheck={false} value={draft.apiKey} disabled={busy}
              onChange={(e) => update({ apiKey: e.target.value })} />
          )}
        </Field>
        <Field label="Secret">
          {(id) => (
            <input id={id} type="password" autoComplete="off" spellCheck={false} value={draft.secret} disabled={busy}
              onChange={(e) => update({ secret: e.target.value })} />
          )}
        </Field>
      </div>
      <Errors errors={errors} />
      {validation.view}
      <div className="actions">
        <button type="button" className="btn" disabled={busy || validation.checking || errors.length > 0}
          onClick={() => void validation.run(patch)}>
          Проверить
        </button>
        <ApplyButton label="Сохранить" busy={busy} dirty={dirty} errors={errors} onClick={() => onSave(patch)} />
      </div>
    </Panel>
  );
}
