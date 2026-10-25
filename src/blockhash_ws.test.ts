import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlockhashInfo, BlockhashWatcher } from './blockhash_ws';

/** Подмена глобального WebSocket: сообщения и разрывы шлются из теста. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
  }

  // --- управление из теста ---

  open(): void {
    this.onopen?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Открывает соединение и подтверждает подписку slotSubscribe. */
  subscribe(): void {
    this.open();
    this.receive({ jsonrpc: '2.0', id: 1, result: 42 });
  }

  slot(slot: number): void {
    this.receive({
      jsonrpc: '2.0',
      method: 'slotNotification',
      params: { subscription: 42, result: { slot, parent: slot - 1, root: slot - 32 } },
    });
  }

  drop(code = 1006): void {
    this.onerror?.();
    this.onclose?.({ code });
  }
}

const RPC_URL = 'https://rpc.example.test/?api-key=secret';
const fetchMock = vi.fn<typeof fetch>();

function latestBlockhash(blockhash: string, slot: number): Response {
  return Response.json({
    jsonrpc: '2.0',
    id: 1,
    result: { context: { slot }, value: { blockhash, lastValidBlockHeight: slot + 150 } },
  });
}

/** Даёт отработать промисам (fetch → json → update) без сдвига времени. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function lastSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) {
    throw new Error('WebSocket не создавался');
  }
  return ws;
}

let watcher: BlockhashWatcher;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  fetchMock.mockReset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', fetchMock);
  watcher = new BlockhashWatcher(RPC_URL);
});

afterEach(() => {
  watcher.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BlockhashWatcher', () => {
  it('подключается по wss и подписывается на слоты', () => {
    watcher.start();
    const ws = lastSocket();
    ws.open();

    expect(ws.url).toBe('wss://rpc.example.test/?api-key=secret');
    expect(ws.sent).toEqual([{ jsonrpc: '2.0', id: 1, method: 'slotSubscribe' }]);
  });

  it('на новый слот получает blockhash, обновляет getCurrent и шлёт update', async () => {
    const updates: BlockhashInfo[] = [];
    watcher.on('update', (info) => updates.push(info));
    fetchMock.mockResolvedValueOnce(latestBlockhash('Hash111', 1_000));

    watcher.start();
    expect(watcher.getCurrent()).toBeNull();
    lastSocket().subscribe();
    lastSocket().slot(1_001);
    await flush();

    expect(watcher.getCurrent()).toEqual({ blockhash: 'Hash111', slot: 1_000 });
    expect(updates).toEqual([{ blockhash: 'Hash111', slot: 1_000 }]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(RPC_URL);
    expect(JSON.parse(String(init?.body))).toMatchObject({ method: 'getLatestBlockhash' });
  });

  it('не откатывает current на более старый слот', async () => {
    fetchMock
      .mockResolvedValueOnce(latestBlockhash('Newer', 2_000))
      .mockResolvedValueOnce(latestBlockhash('Older', 1_999));

    watcher.start();
    lastSocket().subscribe();
    lastSocket().slot(2_001);
    await flush();
    lastSocket().slot(2_002);
    await flush();

    expect(watcher.getCurrent()).toEqual({ blockhash: 'Newer', slot: 2_000 });
  });

  it('пока идёт запрос, пачка слотов схлопывается в один повторный запрос', async () => {
    let resolveFirst!: (r: Response) => void;
    fetchMock
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(latestBlockhash('Second', 11));

    watcher.start();
    const ws = lastSocket();
    ws.subscribe();
    ws.slot(10);
    ws.slot(11);
    ws.slot(12);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst(latestBlockhash('First', 10));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(watcher.getCurrent()).toEqual({ blockhash: 'Second', slot: 11 });
  });

  it('ошибка RPC уходит в error и не останавливает watcher', async () => {
    const errors: Error[] = [];
    watcher.on('error', (err) => errors.push(err));
    fetchMock
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(latestBlockhash('Recovered', 5));

    watcher.start();
    lastSocket().subscribe();
    lastSocket().slot(5);
    await flush();

    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('HTTP 503')]);
    expect(watcher.getCurrent()).toBeNull();

    lastSocket().slot(6);
    await flush();
    expect(watcher.getCurrent()).toEqual({ blockhash: 'Recovered', slot: 5 });
  });

  it('stop закрывает WebSocket и больше не переподключается', async () => {
    watcher.start();
    const ws = lastSocket();
    ws.subscribe();

    watcher.stop();

    expect(ws.closed).toBe(true);
    ws.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('при разрыве переподключается с задержками 1с, 2с, 4с … до 30с', async () => {
    const errors: Error[] = [];
    watcher.on('error', (err) => errors.push(err));
    watcher.start();

    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const delay of expectedDelays) {
      const count = FakeWebSocket.instances.length;
      lastSocket().drop();

      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(count + 1);
    }
    expect(errors.length).toBeGreaterThan(0);
  });

  it('после успешной подписки backoff сбрасывается до 1с', async () => {
    watcher.start();
    lastSocket().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    lastSocket().drop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    lastSocket().subscribe();
    lastSocket().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('после переподключения снова получает blockhash', async () => {
    fetchMock.mockResolvedValueOnce(latestBlockhash('AfterReconnect', 77));

    watcher.start();
    lastSocket().subscribe();
    lastSocket().drop();
    await vi.advanceTimersByTimeAsync(1_000);

    const ws = lastSocket();
    ws.subscribe();
    ws.slot(78);
    await flush();

    expect(ws.sent).toEqual([{ jsonrpc: '2.0', id: 1, method: 'slotSubscribe' }]);
    expect(watcher.getCurrent()).toEqual({ blockhash: 'AfterReconnect', slot: 77 });
  });

  it('исключение в обработчике update не роняет watcher', async () => {
    const errors: Error[] = [];
    watcher.on('update', () => {
      throw new Error('listener boom');
    });
    watcher.on('error', (err) => errors.push(err));
    fetchMock.mockResolvedValueOnce(latestBlockhash('Hash', 1));

    watcher.start();
    lastSocket().subscribe();
    lastSocket().slot(2);
    await flush();

    expect(watcher.getCurrent()).toEqual({ blockhash: 'Hash', slot: 1 });
    expect(errors.map((e) => e.message)).toEqual(['listener boom']);
  });
});
