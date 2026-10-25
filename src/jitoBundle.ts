import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  SearcherClient,
  searcherClient,
} from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';

import {
  MAX_BUNDLE_TRANSACTIONS,
  validateTip,
  validateTransactions,
} from './bundle_validation';

export { MAX_BUNDLE_TRANSACTIONS, MIN_TIP_LAMPORTS } from './bundle_validation';

type SearcherSource =
  | { client: SearcherClient }
  | { blockEngineUrl: string; authKeypair?: Keypair };

export type CreateAndSubmitBundleOptions = SearcherSource & {
  /** Кошелёк, который платит чаевые и подписывает tip-транзакцию. */
  tipPayer: Keypair;
  /** Размер чаевых в лампортах. */
  tipLamports: number;
  /**
   * Blockhash для tip-транзакции. По умолчанию берётся из последней
   * транзакции пакета, чтобы весь бандл истекал одновременно.
   */
  recentBlockhash?: string;
};

export interface SubmittedBundle {
  /** UUID бандла, выданный Block Engine. */
  bundleId: string;
  /** Tip-аккаунт, на который были отправлены чаевые. */
  tipAccount: PublicKey;
}

/**
 * Собирает бандл из подписанных транзакций, добавляет в конец транзакцию
 * с чаевыми на случайный tip-аккаунт Jito и отправляет его в Block Engine.
 */
export async function createAndSubmitBundle(
  transactions: VersionedTransaction[],
  options: CreateAndSubmitBundleOptions,
): Promise<SubmittedBundle> {
  validateTransactions(transactions);
  validateTip(options.tipLamports);

  const client =
    'client' in options
      ? options.client
      : searcherClient(options.blockEngineUrl, options.authKeypair);

  const tipAccount = await pickRandomTipAccount(client);
  const recentBlockhash =
    options.recentBlockhash ??
    transactions[transactions.length - 1].message.recentBlockhash;

  const bundle = new Bundle([...transactions], MAX_BUNDLE_TRANSACTIONS);
  const withTip = bundle.addTipTx(
    options.tipPayer,
    options.tipLamports,
    tipAccount,
    recentBlockhash,
  );
  if (withTip instanceof Error) {
    throw withTip;
  }

  const sent = await client.sendBundle(withTip);
  if (!sent.ok) {
    throw new Error(`Block Engine отклонил бандл: ${sent.error.message}`, {
      cause: sent.error,
    });
  }

  return { bundleId: sent.value, tipAccount };
}

async function pickRandomTipAccount(client: SearcherClient): Promise<PublicKey> {
  const result = await client.getTipAccounts();
  if (!result.ok) {
    throw new Error(
      `Не удалось получить tip-аккаунты Jito: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.value.length === 0) {
    throw new Error('Block Engine вернул пустой список tip-аккаунтов');
  }

  const index = Math.floor(Math.random() * result.value.length);
  return new PublicKey(result.value[index]);
}
