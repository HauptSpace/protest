export interface IpfsConfig {
  provider: 'pinata' | 'arweave';
  apiKey: string;
  secret: string;
}

export interface TokenMetadataInput {
  name: string;
  symbol: string;
  description: string;
  imageBuffer: Buffer;
  imageFilename: string;
}

export const PINATA_API_URL = 'https://api.pinata.cloud';
export const IPFS_GATEWAY_URL = 'https://ipfs.io/ipfs';

/** Таймаут на каждый HTTP-запрос к Pinata. */
export const IPFS_REQUEST_TIMEOUT_MS = 30_000;

/** Ограничения on-chain полей Metaplex Token Metadata (в байтах UTF-8). */
export const MAX_NAME_BYTES = 32;
export const MAX_SYMBOL_BYTES = 10;

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

interface PinResponse {
  IpfsHash?: unknown;
}

/**
 * Загружает картинку и JSON-метаданные токена в IPFS через Pinata
 * и возвращает URL JSON-а для поля `uri` в Metaplex.
 */
export async function uploadTokenMetadata(
  config: IpfsConfig,
  metadata: TokenMetadataInput,
): Promise<string> {
  assertPinata(config);
  validateMetadata(metadata);

  const imageCid = await pinFile(config, metadata.imageBuffer, metadata.imageFilename);

  const jsonCid = await pinJson(config, `${metadata.symbol}-metadata.json`, {
    name: metadata.name,
    symbol: metadata.symbol,
    description: metadata.description,
    image: `${IPFS_GATEWAY_URL}/${imageCid}`,
  });

  return `${IPFS_GATEWAY_URL}/${jsonCid}`;
}

/**
 * Проверяет ключи Pinata. Возвращает false при неверных ключах и сетевых
 * ошибках; бросает только на неподдерживаемом провайдере.
 */
export async function testIpfsConnection(config: IpfsConfig): Promise<boolean> {
  assertPinata(config);
  try {
    const response = await pinataFetch(config, '/data/testAuthentication', { method: 'GET' });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function pinFile(config: IpfsConfig, buffer: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: contentTypeOf(filename) }), filename);
  form.append('pinataMetadata', JSON.stringify({ name: filename }));

  // Content-Type с boundary fetch проставит сам — вручную задавать нельзя.
  const response = await pinataFetch(config, '/pinning/pinFileToIPFS', {
    method: 'POST',
    body: form,
  });
  return readCid(response, 'pinFileToIPFS');
}

async function pinJson(config: IpfsConfig, name: string, content: object): Promise<string> {
  const response = await pinataFetch(config, '/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinataContent: content, pinataMetadata: { name } }),
  });
  return readCid(response, 'pinJSONToIPFS');
}

async function pinataFetch(config: IpfsConfig, path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IPFS_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${PINATA_API_URL}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        pinata_api_key: config.apiKey,
        pinata_secret_api_key: config.secret,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Pinata ${path}: таймаут ${IPFS_REQUEST_TIMEOUT_MS / 1000} с`, { cause: err });
    }
    throw new Error(`Pinata ${path}: сетевая ошибка: ${errorMessage(err)}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

async function readCid(response: Response, method: string): Promise<string> {
  if (!response.ok) {
    const details = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`Pinata ${method}: HTTP ${response.status}${details ? ` — ${details}` : ''}`);
  }
  const body = (await response.json()) as PinResponse;
  if (typeof body.IpfsHash !== 'string' || body.IpfsHash.length === 0) {
    throw new Error(`Pinata ${method}: в ответе нет IpfsHash`);
  }
  return body.IpfsHash;
}

function assertPinata(config: IpfsConfig): void {
  if (config.provider !== 'pinata') {
    throw new Error(`IPFS-провайдер "${config.provider}" пока не поддерживается, только "pinata"`);
  }
  if (!config.apiKey || !config.secret) {
    throw new Error('Для Pinata нужны apiKey и secret');
  }
}

function validateMetadata({ name, symbol, imageBuffer, imageFilename }: TokenMetadataInput): void {
  if (name.trim() === '' || Buffer.byteLength(name) > MAX_NAME_BYTES) {
    throw new Error(`name должен быть непустым и не длиннее ${MAX_NAME_BYTES} байт`);
  }
  if (symbol.trim() === '' || Buffer.byteLength(symbol) > MAX_SYMBOL_BYTES) {
    throw new Error(`symbol должен быть непустым и не длиннее ${MAX_SYMBOL_BYTES} байт`);
  }
  if (imageBuffer.length === 0) {
    throw new Error('imageBuffer пуст');
  }
  if (!Object.hasOwn(IMAGE_CONTENT_TYPES, extensionOf(imageFilename))) {
    throw new Error(
      `Неподдерживаемый формат картинки "${imageFilename}": ` +
        Object.keys(IMAGE_CONTENT_TYPES).join(', '),
    );
  }
}

function contentTypeOf(filename: string): string {
  return IMAGE_CONTENT_TYPES[extensionOf(filename)];
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
