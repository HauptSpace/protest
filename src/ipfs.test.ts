import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IPFS_REQUEST_TIMEOUT_MS,
  IpfsConfig,
  TokenMetadataInput,
  testIpfsConnection,
  uploadTokenMetadata,
} from './ipfs';

const CONFIG: IpfsConfig = { provider: 'pinata', apiKey: 'key-123', secret: 'secret-456' };
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const METADATA: TokenMetadataInput = {
  name: 'Test Token',
  symbol: 'TEST',
  description: 'Токен для тестов',
  imageBuffer: IMAGE,
  imageFilename: 'logo.png',
};

const fetchMock = vi.fn<typeof fetch>();

/** Pinata-заглушка: картинка → "img", JSON → "json", testAuthentication → 200. */
function pinataStub(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.endsWith('/pinning/pinFileToIPFS')) {
    return Promise.resolve(Response.json({ IpfsHash: 'img', PinSize: 7 }));
  }
  if (url.endsWith('/pinning/pinJSONToIPFS')) {
    return Promise.resolve(Response.json({ IpfsHash: 'json', PinSize: 120 }));
  }
  if (url.endsWith('/data/testAuthentication')) {
    return Promise.resolve(Response.json({ message: 'Congratulations!' }));
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
}

function call(index: number) {
  const [url, init] = fetchMock.mock.calls[index];
  return { url: String(url), init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string> };
}

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(pinataStub);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('uploadTokenMetadata', () => {
  it('возвращает https://ipfs.io/ipfs/{jsonCid}', async () => {
    await expect(uploadTokenMetadata(CONFIG, METADATA)).resolves.toBe('https://ipfs.io/ipfs/json');
  });

  it('сначала грузит картинку через FormData с ключами Pinata', async () => {
    await uploadTokenMetadata(CONFIG, METADATA);

    const { url, init, headers } = call(0);
    expect(url).toBe('https://api.pinata.cloud/pinning/pinFileToIPFS');
    expect(init.method).toBe('POST');
    expect(headers).toMatchObject({ pinata_api_key: 'key-123', pinata_secret_api_key: 'secret-456' });
    expect(headers).not.toHaveProperty('Content-Type'); // boundary ставит fetch

    const form = init.body as FormData;
    const file = form.get('file') as File;
    expect(file.name).toBe('logo.png');
    expect(file.type).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(IMAGE);
  });

  it('затем пинит JSON со ссылкой на картинку', async () => {
    await uploadTokenMetadata(CONFIG, METADATA);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const { url, headers, init } = call(1);
    expect(url).toBe('https://api.pinata.cloud/pinning/pinJSONToIPFS');
    expect(headers).toMatchObject({
      'Content-Type': 'application/json',
      pinata_api_key: 'key-123',
      pinata_secret_api_key: 'secret-456',
    });
    expect(JSON.parse(String(init.body)).pinataContent).toEqual({
      name: 'Test Token',
      symbol: 'TEST',
      description: 'Токен для тестов',
      image: 'https://ipfs.io/ipfs/img',
    });
  });

  it('сетевая ошибка fetch → throw', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(uploadTokenMetadata(CONFIG, METADATA)).rejects.toThrow(/сетевая ошибка: fetch failed/);
  });

  it('ошибка HTTP при загрузке картинки → throw, JSON не грузится', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"Invalid API key"}', { status: 401 }));

    await expect(uploadTokenMetadata(CONFIG, METADATA)).rejects.toThrow(/HTTP 401.*Invalid API key/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ответ без IpfsHash → throw', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}));

    await expect(uploadTokenMetadata(CONFIG, METADATA)).rejects.toThrow(/нет IpfsHash/);
  });

  it('прерывает запрос по таймауту 30 с', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );

    const promise = uploadTokenMetadata(CONFIG, METADATA);
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(IPFS_REQUEST_TIMEOUT_MS);

    await expect(promise).rejects.toThrow(/таймаут 30 с/);
  });

  it('проверяет поля до сети', async () => {
    const tooLong = { ...METADATA, name: 'x'.repeat(33) };
    await expect(uploadTokenMetadata(CONFIG, tooLong)).rejects.toThrow(/name/);
    await expect(uploadTokenMetadata(CONFIG, { ...METADATA, symbol: '' })).rejects.toThrow(/symbol/);
    await expect(
      uploadTokenMetadata(CONFIG, { ...METADATA, imageBuffer: Buffer.alloc(0) }),
    ).rejects.toThrow(/imageBuffer/);
    await expect(
      uploadTokenMetadata(CONFIG, { ...METADATA, imageFilename: 'logo.exe' }),
    ).rejects.toThrow(/формат/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('arweave → понятная ошибка', async () => {
    await expect(
      uploadTokenMetadata({ ...CONFIG, provider: 'arweave' }, METADATA),
    ).rejects.toThrow(/arweave.*не поддерживается/);
  });
});

describe('testIpfsConnection', () => {
  it('200 → true', async () => {
    await expect(testIpfsConnection(CONFIG)).resolves.toBe(true);

    const { url, init, headers } = call(0);
    expect(url).toBe('https://api.pinata.cloud/data/testAuthentication');
    expect(init.method).toBe('GET');
    expect(headers).toMatchObject({ pinata_api_key: 'key-123', pinata_secret_api_key: 'secret-456' });
  });

  it('401 → false', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

    await expect(testIpfsConnection(CONFIG)).resolves.toBe(false);
  });

  it('сетевая ошибка → false, без исключения', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(testIpfsConnection(CONFIG)).resolves.toBe(false);
  });
});
