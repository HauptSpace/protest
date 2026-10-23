import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createAndSubmitBundle,
  MAX_BUNDLE_TRANSACTIONS,
  MIN_TIP_LAMPORTS,
} from './jitoBundle';
import { prepareWalletTransactions } from './prepare_module';
import { createTokenTransaction } from './pump_interface';

export const MIN_SUB_WALLETS = 1;
export const MAX_SUB_WALLETS = 4;

/** Данные, которые приходят из полей веб-интерфейса. */
export interface LaunchParams {
  /** Приватный ключ главного кошелька: base58 или JSON-массив из 64 байт. */
  devPrivateKey: string;
  tipLamports: number;
  name: string;
  symbol: string;
  /** Ссылка на JSON с метаданными токена в IPFS. */
  uri: string;
  /** Сумма первой покупки разработчика в SOL. */
  buyAmountSol: number;
  walletCount: number;
  /** Сколько SOL распределяется на каждый суб-кошелёк. */
  solPerWallet: number;
}

export interface LaunchConfig {
  rpcUrl: string;
  blockEngineUrl: string;
  /** Каталог, куда сохраняются ключи сгенерированных суб-кошельков. */
  walletsDir: string;
}

export interface LaunchResult {
  bundleId: string;
  mint: string;
  walletsFile: string;
}

export type LogLevel = 'info' | 'success' | 'error';
export type Logger = (level: LogLevel, message: string) => void;

/**
 * Последовательно вызывает три модуля: генерацию суб-кошельков и их
 * транзакций, создание токена Pump.fun и отправку всего пакета Jito-бандлом.
 */
export async function runLaunchPipeline(
  params: LaunchParams,
  config: LaunchConfig,
  log: Logger,
): Promise<LaunchResult> {
  validateParams(params);
  const devWallet = parseSecretKey(params.devPrivateKey);
  const connection = new Connection(config.rpcUrl, 'confirmed');
  // Mint создаётся заранее: его адрес нужен суб-кошелькам для покупки.
  const mint = Keypair.generate();

  log('info', `Главный кошелёк: ${devWallet.publicKey.toBase58()}`);
  log('info', `Адрес токена: ${mint.publicKey.toBase58()}`);

  // Общий blockhash, чтобы все транзакции бандла истекали одновременно.
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  log('info', 'Генерация кошельков...');
  const prepared = await prepareWalletTransactions({
    connection,
    funder: devWallet,
    mint: mint.publicKey,
    walletCount: params.walletCount,
    solPerWallet: params.solPerWallet,
    recentBlockhash: blockhash,
  });
  // Сохраняем ключи до отправки: иначе SOL на суб-кошельках будет потерян.
  const walletsFile = await saveWallets(
    config.walletsDir,
    mint.publicKey.toBase58(),
    prepared.wallets,
  );
  log('info', `Создано кошельков: ${prepared.wallets.length}, ключи: ${walletsFile}`);

  log('info', 'Создание токена Pump.fun...');
  const createTx = await createTokenTransaction({
    connection,
    creator: devWallet,
    mint,
    name: params.name,
    symbol: params.symbol,
    uri: params.uri,
    buyAmountSol: params.buyAmountSol,
    recentBlockhash: blockhash,
  });

  const transactions = [createTx, ...prepared.transactions];
  if (transactions.length > MAX_BUNDLE_TRANSACTIONS - 1) {
    throw new Error(
      `В бандл помещается ${MAX_BUNDLE_TRANSACTIONS - 1} транзакции плюс чаевые, ` +
        `а подготовлено ${transactions.length}. Уменьшите число кошельков.`,
    );
  }

  log('info', `Сборка Jito-бандла (${transactions.length} транзакций + чаевые)...`);
  const { bundleId } = await createAndSubmitBundle(transactions, {
    blockEngineUrl: config.blockEngineUrl,
    tipPayer: devWallet,
    tipLamports: params.tipLamports,
    recentBlockhash: blockhash,
  });
  log('success', `Успех! ID бандла: ${bundleId}`);

  return { bundleId, mint: mint.publicKey.toBase58(), walletsFile };
}

export function validateParams(params: LaunchParams): void {
  const errors: string[] = [];

  if (!params.devPrivateKey?.trim()) errors.push('не указан приватный ключ');
  if (!Number.isSafeInteger(params.tipLamports) || params.tipLamports < MIN_TIP_LAMPORTS) {
    errors.push(`чаевые Jito — целое число не меньше ${MIN_TIP_LAMPORTS} лампортов`);
  }
  if (!params.name?.trim()) errors.push('не указано название токена');
  if (!params.symbol?.trim()) errors.push('не указан тикер');
  if (!isValidUri(params.uri)) errors.push('URI метаданных должен начинаться с ipfs:// или https://');
  if (!isPositive(params.buyAmountSol)) errors.push('сумма первой покупки должна быть больше 0');
  if (
    !Number.isInteger(params.walletCount) ||
    params.walletCount < MIN_SUB_WALLETS ||
    params.walletCount > MAX_SUB_WALLETS
  ) {
    errors.push(`число кошельков — от ${MIN_SUB_WALLETS} до ${MAX_SUB_WALLETS}`);
  }
  if (!isPositive(params.solPerWallet)) errors.push('сумма на кошелёк должна быть больше 0');

  if (errors.length > 0) {
    throw new Error(`Некорректные параметры: ${errors.join('; ')}`);
  }
}

/** Принимает ключ в формате base58 (экспорт Phantom) или JSON-массив байтов. */
export function parseSecretKey(raw: string): Keypair {
  const value = raw.trim();
  try {
    const bytes = value.startsWith('[')
      ? Uint8Array.from(JSON.parse(value) as number[])
      : bs58.decode(value);
    return Keypair.fromSecretKey(bytes);
  } catch {
    // Исходную ошибку не пробрасываем, чтобы ключ не попал в логи.
    throw new Error('Не удалось прочитать приватный ключ: ожидается base58 или JSON-массив из 64 чисел');
  }
}

async function saveWallets(dir: string, mint: string, wallets: Keypair[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.resolve(dir, `${mint}.json`);
  const data = wallets.map((wallet) => ({
    publicKey: wallet.publicKey.toBase58(),
    secretKey: bs58.encode(wallet.secretKey),
  }));
  await writeFile(file, JSON.stringify({ mint, wallets: data }, null, 2), { mode: 0o600 });
  return file;
}

function isValidUri(value: string): boolean {
  try {
    return ['ipfs:', 'https:'].includes(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
