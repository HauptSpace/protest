import type { JitoRegion } from './jito_regions';
import { ApplyButton, Checkbox, ConfigProps, Errors, Panel, useDraft } from './settings_form';

export function JitoRegionsConfig({ value, onSave, busy }: ConfigProps<JitoRegion[]>) {
  const { draft, setDraft, dirty } = useDraft(value, (regions) => regions.map((r) => ({ ...r })));

  const errors = draft.some((r) => r.enabled) ? [] : ['Включите хотя бы один регион'];
  const toggle = (id: string, enabled: boolean) =>
    setDraft((regions) => regions.map((r) => (r.id === id ? { ...r, enabled } : r)));

  return (
    <Panel title="Регионы Jito">
      <div className="field-grid">
        {draft.map((region) => (
          <Checkbox
            key={region.id}
            checked={region.enabled}
            disabled={busy}
            onChange={(enabled) => toggle(region.id, enabled)}
            label={
              <>
                <span>{region.id}</span> <code>{region.url}</code>
              </>
            }
          />
        ))}
      </div>
      <Errors errors={errors} />
      <div className="actions">
        <ApplyButton busy={busy} dirty={dirty} errors={errors} onClick={() => onSave({ jitoRegions: draft })} />
      </div>
    </Panel>
  );
}
