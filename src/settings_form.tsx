import { ReactNode, useEffect, useId, useState } from 'react';

/**
 * Общий интерфейс панелей настроек. `value` типизирован под каждую панель
 * (в ТЗ был `any`): так TypeScript ловит опечатки в полях.
 */
export interface ConfigProps<T> {
  value: T;
  onSave: (patch: Record<string, unknown>) => void;
  onValidate: (patch: Record<string, unknown>) => Promise<{ ok: boolean; errors: string[] }>;
  busy: boolean;
}

/**
 * Локальный черновик формы. Сбрасывается на новое `value`, только когда оно
 * действительно изменилось по содержимому — новый объект с теми же данными
 * при каждом рендере родителя не сотрёт ввод пользователя.
 */
export function useDraft<V, D>(value: V, toDraft: (value: V) => D) {
  const key = stableKey(value);
  const [draft, setDraft] = useState<D>(() => toDraft(value));
  const [savedKey, setSavedKey] = useState(key);

  // toDraft — чистая функция, поэтому зависим только от содержимого value.
  useEffect(() => {
    if (key !== savedKey) {
      setSavedKey(key);
      setDraft(toDraft(value));
    }
  }, [key]);

  const update = (patch: Partial<D>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = stableKey(draft) !== stableKey(toDraft(value));
  return { draft, setDraft, update, dirty };
}

/** JSON-ключ для сравнения; bigint сериализуется строкой. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
}

/** Число из поля ввода: пустая строка и мусор → NaN. */
export function toNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Подпись + поле. `children` получает id для связки label ↔ input. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="field">
        {children(id)}
        {hint && <small className="hint">{hint}</small>}
      </div>
    </>
  );
}

export function Checkbox({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Errors({ errors }: { errors: string[] }) {
  if (errors.length === 0) {
    return null;
  }
  return (
    <ul className="errors" role="alert">
      {errors.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  );
}

/** Кнопка «Применить»: неактивна, пока нет изменений, есть ошибки или идёт сохранение. */
export function ApplyButton({
  busy,
  dirty,
  errors,
  onClick,
  label = 'Применить',
}: {
  busy: boolean;
  dirty: boolean;
  errors: string[];
  onClick: () => void;
  label?: string;
}) {
  return (
    <button type="button" className="btn btn-primary" disabled={busy || !dirty || errors.length > 0} onClick={onClick}>
      {busy ? 'Сохранение…' : label}
    </button>
  );
}

type CheckState = { status: 'idle' } | { status: 'checking' } | { status: 'done'; ok: boolean; errors: string[] };

/**
 * «Проверить» через onValidate. Результат сбрасывается при любом изменении
 * формы, чтобы «ОК» не относилось к уже другим данным.
 */
export function useValidation(onValidate: ConfigProps<unknown>['onValidate'], draftKey: string) {
  const [state, setState] = useState<CheckState>({ status: 'idle' });

  useEffect(() => {
    setState({ status: 'idle' });
  }, [draftKey]);

  const run = async (patch: Record<string, unknown>) => {
    setState({ status: 'checking' });
    try {
      const { ok, errors } = await onValidate(patch);
      setState({ status: 'done', ok, errors });
    } catch (err) {
      setState({ status: 'done', ok: false, errors: [err instanceof Error ? err.message : String(err)] });
    }
  };

  const view =
    state.status === 'checking' ? (
      <p className="status">Проверка…</p>
    ) : state.status === 'done' && state.ok ? (
      <p className="status ok" role="status">
        Подключение работает
      </p>
    ) : state.status === 'done' ? (
      <Errors errors={state.errors.length > 0 ? state.errors : ['Проверка не пройдена']} />
    ) : null;

  return { checking: state.status === 'checking', run, view };
}
