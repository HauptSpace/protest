import { VersionedTransaction } from '@solana/web3.js';

/** Jito Block Engine принимает не более 5 транзакций в одном бандле. */
export const MAX_BUNDLE_TRANSACTIONS = 5;

/** Минимальный размер чаевых, который принимает Block Engine. */
export const MIN_TIP_LAMPORTS = 1_000;

export function validateTransactions(transactions: VersionedTransaction[]): void {
  if (transactions.length === 0) {
    throw new Error('Бандл должен содержать хотя бы одну транзакцию');
  }
  // Одно место в бандле резервируется под tip-транзакцию.
  if (transactions.length > MAX_BUNDLE_TRANSACTIONS - 1) {
    throw new Error(
      `Не более ${MAX_BUNDLE_TRANSACTIONS - 1} транзакций: ` +
        'последнее место занимает tip-транзакция',
    );
  }

  transactions.forEach((tx, i) => {
    const required = tx.message.header.numRequiredSignatures;
    const signed = tx.signatures
      .slice(0, required)
      .every((sig) => sig.some((byte) => byte !== 0));
    if (!signed) {
      throw new Error(`Транзакция #${i} подписана не всеми подписантами`);
    }
  });
}

export function validateTip(tipLamports: number): void {
  if (!Number.isSafeInteger(tipLamports) || tipLamports < MIN_TIP_LAMPORTS) {
    throw new Error(
      `tipLamports должен быть целым числом не меньше ${MIN_TIP_LAMPORTS}`,
    );
  }
}
