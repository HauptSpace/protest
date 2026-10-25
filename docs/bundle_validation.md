# `src/bundle_validation.ts` — общие проверки бандла

Новый файл, в ТЗ его не было. В нём лежат константы и проверки, которые раньше были
внутри `src/jitoBundle.ts`:

- `MAX_BUNDLE_TRANSACTIONS = 5`, `MIN_TIP_LAMPORTS = 1000`;
- `validateTransactions(txs)` — от 1 до 4 транзакций (5-е место под tip), все подписаны;
- `validateTip(lamports)` — целое число ≥ 1000.

## Почему вынесено

`submitBundleMultiRegion` нужны те же проверки, что и `createAndSubmitBundle`. Импортировать
их из `jitoBundle.ts` значило бы при каждом импорте загружать gRPC-клиент `jito-ts`, который
для HTTP-отправки не нужен. Копировать — значит дублировать правила. Поэтому проверки в
отдельном лёгком файле, а оба модуля импортируют их оттуда.

## Что изменилось для существующего кода

Ничего. `jitoBundle.ts` по-прежнему экспортирует `MAX_BUNDLE_TRANSACTIONS` и
`MIN_TIP_LAMPORTS`, поведение `createAndSubmitBundle` не изменилось.

## Как встроить в код

Если вы собираете бандлы где-то ещё — вызывайте эти проверки перед отправкой, чтобы ошибка
была понятной и до сетевого запроса:

```ts
import { validateTip, validateTransactions } from './bundle_validation';

validateTransactions(txs);
validateTip(tipLamports);
```
