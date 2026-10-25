# `src/tip_strategy.ts` — расчёт чаевых

- `calculateTip(strategy, recentTips?)` → лампорты.
- `getRecentLandedTips(host, limit?)` → массив чаевых недавних бандлов в лампортах.
- Вспомогательные функции: `median`, `percentileValue`.

| Стратегия | Результат | Если `recentTips` пуст |
|---|---|---|
| `{ type: 'manual', lamports }` | `lamports` (> 0) | — |
| `{ type: 'auto', percentile }` | перцентиль `recentTips` | 1 000 000 |
| `{ type: 'percentile', percentile, minLamports }` | перцентиль, но ≥ `minLamports` | `minLamports` |

## Что изменено относительно ТЗ и почему

### 1. `auto` = перцентиль, а не `median × percentile/100` (согласовано с вами)
ТЗ противоречило само себе: по формуле `median([1M,2M,3M]) × 0.8 = 1.6M`, а тест ожидал ~2.4M.
Выбрали вариант теста: `auto` — это перцентиль от `recentTips`. Формула из текста к тому же
давала бы чаевые ниже медианы при любом percentile < 100, что редко нужно.

### 2. Метод перцентиля — линейная интерполяция по рангу `p·n`
Из распространённых методов только он даёт 2.4M для `[1M,2M,3M]` и p = 0.8
(ранг 2.4 → 2M + 0.4 × 1M). Метод по умолчанию в numpy/Excel дал бы 2.6M.
На краях значение прижимается к min/max массива.

### 3. `getRecentLandedTips` ходит в tip floor API, а не в `getInflightBundleStatuses` (согласовано с вами)
`getInflightBundleStatuses` принимает **список bundleId** и возвращает только статус и слот —
сумм чаевых там нет. Получить из него «чаевые недавних бандлов» невозможно.
Вместо этого используется `GET https://bundles.jito.wtf/api/v1/bundles/tip_floor` — официальная
статистика Jito по приземлившимся чаевым. Хост вынесен в константу `JITO_TIP_FLOOR_HOST`;
параметр функции по-прежнему называется `blockEngineUrl`, но теперь это хост tip floor API.

**Ограничение:** tip floor отдаёт не отдельные чаевые, а готовые перцентили (25/50/75/95/99) в SOL.
Функция переводит их в лампорты и возвращает пять чисел на снимок. Перцентиль в
`calculateTip` по ним — приближение («перцентиль по перцентилям»), но для выбора чаевых
этого достаточно. `limit` — число снимков (по умолчанию 1).

### 4. Сверх ТЗ
- Округление до целых лампортов.
- Проверки: `lamports`/`minLamports` — положительные целые, `percentile` ∈ (0, 100].
- `median`/`percentileValue` не мутируют входной массив и бросают ошибку на пустом.
- Таймаут запроса tip floor — 10 с.

## Как встроить в код

```ts
import { JITO_TIP_FLOOR_HOST, calculateTip, getRecentLandedTips } from './tip_strategy';

const recentTips = await getRecentLandedTips(JITO_TIP_FLOOR_HOST).catch(() => []);
const tip = await calculateTip(
  { type: 'percentile', percentile: 75, minLamports: 10_000 },
  recentTips,
);
```

- **С `submitBundleWithRetry` — только через обёртку:**
  `calcTipFn: (s) => calculateTip(s, recentTips)`. Без неё `auto` всегда вернёт 1M,
  а `percentile` — всегда `minLamports`.
- **Кешируйте `recentTips`** на 10–30 с: статистика меняется медленно, а лишние запросы не нужны.
- **Ошибка tip floor не должна блокировать отправку** — ловите её и передавайте `[]`, стратегия
  уйдёт в fallback.
- **Какую стратегию выбрать:** `percentile` с `minLamports` — самая безопасная: следует за рынком,
  но не опускается ниже вашего минимума. `auto` с fallback 1M (0.001 SOL) может оказаться
  дорогой, когда tip floor недоступен. Для арбитража/снайпинга обычно берут 75–95 перцентиль.
- Минимум Jito — 1000 лампортов; если стратегия вернёт меньше, `submitBundleMultiRegion`
  отклонит бандл при валидации.
