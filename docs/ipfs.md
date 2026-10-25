# `src/ipfs.ts` — загрузка метаданных токена в IPFS (Pinata)

- `uploadTokenMetadata(config, metadata)` → `https://ipfs.io/ipfs/{jsonCid}` — готовое
  значение для поля `uri` метаданных Metaplex.
- `testIpfsConnection(config)` → `true`, если ключи Pinata рабочие.

Шаги: картинка → `pinFileToIPFS` (получаем `imageCid`) → JSON `{ name, symbol, description,
image }` → `pinJSONToIPFS` (получаем `jsonCid`). Таймаут 30 с на каждый запрос.

## Что изменено относительно ТЗ и почему

### 1. `provider: "arweave"` — не реализован, бросает ошибку
В контракте он есть, а в описании поведения — только Pinata. Чтобы конфиг с `arweave` не
отработал молча как Pinata, обе функции бросают понятную ошибку
`IPFS-провайдер "arweave" пока не поддерживается`. Если Arweave нужен (например, через
Irys/Bundlr), это отдельная задача.

### 2. JSON отправляется в обёртке `pinataContent`
В ТЗ тело — сами поля `{ name, symbol, … }`. Документированный формат Pinata —
`{ pinataContent: {...}, pinataMetadata: { name } }`. В IPFS попадает **только**
`pinataContent`, то есть ровно те поля, что в ТЗ. `pinataMetadata.name` — подпись файла в
дашборде Pinata (`TEST-metadata.json`, а для картинки — её имя файла), чтобы файлы не
назывались просто хешами.

### 3. `testIpfsConnection` не бросает на сетевых ошибках
Функция возвращает `boolean`, поэтому таймаут, сетевая ошибка и не-200 дают `false`.
Бросает только на неподдерживаемом провайдере или пустых ключах — это ошибка конфигурации,
а не соединения.

### 4. Проверки до загрузки (сверх ТЗ)
Ничего не грузится и не тратит квоту Pinata, если данные заведомо не подойдут:
- `name` — непустой, ≤ 32 байт UTF-8; `symbol` — непустой, ≤ 10 байт. Это лимиты on-chain
  полей Metaplex: с более длинными значениями создание метаданных токена всё равно упадёт,
  а файлы в IPFS уже останутся.
- Картинка непустая; расширение — `png`, `jpg`/`jpeg`, `gif`, `webp` или `svg`.
  По нему же ставится правильный `Content-Type`, иначе кошельки могут не показать картинку.

### 5. Понятные ошибки
`HTTP 401 — {"error":"Invalid API key"}` (первые 200 символов ответа), `таймаут 30 с`,
`сетевая ошибка: …`, `в ответе нет IpfsHash`. Ключи в текст ошибок не попадают.

## Как встроить в код

```ts
import { readFile } from 'node:fs/promises';
import { testIpfsConnection, uploadTokenMetadata, IpfsConfig } from './ipfs';

const ipfs: IpfsConfig = {
  provider: 'pinata',
  apiKey: process.env.PINATA_API_KEY!,
  secret: process.env.PINATA_SECRET!,
};

// при старте или при сохранении настроек
if (!(await testIpfsConnection(ipfs))) {
  throw new Error('Ключи Pinata не работают');
}

// перед созданием токена
const uri = await uploadTokenMetadata(ipfs, {
  name: 'My Token',
  symbol: 'MYT',
  description: '…',
  imageBuffer: await readFile('logo.png'),
  imageFilename: 'logo.png',
});
// uri → поле `uri` в createMetadataAccountV3 / createV1 (Metaplex) или в create у pump.fun
```

- **Порядок:** сначала метаданные, потом создание токена — `uri` нужен в той же транзакции.
  Загрузку можно сделать заранее, пока собираются остальные транзакции бандла.
- **Ключи — только на сервере**, из переменных окружения. В браузер их отдавать нельзя:
  с ними любой может пинить файлы за ваш счёт.
- **Ключи Pinata:** нужны legacy-ключи (API Key + API Secret). Если создаёте scoped-ключ,
  дайте ему права `pinFileToIPFS`, `pinJSONToIPFS` и `testAuthentication`. JWT-авторизация
  (`Authorization: Bearer`) сейчас не поддерживается — скажите, если нужна.
- **Шлюз `ipfs.io`** публичный и бывает медленным или ограничивает частоту запросов.
  Кошельки и обозреватели обычно грузят картинку сами, но если она «не появляется»,
  поменяйте константу `IPFS_GATEWAY_URL` на выделенный шлюз Pinata
  (`https://<ваш-шлюз>.mypinata.cloud/ipfs`). Длина `uri` при этом должна остаться ≤ 200 символов.
- **Повторная загрузка** той же картинки даёт тот же CID — IPFS адресует по содержимому,
  дубликатов не будет.
