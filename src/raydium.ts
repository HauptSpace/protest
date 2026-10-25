import {
  ApiV3Token,
  CLMM_LOCK_AUTH_ID,
  CLMM_PROGRAM_ID,
  CREATE_CPMM_POOL_FEE_ACC,
  CREATE_CPMM_POOL_PROGRAM,
  DEVNET_PROGRAM_ID,
  LOCK_CPMM_AUTH,
  LOCK_CPMM_PROGRAM,
  MAX_TICK,
  MIN_TICK,
  Raydium,
  TxVersion,
  WSOLMint,
  getATAAddress,
  getCpmmPdaAmmConfigId,
  getPdaAmmConfigId,
} from '@raydium-io/raydium-sdk-v2';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Signer,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';

export interface RaydiumConfig {
  /** `amm` — constant-product пул Raydium CPMM; `clmm` — концентрированная ликвидность. */
  poolType: 'amm' | 'clmm';
  /** Сколько SOL положить в пул. */
  initialLiquiditySol: number;
  /**
   * Сколько токенов положить в пул, в минимальных единицах (raw, без decimals).
   * Обязательно: вместе с `initialLiquiditySol` задаёт стартовую цену.
   */
  initialLiquidityTokens?: bigint;
  /** Навсегда заблокировать ликвидность через Raydium Burn & Earn. */
  lockLp: boolean;
  /** Не используется: блокировка Raydium бессрочная. Ненулевое значение даёт warn в лог. */
  lockPeriodDays: number;
}

export interface RaydiumResult {
  poolAddress: string;
  lpLocked: boolean;
  /** Подпись транзакции создания пула. */
  txSignature: string;
}

