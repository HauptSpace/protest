# `src/types.ts` — общие типы, конфиг по умолчанию, проверка

- Все типы из ТЗ: `JitoRegion`, `TipStrategy`, `RetryConfig`, `IpfsConfig`, `RaydiumConfig`,
  `TradingConfig`, `NetworkConditions`, `CycleResult` (+ `CycleStep`).
- `AppConfig` — общий конфиг; `DEFAULT_CONFIG` — значения по умолчанию.
- `validateConfig(cfg)` → `{ ok, errors, warnings }`.
- `toPublicConfig(cfg)` → `PublicConfig` без секретов.

## Что изменено/дополнено относительно ТЗ и почему

### 1. Типы реэкспортируются из модулей, а не объявляются заново
Все эти типы уже объявлены в модулях (`jito_regions.ts`, `tip_strategy.ts`, …). Две копии
одного типа со временем разъедутся: поменяете поле в модуле — `types.ts` об этом не узнает.
Поэтому `types.ts` делает `export type { … } from './модуль'`: импортировать можно отсюда, а
определение одно. `export type` стирается при сборке — проверено, что `dist/types.js` не
загружает ни одного модуля, то есть импорт `types.ts` не тянет за собой SDK Raydium и т.п.

### 2. Два отличия от текста ТЗ — в пользу уже существующих типов
- **`RaydiumConfig`** содержит `initialLiquidityTokens?: bigint` (добавлено в задаче про Raydium).
  Поле необязательное, так что объект в форме из ТЗ подходит.
- **`CycleResult`** содержит `steps: CycleStep[]` — как в `auto_cycle.ts` из этой же задачи. В
  ТЗ для `types.ts` поле `steps` не указано; два разных `CycleResult` в проекте путали бы.

### 3. `DEFAULT_JITO_REGIONS` теперь живёт в `types.ts`
Список из 5 регионов был в `jito_regions.ts`; чтобы не держать две копии, он перенесён сюда, а
`jito_regions.ts` его реэкспортирует — старые импорты работают. `DEFAULT_CONFIG.jitoRegions` —
отдельная копия списка: правка одного не меняет другой.

### 4. `validateConfig`: ошибки строже ТЗ там, где модули всё равно упадут
Всё из ТЗ проверяется. Дополнительно:
- **ошибки:** ни один регион не включён; ручные чаевые < 1000 лампортов (Jito их не примет —
  ТЗ требовало только > 0); `minLamports` < 1000; `tipIncreasePercent` < 0; IPFS-провайдер не
  pinata или пустые ключи;
- **предупреждения:** `maxRetries` > 3 (blockhash истечёт раньше последних попыток); priority fee
  > 1 000 000 µl/CU (дорого); ручные чаевые > 0.01 SOL (вероятно, лишний ноль);
  Raydium без `initialLiquidityTokens`; `lockPeriodDays` при бессрочной блокировке;
  повторяющиеся id регионов.
- Не падает на «битом» конфиге из JSON (отсутствующие поля → ошибки, а не исключение).

### 5. `toPublicConfig`
- Ключи IPFS не отдаются: `ipfs: { provider }` и `ipfsConfigured: boolean` (true, только если
  заданы **оба** ключа).
- **`initialLiquidityTokens` (bigint) → строка.** Публичный конфиг почти наверняка уйдёт через
  `JSON.stringify`, а на `bigint` он бросает исключение.
- Возвращаются новые объекты — правки результата не трогают исходный конфиг.

## Как встроить в код

```ts
import { DEFAULT_CONFIG, toPublicConfig, validateConfig, type AppConfig } from './types';

// загрузка: дефолты + сохранённое
const config: AppConfig = { ...DEFAULT_CONFIG, ...loadSaved() };

// при сохранении из UI
const check = validateConfig(next);
if (!check.ok) return { ok: false, errors: check.errors };
save(next);
check.warnings.forEach((w) => log('warn', w));

// во фронтенд — только так
res.json(toPublicConfig(config));
```

- **Слияние с дефолтами — поверхностное.** `{ ...DEFAULT_CONFIG, ...saved }` заменит
  `retryConfig` целиком; если в сохранённом конфиге его часть, сливайте вложенные объекты отдельно.
- **Проверяйте на сервере перед сохранением** — тот же `validateConfig` можно вызвать из
  `onValidate` панелей настроек.
- **Не отдавайте `AppConfig` во фронтенд напрямую** — только через `toPublicConfig`.
