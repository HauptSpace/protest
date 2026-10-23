import { useEffect, useRef, useState, type ReactNode } from 'react';
import { launchPipeline, type LaunchPayload, type LogLevel } from '../api';

const MIN_TIP_LAMPORTS = 1_000;
const MIN_SUB_WALLETS = 1;
const MAX_SUB_WALLETS = 4;
const LAMPORTS_PER_SOL = 1_000_000_000;

interface FormState {
  devPrivateKey: string;
  tipLamports: string;
  name: string;
  symbol: string;
  uri: string;
  buyAmountSol: string;
  walletCount: number;
  solPerWallet: string;
}

type FieldErrors = Partial<Record<keyof FormState, string>>;

interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  message: string;
}

const INITIAL_FORM: FormState = {
  devPrivateKey: '',
  tipLamports: '100000',
  name: '',
  symbol: '',
  uri: '',
  buyAmountSol: '',
  walletCount: 2,
  solPerWallet: '',
};

/** Пустая строка превращается в NaN, запятая допускается как разделитель дробной части. */
function parseNumber(value: string): number {
  const normalized = value.trim().replace(',', '.');
  return normalized === '' ? Number.NaN : Number(normalized);
}

function isValidUri(value: string): boolean {
  try {
    return ['ipfs:', 'https:'].includes(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

function validateForm(form: FormState): { payload?: LaunchPayload; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const tipLamports = parseNumber(form.tipLamports);
  const buyAmountSol = parseNumber(form.buyAmountSol);
  const solPerWallet = parseNumber(form.solPerWallet);

  if (!form.devPrivateKey.trim()) errors.devPrivateKey = 'Введите приватный ключ';
  if (!form.tipLamports.trim()) errors.tipLamports = 'Укажите размер чаевых';
  else if (!Number.isSafeInteger(tipLamports) || tipLamports < MIN_TIP_LAMPORTS) {
    errors.tipLamports = `Целое число, не меньше ${MIN_TIP_LAMPORTS.toLocaleString('ru-RU')}`;
  }
  if (!form.name.trim()) errors.name = 'Введите название';
  if (!form.symbol.trim()) errors.symbol = 'Введите тикер';
  if (!form.uri.trim()) errors.uri = 'Вставьте ссылку на метаданные';
  else if (!isValidUri(form.uri)) errors.uri = 'Ссылка должна начинаться с ipfs:// или https://';
  if (!form.buyAmountSol.trim()) errors.buyAmountSol = 'Укажите сумму';
  else if (!(buyAmountSol > 0)) errors.buyAmountSol = 'Сумма должна быть больше 0';
  if (!form.solPerWallet.trim()) errors.solPerWallet = 'Укажите сумму';
  else if (!(solPerWallet > 0)) errors.solPerWallet = 'Сумма должна быть больше 0';

  if (Object.keys(errors).length > 0) return { errors };

  return {
    errors,
    payload: {
      devPrivateKey: form.devPrivateKey.trim(),
      tipLamports,
      name: form.name.trim(),
      symbol: form.symbol.trim().toUpperCase(),
      uri: form.uri.trim(),
      buyAmountSol,
      walletCount: form.walletCount,
      solPerWallet,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function LaunchPanel() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [showKey, setShowKey] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const nextLogId = useRef(0);
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }, [logs]);

  const appendLog = (level: LogLevel, message: string) => {
    const entry: LogEntry = {
      id: nextLogId.current++,
      time: new Date().toLocaleTimeString('ru-RU'),
      level,
      message,
    };
    setLogs((prev) => [...prev, entry]);
  };

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const handleLaunch = async () => {
    if (isRunning) return;

    const { payload, errors: validationErrors } = validateForm(form);
    setErrors(validationErrors);
    if (!payload) {
      appendLog('error', 'Заполните поля, отмеченные красным');
      return;
    }

    setIsRunning(true);
    appendLog('info', 'Запуск конвейера...');
    let finished = false;
    try {
      await launchPipeline(payload, (event) => {
        if (event.type === 'log') {
          appendLog(event.level, event.message);
        } else if (event.type === 'result') {
          finished = true;
          appendLog('success', `Токен: ${event.mint}`);
        } else {
          finished = true;
          appendLog('error', `Ошибка: ${event.message}`);
        }
      });
      if (!finished) {
        appendLog(
          'error',
          'Связь с сервером прервалась до завершения. Проверьте в обозревателе, не был ли бандл отправлен, прежде чем запускать снова.',
        );
      }
    } catch (error) {
      appendLog('error', `Ошибка: ${errorMessage(error)}`);
    } finally {
      setIsRunning(false);
    }
  };

  const buyAmount = parseNumber(form.buyAmountSol);
  const perWallet = parseNumber(form.solPerWallet);
  const tip = parseNumber(form.tipLamports);
  const totalSol =
    buyAmount > 0 && perWallet > 0 && tip > 0
      ? buyAmount + perWallet * form.walletCount + tip / LAMPORTS_PER_SOL
      : null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">Панель запуска токена</h1>
          <p className="text-sm text-slate-400">
            Pump.fun + Jito: создание токена и покупки суб-кошельков одним бандлом
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Кошелёк разработчика" step={1}>
            <Field label="Приватный ключ" hint="base58 или JSON-массив" error={errors.devPrivateKey}>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={form.devPrivateKey}
                  onChange={(e) => updateField('devPrivateKey', e.target.value)}
                  disabled={isRunning}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="••••••••••••••••"
                  className={`${inputClass(errors.devPrivateKey)} pr-20 font-mono`}
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute inset-y-0 right-0 px-3 text-xs text-slate-400 hover:text-slate-200"
                >
                  {showKey ? 'Скрыть' : 'Показать'}
                </button>
              </div>
            </Field>
            <Field label="Чаевые Jito" hint="в лампортах" error={errors.tipLamports}>
              <input
                type="text"
                inputMode="numeric"
                value={form.tipLamports}
                onChange={(e) => updateField('tipLamports', e.target.value)}
                disabled={isRunning}
                placeholder="100000"
                className={inputClass(errors.tipLamports)}
              />
            </Field>
          </Card>

          <Card title="Настройка токена" step={2}>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Название (Name)" error={errors.name}>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  disabled={isRunning}
                  maxLength={32}
                  placeholder="My Token"
                  className={inputClass(errors.name)}
                />
              </Field>
              <Field label="Тикер (Symbol)" error={errors.symbol}>
                <input
                  type="text"
                  value={form.symbol}
                  onChange={(e) => updateField('symbol', e.target.value)}
                  disabled={isRunning}
                  maxLength={10}
                  placeholder="MTK"
                  className={`${inputClass(errors.symbol)} uppercase`}
                />
              </Field>
            </div>
            <Field label="Метаданные (URI)" hint="IPFS-ссылка на JSON" error={errors.uri}>
              <input
                type="text"
                value={form.uri}
                onChange={(e) => updateField('uri', e.target.value)}
                disabled={isRunning}
                spellCheck={false}
                placeholder="https://ipfs.io/ipfs/Qm..."
                className={`${inputClass(errors.uri)} font-mono text-xs`}
              />
            </Field>
            <Field label="Первая покупка (Buy Amount)" hint="SOL" error={errors.buyAmountSol}>
              <input
                type="text"
                inputMode="decimal"
                value={form.buyAmountSol}
                onChange={(e) => updateField('buyAmountSol', e.target.value)}
                disabled={isRunning}
                placeholder="0.5"
                className={inputClass(errors.buyAmountSol)}
              />
            </Field>
          </Card>

          <Card title="Суб-кошельки" step={3}>
            <Field label="Количество кошельков">
              <div className="flex items-center gap-4">
                <input
                  type="range"
                  min={MIN_SUB_WALLETS}
                  max={MAX_SUB_WALLETS}
                  step={1}
                  value={form.walletCount}
                  onChange={(e) => updateField('walletCount', Number(e.target.value))}
                  disabled={isRunning}
                  className="h-2 flex-1 cursor-pointer accent-emerald-500 disabled:cursor-not-allowed"
                />
                <span className="w-10 rounded-md bg-slate-800 py-1 text-center font-mono text-lg font-semibold text-emerald-400">
                  {form.walletCount}
                </span>
              </div>
              <div className="mt-1 flex justify-between px-0.5 text-xs text-slate-500">
                {Array.from({ length: MAX_SUB_WALLETS - MIN_SUB_WALLETS + 1 }, (_, i) => (
                  <span key={i}>{MIN_SUB_WALLETS + i}</span>
                ))}
              </div>
            </Field>
            <Field label="Сумма на каждый кошелёк" hint="SOL" error={errors.solPerWallet}>
              <input
                type="text"
                inputMode="decimal"
                value={form.solPerWallet}
                onChange={(e) => updateField('solPerWallet', e.target.value)}
                disabled={isRunning}
                placeholder="0.1"
                className={inputClass(errors.solPerWallet)}
              />
            </Field>
          </Card>
        </div>

        <section className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-slate-400">
            Потребуется примерно{' '}
            <span className="font-mono font-semibold text-slate-100">
              {totalSol === null ? '—' : `${totalSol.toFixed(4)} SOL`}
            </span>{' '}
            без учёта сетевых комиссий
          </div>
          <button
            type="button"
            onClick={handleLaunch}
            disabled={isRunning}
            className="flex items-center justify-center gap-3 rounded-xl bg-emerald-500 px-10 py-4 text-lg font-bold tracking-wide text-slate-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 disabled:shadow-none"
          >
            {isRunning && (
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            )}
            {isRunning ? 'ВЫПОЛНЯЕТСЯ...' : 'ЗАПУСТИТЬ КОНВЕЙЕР'}
          </button>
        </section>

        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-black">
          <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full bg-red-500/80" />
              <span className="h-3 w-3 rounded-full bg-yellow-500/80" />
              <span className="h-3 w-3 rounded-full bg-green-500/80" />
              <span className="ml-2 font-mono text-xs text-slate-400">Terminal Log</span>
            </div>
            <button
              type="button"
              onClick={() => setLogs([])}
              disabled={isRunning || logs.length === 0}
              className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-40"
            >
              Очистить
            </button>
          </div>
          <div
            ref={terminalRef}
            role="log"
            aria-live="polite"
            className="h-72 overflow-y-auto p-4 font-mono text-sm leading-relaxed"
          >
            {logs.length === 0 ? (
              <p className="text-slate-600">Ожидание запуска...</p>
            ) : (
              logs.map((entry) => (
                <div key={entry.id} className="flex gap-3">
                  <span className="shrink-0 text-slate-600">[{entry.time}]</span>
                  <span className={`break-all ${LOG_COLORS[entry.level]}`}>{entry.message}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const LOG_COLORS: Record<LogLevel, string> = {
  info: 'text-slate-300',
  success: 'text-emerald-400',
  error: 'text-red-400',
};

function inputClass(error?: string): string {
  const border = error
    ? 'border-red-500 focus:border-red-400 focus:ring-red-500/30'
    : 'border-slate-700 focus:border-emerald-500 focus:ring-emerald-500/30';
  return `w-full rounded-lg border bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:ring-2 disabled:opacity-50 ${border}`;
}

function Card({ title, step, children }: { title: string; step: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
      <h2 className="flex items-center gap-3 text-base font-semibold">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/15 text-sm text-emerald-400">
          {step}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between text-sm text-slate-300">
        {label}
        {hint && <span className="text-xs text-slate-500">{hint}</span>}
      </span>
      {children}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </label>
  );
}