type Logger = (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void;

/** Таймаут на отправку и подтверждение **каждой** транзакции. */
export const RAYDIUM_TX_TIMEOUT_MS = 30_000;
const CONFIRM_POLL_MS = 1_000;
/** Предпочитаемая комиссия пула: 0.25 % (в единицах Raydium, 1e-6). */
export const PREFERRED_TRADE_FEE_RATE = 2_500;
/** CLMM: запас по SOL сверх `initialLiquiditySol` на округление цены в тиках. */
const CLMM_SOL_BUFFER_BPS = 100n;

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/**
 * Пул создан, но последующий шаг (ликвидность CLMM или блокировка) не удался.
 * В `partial` — адрес пула и подпись создания: пул уже существует on-chain.
 */
export class RaydiumPartialError extends Error {
  constructor(
    message: string,
    readonly partial: RaydiumResult,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RaydiumPartialError';
  }
}

interface Programs {
  cluster: 'mainnet' | 'devnet';
  cpmm: PublicKey;
  cpmmFeeAccount: PublicKey;
  clmm: PublicKey;
  /** Burn & Earn: одна программа блокировки и для CPMM LP, и для CLMM-позиций. */
  lock: PublicKey;
  cpmmLockAuth: PublicKey;
  clmmLockAuth: PublicKey;
}

interface MintInfo {
  address: PublicKey;
  programId: PublicKey;
  decimals: number;
}

interface Ctx {
  raydium: Raydium;
  connection: Connection;
  payer: Keypair;
  programs: Programs;
  token: MintInfo;
  tokens: bigint;
  lamports: bigint;
  log: Logger;
}

/**
 * Создаёт пул SOL/токен на Raydium, вносит стартовую ликвидность и
 * (опционально) навсегда блокирует её.
 *
 * - `amm` → CPMM: одна транзакция создаёт пул и вносит ликвидность; LP-токены
 *   блокируются отдельной транзакцией.
 * - `clmm` → создание пула, позиция на весь диапазон цен, блокировка позиции —
 *   до трёх транзакций.
 *
 * Работает на mainnet и devnet (определяется по genesis hash RPC).
 */
export async function createLiquidityPool(
  mint: PublicKey,
  config: RaydiumConfig,
  payerKeypair: Keypair,
  rpcUrl: string,
  log: Logger,
): Promise<RaydiumResult> {
  const tokens = validateConfig(config);
  const lamports = BigInt(Math.round(config.initialLiquiditySol * LAMPORTS_PER_SOL));
  const connection = new Connection(rpcUrl, 'confirmed');

  const programs = await resolvePrograms(connection);
  const token = await loadMint(connection, mint);
  if (config.lockLp && config.lockPeriodDays > 0) {
    log('warn', `Блокировка Raydium бессрочная: lockPeriodDays=${config.lockPeriodDays} не используется`);
  }

  const raydium = await Raydium.load({
    connection,
    owner: payerKeypair,
    cluster: programs.cluster,
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: 'confirmed',
  });

  const ctx: Ctx = { raydium, connection, payer: payerKeypair, programs, token, tokens, lamports, log };
  log(
    'info',
    `Создание ${config.poolType === 'amm' ? 'CPMM' : 'CLMM'}-пула ${mint.toBase58()} на ${programs.cluster}: ` +
      `${config.initialLiquiditySol} SOL + ${tokens} токенов (raw)`,
  );

  const result = config.poolType === 'amm' ? await createCpmmPool(ctx, config.lockLp) : await createClmmPool(ctx, config.lockLp);
  log('success', `Пул ${result.poolAddress} создан${result.lpLocked ? ', ликвидность заблокирована' : ''}`);
  return result;
}

async function createCpmmPool(ctx: Ctx, lockLp: boolean): Promise<RaydiumResult> {
  const { raydium, programs } = ctx;
  const feeConfig = pickFeeConfig(await raydium.api.getCpmmConfigs());
  if (programs.cluster === 'devnet') {
    feeConfig.id = getCpmmPdaAmmConfigId(programs.cpmm, feeConfig.index).publicKey.toBase58();
  }

  await assertBalances(ctx, ctx.lamports + BigInt(feeConfig.createPoolFee || '0'));

  const create = await raydium.cpmm.createPool({
    programId: programs.cpmm,
    poolFeeAccount: programs.cpmmFeeAccount,
    mintA: toApiToken(ctx.token),
    mintB: toApiToken(WSOL),
    mintAAmount: new BN(ctx.tokens.toString()),
    mintBAmount: new BN(ctx.lamports.toString()),
    startTime: new BN(0),
    feeConfig,
    associatedOnly: false,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
  });
  const { poolId, lpMint } = create.extInfo.address;
  const txSignature = await sendAndConfirm(ctx, create, 'создание CPMM-пула');
  const result: RaydiumResult = { poolAddress: poolId.toBase58(), lpLocked: false, txSignature };

  if (!lockLp) {
    return result;
  }
  try {
    const lpAccount = getATAAddress(ctx.payer.publicKey, lpMint, TOKEN_PROGRAM_ID).publicKey;
    const lpAmount = (await ctx.connection.getTokenAccountBalance(lpAccount)).value.amount;
    const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(result.poolAddress);
    const lock = await raydium.cpmm.lockLp({
      poolInfo,
      poolKeys,
      lpAmount: new BN(lpAmount),
      programId: programs.lock,
      authProgram: programs.cpmmLockAuth,
      withMetadata: true,
      txVersion: TxVersion.V0,
    });
    await sendAndConfirm(ctx, lock, `блокировка ${lpAmount} LP`);
  } catch (err) {
    throw new RaydiumPartialError(`Пул ${result.poolAddress} создан, но LP не заблокированы: ${errorMessage(err)}`, result, {
      cause: err,
    });
  }
  return { ...result, lpLocked: true };
}

async function createClmmPool(ctx: Ctx, lockLp: boolean): Promise<RaydiumResult> {
  const { raydium, programs, token } = ctx;
  const apiConfig = pickFeeConfig(await raydium.api.getClmmConfigs());
  const configId =
    programs.cluster === 'devnet'
      ? getPdaAmmConfigId(programs.clmm, apiConfig.index).publicKey
      : new PublicKey(apiConfig.id);

  const solMax = (ctx.lamports * (10_000n + CLMM_SOL_BUFFER_BPS)) / 10_000n;
  await assertBalances(ctx, solMax);

  // Цена 1 токена в SOL; SDK сам упорядочит минты и при необходимости инвертирует цену.
  const initialPrice = new Decimal(ctx.lamports.toString())
    .div(LAMPORTS_PER_SOL)
    .div(new Decimal(ctx.tokens.toString()).div(new Decimal(10).pow(token.decimals)));

  const create = await raydium.clmm.createPool({
    programId: programs.clmm,
    mint1: toApiToken(token),
    mint2: toApiToken(WSOL),
    ammConfig: { ...apiConfig, id: configId, fundOwner: '', description: '' },
    initialPrice,
    txVersion: TxVersion.V0,
  });
  const poolAddress = create.extInfo.address.id;
  const txSignature = await sendAndConfirm(ctx, create, 'создание CLMM-пула');
  const result: RaydiumResult = { poolAddress, lpLocked: false, txSignature };

  let nftMint: PublicKey;
  try {
    const { poolInfo } = await raydium.clmm.getPoolInfoFromRpc(poolAddress);
    const spacing = poolInfo.config.tickSpacing;
    const tokenIsA = poolInfo.mintA.address === token.address.toBase58();
    // Позиция на весь диапазон цен — аналог constant-product пула.
    const open = await raydium.clmm.openPositionFromBase({
      poolInfo,
      ownerInfo: { useSOLBalance: true },
      tickLower: Math.ceil(MIN_TICK / spacing) * spacing,
      tickUpper: Math.floor(MAX_TICK / spacing) * spacing,
      base: tokenIsA ? 'MintA' : 'MintB',
      baseAmount: new BN(ctx.tokens.toString()),
      otherAmountMax: new BN(solMax.toString()),
      txVersion: TxVersion.V0,
    });
    nftMint = open.extInfo.nftMint;
    await sendAndConfirm(ctx, open, 'внесение ликвидности в CLMM');
  } catch (err) {
    throw new RaydiumPartialError(`Пул ${poolAddress} создан, но ликвидность не внесена: ${errorMessage(err)}`, result, {
      cause: err,
    });
  }

  if (!lockLp) {
    return result;
  }
  try {
    const positions = await raydium.clmm.getOwnerPositionInfo({ programId: programs.clmm });
    const ownerPosition = positions.find((p) => p.nftMint.equals(nftMint));
    if (!ownerPosition) {
      throw new Error(`позиция ${nftMint.toBase58()} не найдена у владельца`);
    }
    const lock = await raydium.clmm.lockPosition({
      ownerPosition,
      programId: programs.lock,
      authProgramId: programs.clmmLockAuth,
      poolProgramId: programs.clmm,
      txVersion: TxVersion.V0,
    });
    await sendAndConfirm(ctx, lock, 'блокировка CLMM-позиции');
  } catch (err) {
    throw new RaydiumPartialError(`Пул ${poolAddress} создан, но позиция не заблокирована: ${errorMessage(err)}`, result, {
      cause: err,
    });
  }
  return { ...result, lpLocked: true };
}

/**
 * Подписывает собранную SDK транзакцию, отправляет (с preflight-симуляцией)
 * и ждёт подтверждения не дольше {@link RAYDIUM_TX_TIMEOUT_MS}.
 */
async function sendAndConfirm(
  ctx: Ctx,
  built: { transaction: Transaction | VersionedTransaction; signers: Signer[] },
  label: string,
): Promise<string> {
  const tx = built.transaction;
  if (!(tx instanceof VersionedTransaction)) {
    throw new Error(`${label}: SDK вернул legacy-транзакцию, ожидалась v0`);
  }
  const required = new Set(
    tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58()),
  );
  const signers = [ctx.payer, ...built.signers].filter(
    (s, i, all) => required.has(s.publicKey.toBase58()) && all.findIndex((o) => o.publicKey.equals(s.publicKey)) === i,
  );
  tx.sign(signers);

  const deadline = Date.now() + RAYDIUM_TX_TIMEOUT_MS;
  const signature = await withDeadline(
    ctx.connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed', maxRetries: 5 }),
    deadline,
    `${label}: отправка не завершилась за ${RAYDIUM_TX_TIMEOUT_MS / 1000} с`,
  );
  ctx.log('info', `${label}: отправлена ${signature}`);

  for (;;) {
    const { value } = await ctx.connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) {
      throw new Error(`${label}: транзакция ${signature} упала: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      ctx.log('info', `${label}: подтверждена`);
      return signature;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${label}: транзакция ${signature} не подтверждена за ${RAYDIUM_TX_TIMEOUT_MS / 1000} с — ` +
          'она ещё может пройти, проверьте в обозревателе перед повтором',
      );
    }
    await sleep(Math.min(CONFIRM_POLL_MS, deadline - Date.now()));
  }
}

