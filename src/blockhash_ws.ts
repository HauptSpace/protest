export interface BlockhashInfo {
  blockhash: string;
  slot: number;
}

type Listeners = {
  update: (info: BlockhashInfo) => void;
  error: (err: Error) => void;
};

/** Задержки переподключения: 1 с, 2 с, 4 с … но не больше 30 с. */
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

const RPC_TIMEOUT_MS = 10_000;

interface JsonRpcMessage {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
  params?: { result?: { slot?: unknown } };
}

interface LatestBlockhashResult {
  context: { slot: number };
  value: { blockhash: string; lastValidBlockHeight: number };
}

/**
 * Держит в памяти актуальный blockhash: подписывается на слоты через
 * WebSocket (`slotSubscribe`) и на каждый новый слот запрашивает blockhash
 * по HTTP RPC.
 *
 * Blockhash берётся через `getLatestBlockhash` (commitment `confirmed`),
 * а не `getBlock(slot)`: слот из `slotSubscribe` ещё не подтверждён, и
 * `getBlock` для него, как правило, отвечает «Block not available».
 *
 * Ошибки не бросаются наружу, а отдаются слушателям `error`; после разрыва
 * соединения watcher сам переподключается с экспоненциальной задержкой.
 */
export class BlockhashWatcher {
  private readonly httpUrl: string;
  private readonly wsUrl: string;
  private readonly listeners: { [E in keyof Listeners]: Set<Listeners[E]> } = {
    update: new Set(),
    error: new Set(),
  };

  private current: BlockhashInfo | null = null;
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Не более одного HTTP-запроса за раз: слоты идут чаще, чем отвечает RPC. */
  private fetching = false;
  private pendingSlot = false;
  private inflight: AbortController | null = null;

  constructor(rpcUrl: string) {
    const url = new URL(rpcUrl);
    this.httpUrl = url.toString();
    url.protocol = toWsProtocol(url.protocol);
    this.wsUrl = url.toString();
  }

  getCurrent(): BlockhashInfo | null {
    return this.current;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.reconnectAttempt = 0;
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.inflight?.abort();
    this.inflight = null;
    this.pendingSlot = false;

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      detach(ws);
      ws.close();
    }
  }

  on(event: 'update', cb: (info: BlockhashInfo) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: keyof Listeners, cb: Listeners[keyof Listeners]): void {
    (this.listeners[event] as Set<typeof cb>).add(cb);
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this.emitError(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe' }));
    };
    ws.onmessage = (event) => this.handleMessage(ws, event.data);
    ws.onerror = () => {
      this.emitError(new Error(`WebSocket ${this.wsUrl}: ошибка соединения`));
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) {
        return;
      }
      this.ws = null;
      detach(ws);
      this.emitError(
        new Error(`WebSocket ${this.wsUrl} закрыт (code ${event.code}), переподключение`),
      );
      this.scheduleReconnect();
    };
  }

  private handleMessage(ws: WebSocket, data: unknown): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(String(data)) as JsonRpcMessage;
    } catch {
      this.emitError(new Error('WebSocket: некорректный JSON в сообщении'));
      return;
    }

    if (message.id === 1) {
      if (message.error) {
        this.emitError(new Error(`slotSubscribe: ${message.error.message}`));
        ws.close();
        return;
      }
      // Подписка подтверждена — соединение рабочее, сбрасываем backoff.
      this.reconnectAttempt = 0;
      return;
    }

    if (message.method === 'slotNotification') {
      this.onSlot();
    }
  }

  private onSlot(): void {
    if (this.fetching) {
      this.pendingSlot = true;
      return;
    }
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.fetching = true;
    const controller = new AbortController();
    this.inflight = controller;
    try {
      const info = await this.fetchLatestBlockhash(controller.signal);
      if (this.running && (this.current === null || info.slot > this.current.slot)) {
        this.current = info;
        this.emitUpdate(info);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        this.emitError(err);
      }
    } finally {
      if (this.inflight === controller) {
        this.inflight = null;
      }
      this.fetching = false;
      if (this.pendingSlot && this.running) {
        this.pendingSlot = false;
        void this.refresh();
      }
    }
  }

  private async fetchLatestBlockhash(signal: AbortSignal): Promise<BlockhashInfo> {
    const response = await fetch(this.httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'confirmed' }],
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(RPC_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      throw new Error(`getLatestBlockhash: HTTP ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as {
      result?: LatestBlockhashResult;
      error?: { code: number; message: string };
    };
    if (body.error) {
      throw new Error(`getLatestBlockhash: ${body.error.message} (code ${body.error.code})`);
    }
    const blockhash = body.result?.value?.blockhash;
    const slot = body.result?.context?.slot;
    if (typeof blockhash !== 'string' || typeof slot !== 'number') {
      throw new Error('getLatestBlockhash: неожиданный формат ответа');
    }
    return { blockhash, slot };
  }

  private scheduleReconnect(): void {
    if (!this.running) {
      return;
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.running) {
        this.connect();
      }
    }, delay);
  }

  private emitUpdate(info: BlockhashInfo): void {
    for (const cb of this.listeners.update) {
      try {
        cb(info);
      } catch (err) {
        this.emitError(err);
      }
    }
  }

  private emitError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    for (const cb of this.listeners.error) {
      try {
        cb(error);
      } catch {
        // Ошибка в обработчике ошибок не должна ронять watcher.
      }
    }
  }
}

function toWsProtocol(protocol: string): string {
  switch (protocol) {
    case 'https:':
    case 'wss:':
      return 'wss:';
    case 'http:':
    case 'ws:':
      return 'ws:';
    default:
      throw new Error(`Неподдерживаемый протокол RPC: ${protocol}`);
  }
}

function detach(ws: WebSocket): void {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
}
