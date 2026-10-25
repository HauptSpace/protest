import type { RaydiumConfig as RaydiumValue } from './raydium';
import { ApplyButton, Checkbox, ConfigProps, Errors, Field, Panel, toNumber, useDraft } from './settings_form';

interface Draft {
  poolType: RaydiumValue['poolType'];
  initialLiquiditySol: string;
  initialLiquidityTokens: string;
  lockLp: boolean;
  lockPeriodDays: string;
}

const toDraft = (v: RaydiumValue): Draft => ({
  poolType: v.poolType,
  initialLiquiditySol: String(v.initialLiquiditySol),
  initialLiquidityTokens: v.initialLiquidityTokens?.toString() ?? '',
  lockLp: v.lockLp,
  lockPeriodDays: String(v.lockPeriodDays),
});

export function RaydiumConfig({ value, onSave, busy }: ConfigProps<RaydiumValue>) {
  const { draft, update, dirty } = useDraft(value, toDraft);
  const sol = toNumber(draft.initialLiquiditySol);
  const tokensValid = /^\d+$/.test(draft.initialLiquidityTokens.trim()) && BigInt(draft.initialLiquidityTokens.trim()) > 0n;

  const errors: string[] = [];
  if (!(sol > 0)) errors.push('SOL в пул — больше 0');
  if (!tokensValid) errors.push('Токены в пул — целое число больше 0 (минимальные единицы)');

  const save = () =>
    onSave({
      raydium: {
        poolType: draft.poolType,
        initialLiquiditySol: sol,
        initialLiquidityTokens: BigInt(draft.initialLiquidityTokens.trim()),
        lockLp: draft.lockLp,
        // Блокировка Raydium бессрочная — срок не используется, сохраняем как есть.
        lockPeriodDays: toNumber(draft.lockPeriodDays) || 0,
      } satisfies RaydiumValue,
    });

  return (
    <Panel title="Пул Raydium">
      <div className="field-grid">
        <Field label="Тип пула">
          {(id) => (
            <select id={id} value={draft.poolType} disabled={busy}
              onChange={(e) => update({ poolType: e.target.value as Draft['poolType'] })}>
              <option value="amm">AMM (CPMM, x·y=k)</option>
              <option value="clmm">CLMM (концентрированная, весь диапазон)</option>
            </select>
          )}
        </Field>
        <Field label="SOL в пул">
          {(id) => (
            <input id={id} type="number" min={0} step={0.1} value={draft.initialLiquiditySol} disabled={busy}
              onChange={(e) => update({ initialLiquiditySol: e.target.value })} />
          )}
        </Field>
        <Field label="Токены в пул" hint="В минимальных единицах: 800 млн токенов при decimals 6 = 800000000000000">
          {(id) => (
            <input id={id} inputMode="numeric" value={draft.initialLiquidityTokens} disabled={busy}
              onChange={(e) => update({ initialLiquidityTokens: e.target.value })} />
          )}
        </Field>
        <Checkbox label="Заблокировать ликвидность" checked={draft.lockLp} disabled={busy}
          onChange={(lockLp) => update({ lockLp })} />
        <Field label="Срок блокировки, дней" hint="Не используется: Raydium блокирует навсегда">
          {(id) => <input id={id} type="number" value={draft.lockPeriodDays} disabled readOnly />}
        </Field>
      </div>
      {draft.lockLp && (
        <p className="warning" role="note">
          Блокировка необратима: ликвидность нельзя будет вывести никогда, только забирать комиссии.
        </p>
      )}
      <Errors errors={errors} />
      <div className="actions">
        <ApplyButton busy={busy} dirty={dirty} errors={errors} onClick={save} />
      </div>
    </Panel>
  );
}