async function resolvePrograms(connection: Connection): Promise<Programs> {
  const genesis = await connection.getGenesisHash();
  if (genesis === MAINNET_GENESIS) {
    return {
      cluster: 'mainnet',
      cpmm: CREATE_CPMM_POOL_PROGRAM,
      cpmmFeeAccount: CREATE_CPMM_POOL_FEE_ACC,
      clmm: CLMM_PROGRAM_ID,
      lock: LOCK_CPMM_PROGRAM,
      cpmmLockAuth: LOCK_CPMM_AUTH,
      clmmLockAuth: CLMM_LOCK_AUTH_ID,
    };
  }
  if (genesis === DEVNET_GENESIS) {
    return {
      cluster: 'devnet',
      cpmm: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
      cpmmFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
      clmm: DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID,
      lock: DEVNET_PROGRAM_ID.LOCK_CPMM_PROGRAM,
      cpmmLockAuth: DEVNET_PROGRAM_ID.LOCK_CPMM_AUTH,
      clmmLockAuth: DEVNET_PROGRAM_ID.CLMM_LOCK_AUTH_ID,
    };
  }
  throw new Error(`Raydium поддерживается только на mainnet и devnet (genesis ${genesis})`);
}

async function loadMint(connection: Connection, mint: PublicKey): Promise<MintInfo> {
  const { value } = await connection.getParsedAccountInfo(mint);
  const data = value?.data;
  if (!value || !data || Buffer.isBuffer(data) || data.parsed?.type !== 'mint') {
    throw new Error(`${mint.toBase58()} — не mint-аккаунт токена`);
  }
  return { address: mint, programId: value.owner, decimals: data.parsed.info.decimals as number };
}

