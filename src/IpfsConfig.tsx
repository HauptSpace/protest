import type { IpfsConfig as IpfsValue } from './ipfs';
import { ApplyButton, ConfigProps, Errors, Field, Panel, stableKey, useDraft, useValidation } from './settings_form';

export function IpfsConfig({ value, onSave, onValidate, busy }: ConfigProps<IpfsValue>) {
  const { draft, update, dirty } = useDraft(value, (v) => ({ ...v }));
  const validation = useValidation(onValidate, stableKey(draft));
  const patch = { ipfs: draft };

  const errors: string[] = [];
  if (draft.provider !== 'pinata') errors.push('Сейчас поддерживается только Pinata');
  if (draft.apiKey.trim() === '') errors.push('Укажите API key');
  if (draft.secret.trim() === '') errors.push('Укажите API secret');

  return (
    <Panel title="IPFS">
      <div className="field-grid">
        <Field label="Провайдер">
          {(id) => (
            <select id={id} value={draft.provider} disabled={busy}
              onChange={(e) => update({ provider: e.target.value as IpfsValue['provider'] })}>
              <option value="pinata">Pinata</option>
              <option value="arweave">Arweave (пока не поддерживается)</option>
            </select>
          )}
        </Field>
        <Field label="API key">
          {(id) => (
            <input id={id} type="password" autoComplete="off" spellCheck={false} value={draft.apiKey} disabled={busy}
              onChange={(e) => update({ apiKey: e.target.value })} />
          )}
        </Field>
        <Field label="API secret" hint="Legacy-ключи Pinata: API Key + API Secret">
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
