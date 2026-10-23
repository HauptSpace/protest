export type LogLevel = 'info' | 'success' | 'error';

/** Тело запроса к /api/launch — то же, что LaunchParams в src/pipeline.ts. */
export interface LaunchPayload {
  devPrivateKey: string;
  tipLamports: number;
  name: string;
  symbol: string;
  uri: string;
  buyAmountSol: number;
  walletCount: number;
  solPerWallet: number;
}

export type LaunchEvent =
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'result'; bundleId: string; mint: string; walletsFile: string }
  | { type: 'error'; message: string };

/**
 * Запускает конвейер на локальном сервере и передаёт в onEvent каждое
 * событие сразу, как только сервер его отправил.
 */
export async function launchPipeline(
  payload: LaunchPayload,
  onEvent: (event: LaunchEvent) => void,
): Promise<void> {
  const response = await fetch('/api/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Сервер ответил ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error('Сервер не вернул поток событий');
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line) as LaunchEvent);
    }
  }
}
