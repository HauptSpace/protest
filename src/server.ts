import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import {
  LaunchConfig,
  LaunchParams,
  LogLevel,
  runLaunchPipeline,
  validateParams,
} from './pipeline';

/**
 * Локальный API для веб-панели. Слушает только 127.0.0.1: через него
 * проходит приватный ключ, поэтому наружу его открывать нельзя.
 */
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8787);
const MAX_BODY_BYTES = 16 * 1024;

const config: LaunchConfig = {
  rpcUrl: process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com',
  blockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL ?? 'mainnet.block-engine.jito.wtf',
  walletsDir: process.env.WALLETS_DIR ?? 'wallets',
};

/** События, которые стримятся в веб-панель построчно (NDJSON). */
type LaunchEvent =
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'result'; bundleId: string; mint: string; walletsFile: string }
  | { type: 'error'; message: string };

let launchInProgress = false;

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/launch') {
    handleLaunch(req, res).catch((error) => {
      console.error('Необработанная ошибка запуска:', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
      else res.end();
    });
    return;
  }
  sendJson(res, 404, { error: 'Не найдено' });
});

async function handleLaunch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (launchInProgress) {
    sendJson(res, 409, { error: 'Конвейер уже запущен, дождитесь завершения' });
    return;
  }

  let params: LaunchParams;
  try {
    params = JSON.parse(await readBody(req)) as LaunchParams;
    validateParams(params);
  } catch (error) {
    sendJson(res, 400, { error: errorMessage(error) });
    return;
  }

  launchInProgress = true;
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  const emit = (event: LaunchEvent) => res.write(`${JSON.stringify(event)}\n`);

  try {
    const result = await runLaunchPipeline(params, config, (level, message) =>
      emit({ type: 'log', level, message }),
    );
    emit({ type: 'result', ...result });
  } catch (error) {
    emit({ type: 'error', message: errorMessage(error) });
  } finally {
    launchInProgress = false;
    res.end();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

server.listen(PORT, HOST, () => {
  console.log(`API панели запущен: http://${HOST}:${PORT}`);
});
