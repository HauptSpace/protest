# `src/market_monitor.ts` — состояние сети Solana и Jito

`getNetworkConditions(rpcUrl, blockEngineUrl, recentTips?, bundleIds?)` возвращает снимок:

| Поле | Откуда |
|---|---|
| `activeTransactions` | user TPS (без голосов валидаторов) по последнему сэмплу `getRecentPerformanceSamples(1)` |
| `jitoQueueLength` | сколько **ваших** бандлов из `bundleIds` ещё `Pending` (`getInflightBundleStatuses`) |
| `medianTipLamports` | медиана `recentTips`, `0` если не переданы |
| `recommendation` | `go` / `wait` / `stop` по правилу ниже |
| `timestamp` | `Date.now()` на момент снимка |

Правило (как в ТЗ): **go** — `activeTransactions > 1000` и `jitoQueueLength < 20`;
иначе **wait** — `jitoQueueLength < 50`; иначе **stop**. Отдельно экспортирована
`recommend(active, queue)`, если нужно применить правило к своим данным.
Таймаут на весь снимок — 10 с.

## Что изменено относительно ТЗ и почему

### 1. `jitoQueueLength` — ваши Pending-бандлы, добавлен параметр `bundleIds` (согласовано с вами)
У Jito нет публичного метода «длина общей очереди». `getInflightBundleStatuses` принимает
**список bundleId** (до 5 за запрос) и отдаёт их статусы. Без ID посчитать нечего — по ТЗ
очередь всегда была бы 0. Поэтому в конец сигнатуры добавлен необязательный
`bundleIds: string[]`: считаем, сколько из **ваших** отправленных бандлов ещё висят в
`Pending`. Это сигнал обратного давления: много зависших бандлов — пора притормозить.
ID отправляются пачками по 5 параллельно, дубликаты убираются. Без `bundleIds` — `0` и
никакого запроса к Jito. Старые вызовы с тремя аргументами работают как раньше.

### 2. `activeTransactions` — user TPS, а не сырое число транзакций (согласовано с вами)
`getRecentPerformanceSamples(1)` возвращает число транзакций **за ~60 с**, включая голоса
валидаторов — на mainnet это сотни тысяч, порог `> 1000` проходил бы всегда. Теперь это
`numNonVoteTransactions / samplePeriodSecs` — пользовательские транзакции в секунду, и порог
1000 действительно отделяет спокойную сеть от активной. Если RPC-узел старый и поля
`numNonVoteTransactions` не отдаёт, берётся `numTransactions` (с голосами) — TPS будет выше.

> Типичные значения user TPS на mainnet я привожу по памяти, не замерял. Посмотрите на
> реальные цифры своего RPC за пару дней и при необходимости поправьте порог
> `GO_MIN_ACTIVE_TPS`.

### 3. `median` — общая с `tip_strategy.ts`
Не дублируется: `market_monitor` реэкспортирует `median` из `tip_strategy`. Пустой
`recentTips` даёт `medianTipLamports: 0` (сама `median` на пустом массиве бросает ошибку).
Результат округляется до целых лампортов.

### 4. Ошибки не маскируются
Если RPC не вернул сэмпл или Jito ответил ошибкой — функция бросает, а не выдаёт
рекомендацию по неполным данным. Ловите и решайте на своей стороне (например, считать как `wait`).

### 5. `PublicKey` не импортируется
В ТЗ он был в списке «используй», но коду не нужен — неиспользуемый импорт убран.

### 6. Таймаут
10 с на весь снимок: запрос к Jito при этом отменяется. Запрос `Connection` web3.js отменить
не умеет — он может завершиться в фоне, но результат уже будет проигнорирован.

## Как встроить в код

```ts
import { getNetworkConditions } from './market_monitor';
import { getRecentLandedTips, JITO_TIP_FLOOR_HOST } from './tip_strategy';

const pendingBundleIds = new Set<string>();     // пополняйте bundleId после отправки,
                                                // удаляйте после Landed/Failed

const recentTips = await getRecentLandedTips(JITO_TIP_FLOOR_HOST).catch(() => []);
const conditions = await getNetworkConditions(
  process.env.RPC_URL!,
  'mainnet.block-engine.jito.wtf',
  recentTips,
  [...pendingBundleIds],
).catch(() => null);

if (conditions?.recommendation === 'go') {
  // отправлять (submitBundleWithRetry)
} else if (conditions?.recommendation === 'stop') {
  // не отправлять, сообщить пользователю
} else {
  // wait или ошибка снимка: подождать и проверить ещё раз
}
```

- **Как часто вызывать:** сэмпл производительности обновляется раз в ~60 с, так что чаще
  чем раз в 10–30 с смысла нет. Кешируйте результат по `timestamp`.
- **Учёт своих бандлов:** `bundleId` вы получаете из `submitBundleMultiRegion` /
  `submitBundleWithRetry`. Держите их в наборе и убирайте после финального статуса, иначе
  `jitoQueueLength` будет расти бесконечно и выключит отправку через `stop`.
- **`medianTipLamports`** здесь только для отображения — для расчёта чаевых используйте
  `calculateTip` из `tip_strategy.ts`.
- **Логика `go` требует активной сети:** при спокойной сети (≤ 1000 user TPS) рекомендация
  будет `wait`, даже если очередь пуста. Если хотите наоборот (тихая сеть — лучшее время для
  отправки), поменяйте условие в `recommend`.