async function assertBalances(ctx: Ctx, lamportsNeeded: bigint): Promise<void> {
  const owner = ctx.payer.publicKey;
  const [solBalance, tokenAccounts] = await Promise.all([
    ctx.connection.getBalance(owner),
    ctx.connection.getParsedTokenAccountsByOwner(owner, { mint: ctx.token.address }),
  ]);
  const tokenBalance = tokenAccounts.value.reduce(
    (sum, a) => sum + BigInt((a.account.data.parsed?.info?.tokenAmount?.amount as string | undefined) ?? '0'),
    0n,
  );
  if (tokenBalance < ctx.tokens) {
    throw new Error(`Недостаточно токенов: есть ${tokenBalance}, нужно ${ctx.tokens} (raw)`);
  }
  if (BigInt(solBalance) < lamportsNeeded) {
    throw new Error(
      `Недостаточно SOL: есть ${solBalance / LAMPORTS_PER_SOL}, нужно не меньше ` +
        `${Number(lamportsNeeded) / LAMPORTS_PER_SOL} + комиссии и рента`,
    );
  }
}

/** Конфиг с комиссией 0.25 %, если есть, иначе с наименьшим индексом. */
function pickFeeConfig<C extends { index: number; tradeFeeRate: number }>(configs: C[]): C {
  const sorted = [...configs].sort((a, b) => a.index - b.index);
  const chosen = sorted.find((c) => c.tradeFeeRate === PREFERRED_TRADE_FEE_RATE) ?? sorted[0];
  if (!chosen) {
    throw new Error('Raydium API не вернул ни одного конфига комиссий');
  }
  return { ...chosen };
}

const WSOL: MintInfo = { address: WSOLMint, programId: TOKEN_PROGRAM_ID, decimals: 9 };

function toApiToken({ address, programId, decimals }: MintInfo): ApiV3Token {
  return {
    chainId: 101,
    address: address.toBase58(),
    programId: programId.toBase58(),
    decimals,
    logoURI: '',
    symbol: '',
    name: '',
    tags: [],
    extensions: {},
  };
}

function validateConfig(config: RaydiumConfig): bigint {
  if (config.poolType !== 'amm' && config.poolType !== 'clmm') {
    throw new Error(`Неизвестный poolType: ${String(config.poolType)}`);
  }
  if (!(Number.isFinite(config.initialLiquiditySol) && config.initialLiquiditySol > 0)) {
    throw new Error('initialLiquiditySol должен быть > 0');
  }
  const tokens = config.initialLiquidityTokens;
  if (tokens === undefined || tokens <= 0n) {
    throw new Error('initialLiquidityTokens обязателен и должен быть > 0: вместе с SOL он задаёт стартовую цену');
  }
  return tokens;
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
