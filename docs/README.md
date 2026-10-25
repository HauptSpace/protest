# Jito-утилиты: что где лежит и как собрать вместе

| Файл | Что делает | Заметки |
|---|---|---|
| `src/jito_regions.ts` | Отправка бандла во все включённые регионы Jito, побеждает первый принявший | [jito_regions.md](jito_regions.md) |
| `src/tip_strategy.ts` | Расчёт чаевых (manual / auto / percentile) и загрузка статистики чаевых Jito | [tip_strategy.md](tip_strategy.md) |
| `src/blockhash_ws.ts` | Держит свежий blockhash через WebSocket-подписку на слоты | [blockhash_ws.md](blockhash_ws.md) |
| `src/submit_with_retry.ts` | Ретраи отправки с ростом чаевых, свежим blockhash и расширением регионов | [submit_with_retry.md](submit_with_retry.md) |
| `src/ipfs.ts` | Загрузка картинки и метаданных токена в IPFS через Pinata | [ipfs.md](ipfs.md) |
| `src/market_monitor.ts` | Снимок состояния сети и Jito с рекомендацией go / wait / stop | [market_monitor.md](market_monitor.md) |
| `src/trading.ts` | Автоматический выход из позиции: manual / target / trailing / DCA | [trading.md](trading.md) |
| `src/raydium.ts` | Создание пула SOL/токен на Raydium (CPMM / CLMM) с блокировкой ликвидности | [raydium.md](raydium.md) |
| `src/bundle_validation.ts` | Общие проверки бандла (вынесены из `jitoBundle.ts`) | [bundle_validation.md](bundle_validation.md) |
| `docs/example.ts` | Рабочий пример сборки всех модулей (проходит `tsc`) | — |

В каждом `.md` два раздела: **что изменено относительно ТЗ и почему** и **как встроить в код**.

## Порядок сборки в приложении

```
старт приложения
  └─ BlockhashWatcher.start() → дождаться первого 'update'

на каждый бандл
  ├─ blockhash = watcher.getCurrent().blockhash
  ├─ собрать и подписать свои транзакции под этот blockhash
  ├─ recentTips = getRecentLandedTips(JITO_TIP_FLOOR_HOST)      (один раз)
  └─ submitBundleWithRetry(
         …,
         submitFn  = submitBundleMultiRegion,
         calcTipFn = (s) => calculateTip(s, recentTips),          ← важно
     )

остановка приложения
  └─ watcher.stop()
```

Полный код — в [`example.ts`](example.ts).

## Три ловушки при интеграции

1. **`calcTipFn` без `recentTips`.** `submitBundleWithRetry` вызывает `calcTipFn(strategy)` без
   второго аргумента. Если передать `calculateTip` напрямую, стратегия `auto` всегда вернёт
   1 000 000, а `percentile` — всегда `minLamports`. Оборачивайте:
   `(s) => calculateTip(s, recentTips)`.
2. **`blockhashRefresh` обновляет только tip-транзакцию.** Ваши транзакции уже подписаны со своим
   blockhash, и ретрай его не меняет. Если они истекли (~60–90 с), повтор не поможет — нужно
   пересобрать и переподписать их. Подробности в [submit_with_retry.md](submit_with_retry.md).
3. **Watcher сразу после `start()` пуст.** Первый blockhash приходит только с первым слотом —
   дождитесь события `update` (см. `waitForFirstBlockhash` в примере).

## Сколько это может занять

Одна попытка `submitBundleMultiRegion` — до 30 с, между попытками 2 с.
При `maxRetries: 3` худший случай ≈ 3 × 30 + 2 × 2 = **94 с**. За это время blockhash ваших
транзакций почти наверняка истечёт, поэтому `maxRetries` больше 2–3 смысла не имеет без
пересборки транзакций.

## Проверка

```bash
npm ci
npm test        # vitest, без сети
npm run build   # tsc → dist/
```
