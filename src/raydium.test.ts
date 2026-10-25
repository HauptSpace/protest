import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({
  getGenesisHash: vi.fn(),
  getParsedAccountInfo: vi.fn(),
  getBalance: vi.fn(),
  getParsedTokenAccountsByOwner: vi.fn(),
  getTokenAccountBalance: vi.fn(),
  sendRawTransaction: vi.fn(),
  getSignatureStatuses: vi.fn(),
}));

const sdk = vi.hoisted(() => ({
  load: vi.fn(),
  getCpmmConfigs: vi.fn(),
  getClmmConfigs: vi.fn(),
  cpmmCreatePool: vi.fn(),
  cpmmGetPoolInfoFromRpc: vi.fn(),
  cpmmLockLp: vi.fn(),
  clmmCreatePool: vi.fn(),
  clmmGetPoolInfoFromRpc: vi.fn(),
  clmmOpenPositionFromBase: vi.fn(),
  clmmGetOwnerPositionInfo: vi.fn(),
  clmmLockPosition: vi.fn(),
}));

vi.mock('@solana/web3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/web3.js')>()),
  Connection: class {
    getGenesisHash = rpc.getGenesisHash;
    getParsedAccountInfo = rpc.getParsedAccountInfo;
    getBalance = rpc.getBalance;
    getParsedTokenAccountsByOwner = rpc.getParsedTokenAccountsByOwner;
    getTokenAccountBalance = rpc.getTokenAccountBalance;
    sendRawTransaction = rpc.sendRawTransaction;
    getSignatureStatuses = rpc.getSignatureStatuses;
  },
}));

vi.mock('@raydium-io/raydium-sdk-v2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@raydium-io/raydium-sdk-v2')>()),
  Raydium: { load: sdk.load },
}));

import {
  CLMM_PROGRAM_ID,
  CREATE_CPMM_POOL_PROGRAM,
  DEVNET_PROGRAM_ID,
  LOCK_CPMM_PROGRAM,
  MAX_TICK,
  MIN_TICK,
  getCpmmPdaAmmConfigId,
} from '@raydium-io/raydium-sdk-v2';

import { RAYDIUM_TX_TIMEOUT_MS, RaydiumConfig, RaydiumPartialError, createLiquidityPool } from './raydium';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const mint = Keypair.generate().publicKey;
const DECIMALS = 6;
const TOKENS = 800_000_000n * 10n ** BigInt(DECIMALS); // 800M токенов
const SOL = 10;
const LAMPORTS = 10_000_000_000n;

const poolId = Keypair.generate().publicKey;
const lpMint = Keypair.generate().publicKey;
const nftMint = Keypair.generate();
const log = vi.fn();
let payer: Keypair;
let sentCount: number;

const CPMM_CONFIGS = [
  { id: Keypair.generate().publicKey.toBase58(), index: 1, tradeFeeRate: 10_000, protocolFeeRate: 0, fundFeeRate: 0, createPoolFee: '150000000', creatorFeeRate: 0 },
  { id: Keypair.generate().publicKey.toBase58(), index: 0, tradeFeeRate: 2_500, protocolFeeRate: 0, fundFeeRate: 0, createPoolFee: '150000000', creatorFeeRate: 0 },
];
const CLMM_CONFIGS = [
  { id: Keypair.generate().publicKey.toBase58(), index: 0, tradeFeeRate: 100, tickSpacing: 1, protocolFeeRate: 0, fundFeeRate: 0, defaultRange: 0, defaultRangePoint: [] },
  { id: Keypair.generate().publicKey.toBase58(), index: 3, tradeFeeRate: 2_500, tickSpacing: 60, protocolFeeRate: 0, fundFeeRate: 0, defaultRange: 0, defaultRangePoint: [] },
];

/** Настоящая v0-транзакция, которую должны подписать payer и `extraSigners`. */
function built(extraSigners: Keypair[] = [], extInfo: unknown = {}) {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      new TransactionInstruction({
        programId: CREATE_CPMM_POOL_PROGRAM,
        keys: extraSigners.map((s) => ({ pubkey: s.publicKey, isSigner: true, isWritable: true })),
        data: Buffer.alloc(0),
      }),
    ],
  }).compileToV0Message();
  return { transaction: new VersionedTransaction(message), signers: extraSigners, extInfo };
}

function config(overrides: Partial<RaydiumConfig> = {}): RaydiumConfig {
  return {
    poolType: 'amm',
    initialLiquiditySol: SOL,
    initialLiquidityTokens: TOKENS,
    lockLp: false,
    lockPeriodDays: 0,
    ...overrides,
  };
}

async function run(cfg: RaydiumConfig, advanceMs = 0) {
  const promise = createLiquidityPool(mint, cfg, payer, 'https://rpc.example.test', log);
  promise.catch(() => {});
  await vi.advanceTimersByTimeAsync(advanceMs);
  return promise;
}

/** Все отправленные транзакции, десериализованные обратно. */
function sentTransactions(): VersionedTransaction[] {
  return rpc.sendRawTransaction.mock.calls.map(([raw]) => VersionedTransaction.deserialize(raw as Uint8Array));
}

function isSignedBy(tx: VersionedTransaction, key: PublicKey): boolean {
  const index = tx.message.staticAccountKeys.findIndex((k) => k.equals(key));
  return index !== -1 && tx.signatures[index].some((b) => b !== 0);
}

beforeEach(() => {
  vi.useFakeTimers();
  payer = Keypair.generate();
  sentCount = 0;
  log.mockReset();
  Object.values(rpc).forEach((fn) => fn.mockReset());
  Object.values(sdk).forEach((fn) => fn.mockReset());

  rpc.getGenesisHash.mockResolvedValue(MAINNET_GENESIS);
  rpc.getParsedAccountInfo.mockResolvedValue({
    value: { owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: DECIMALS } } } },
  });
  rpc.getBalance.mockResolvedValue(20_000_000_000);
  rpc.getParsedTokenAccountsByOwner.mockResolvedValue({
    value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: TOKENS.toString() } } } } } }],
  });
  rpc.getTokenAccountBalance.mockResolvedValue({ value: { amount: '89442719099' } });
  rpc.sendRawTransaction.mockImplementation(async () => `sig-${++sentCount}`);
  rpc.getSignatureStatuses.mockResolvedValue({ value: [{ err: null, confirmationStatus: 'confirmed' }] });

  sdk.getCpmmConfigs.mockResolvedValue(CPMM_CONFIGS);
  sdk.getClmmConfigs.mockResolvedValue(CLMM_CONFIGS);
  sdk.cpmmCreatePool.mockImplementation(async () => built([], { address: { poolId, lpMint } }));
  sdk.cpmmGetPoolInfoFromRpc.mockResolvedValue({ poolInfo: { id: poolId.toBase58() }, poolKeys: {} });
  sdk.cpmmLockLp.mockImplementation(async () => built([Keypair.generate()]));
  sdk.clmmCreatePool.mockImplementation(async () => built([], { address: { id: poolId.toBase58() } }));
  sdk.clmmGetPoolInfoFromRpc.mockResolvedValue({
    poolInfo: { config: { tickSpacing: 60 }, mintA: { address: mint.toBase58() } },
  });
  sdk.clmmOpenPositionFromBase.mockImplementation(async () => built([nftMint], { nftMint: nftMint.publicKey }));
  sdk.clmmGetOwnerPositionInfo.mockResolvedValue([
    { nftMint: Keypair.generate().publicKey },
    { nftMint: nftMint.publicKey, poolId },
  ]);
  sdk.clmmLockPosition.mockImplementation(async () => built([Keypair.generate()]));

  sdk.load.mockResolvedValue({
    api: { getCpmmConfigs: sdk.getCpmmConfigs, getClmmConfigs: sdk.getClmmConfigs },
    cpmm: { createPool: sdk.cpmmCreatePool, getPoolInfoFromRpc: sdk.cpmmGetPoolInfoFromRpc, lockLp: sdk.cpmmLockLp },
    clmm: {
      createPool: sdk.clmmCreatePool,
      getPoolInfoFromRpc: sdk.clmmGetPoolInfoFromRpc,
      openPositionFromBase: sdk.clmmOpenPositionFromBase,
      getOwnerPositionInfo: sdk.clmmGetOwnerPositionInfo,
      lockPosition: sdk.clmmLockPosition,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createLiquidityPool — AMM (CPMM)', () => {
  it('создаёт пул и возвращает его адрес', async () => {
    const result = await run(config());

    expect(result).toEqual({ poolAddress: poolId.toBase58(), lpLocked: false, txSignature: 'sig-1' });

    const params = sdk.cpmmCreatePool.mock.calls[0][0];
    expect(params.programId.equals(CREATE_CPMM_POOL_PROGRAM)).toBe(true);
    expect(params.mintA).toMatchObject({ address: mint.toBase58(), decimals: DECIMALS, programId: TOKEN_PROGRAM.toBase58() });
    expect(params.mintB).toMatchObject({ address: 'So11111111111111111111111111111111111111112', decimals: 9 });
    expect(params.mintAAmount.toString()).toBe(TOKENS.toString());
    expect(params.mintBAmount.toString()).toBe(LAMPORTS.toString());
    expect(params.feeConfig.tradeFeeRate).toBe(2_500); // 0.25 %, а не первый в списке
    expect(params.ownerInfo).toEqual({ useSOLBalance: true });

    const [tx] = sentTransactions();
    expect(isSignedBy(tx, payer.publicKey)).toBe(true);
    expect(sdk.cpmmLockLp).not.toHaveBeenCalled();
  });

  it('lockLp → блокирует все LP через Burn & Earn, lpLocked=true', async () => {
    const result = await run(config({ lockLp: true }));

    expect(result).toEqual({ poolAddress: poolId.toBase58(), lpLocked: true, txSignature: 'sig-1' });
    const lock = sdk.cpmmLockLp.mock.calls[0][0];
    expect(lock.lpAmount.toString()).toBe('89442719099');
    expect(lock.programId.equals(LOCK_CPMM_PROGRAM)).toBe(true);
    expect(sdk.cpmmGetPoolInfoFromRpc).toHaveBeenCalledWith(poolId.toBase58());

    const [, lockTx] = sentTransactions();
    const lockSigner = (await sdk.cpmmLockLp.mock.results[0].value).signers[0] as Keypair;
    expect(isSignedBy(lockTx, payer.publicKey)).toBe(true);
    expect(isSignedBy(lockTx, lockSigner.publicKey)).toBe(true); // эфемерный NFT-mint SDK
  });

  it('lockPeriodDays > 0 → предупреждение, что блокировка бессрочная', async () => {
    await run(config({ lockLp: true, lockPeriodDays: 30 }));

    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('бессрочная'));
  });
});

describe('createLiquidityPool — CLMM', () => {
  it('создаёт пул, вносит ликвидность на весь диапазон и блокирует позицию', async () => {
    const result = await run(config({ poolType: 'clmm', lockLp: true }));

    expect(result).toEqual({ poolAddress: poolId.toBase58(), lpLocked: true, txSignature: 'sig-1' });
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(3);

    const create = sdk.clmmCreatePool.mock.calls[0][0];
    expect(create.programId.equals(CLMM_PROGRAM_ID)).toBe(true);
    expect(create.ammConfig.tradeFeeRate).toBe(2_500);
    // 10 SOL / 800M токенов = 1.25e-8 SOL за токен
    expect(create.initialPrice.toNumber()).toBeCloseTo(1.25e-8, 20);

    const open = sdk.clmmOpenPositionFromBase.mock.calls[0][0];
    expect(open.tickLower).toBe(Math.ceil(MIN_TICK / 60) * 60);
    expect(open.tickUpper).toBe(Math.floor(MAX_TICK / 60) * 60);
    expect(open.base).toBe('MintA');
    expect(open.baseAmount.toString()).toBe(TOKENS.toString());
    expect(open.otherAmountMax.toString()).toBe('10100000000'); // SOL + 1 %

    const [, openTx] = sentTransactions();
    expect(isSignedBy(openTx, nftMint.publicKey)).toBe(true);

    const lock = sdk.clmmLockPosition.mock.calls[0][0];
    expect(lock.ownerPosition.nftMint.equals(nftMint.publicKey)).toBe(true);
  });

  it('без lockLp — две транзакции, lpLocked=false', async () => {
    const result = await run(config({ poolType: 'clmm' }));

    expect(result.lpLocked).toBe(false);
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(sdk.clmmLockPosition).not.toHaveBeenCalled();
  });
});

describe('ошибки', () => {
  it('ошибка отправки (preflight) → throw, дальше не идёт', async () => {
    rpc.sendRawTransaction.mockRejectedValueOnce(new Error('Simulation failed: insufficient funds'));

    await expect(run(config({ lockLp: true }))).rejects.toThrow(/insufficient funds/);
    expect(sdk.cpmmLockLp).not.toHaveBeenCalled();
  });

  it('транзакция упала on-chain → throw с подписью', async () => {
    rpc.getSignatureStatuses.mockResolvedValueOnce({ value: [{ err: { InstructionError: [2, { Custom: 1 }] } }] });

    await expect(run(config())).rejects.toThrow(/sig-1 упала/);
  });

  it('не подтверждена за 30 с → throw с подписью и предупреждением', async () => {
    rpc.getSignatureStatuses.mockResolvedValue({ value: [null] });

    await expect(run(config(), RAYDIUM_TX_TIMEOUT_MS)).rejects.toThrow(/sig-1 не подтверждена за 30 с.*может пройти/);
  });

  it('пул создан, блокировка упала → RaydiumPartialError с адресом пула', async () => {
    rpc.getSignatureStatuses
      .mockResolvedValueOnce({ value: [{ err: null, confirmationStatus: 'confirmed' }] })
      .mockResolvedValueOnce({ value: [{ err: { InstructionError: [0, 'Custom'] } }] });

    const error = await run(config({ lockLp: true })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RaydiumPartialError);
    expect((error as RaydiumPartialError).partial).toEqual({
      poolAddress: poolId.toBase58(),
      lpLocked: false,
      txSignature: 'sig-1',
    });
  });

  it('CLMM: ликвидность не внеслась → RaydiumPartialError', async () => {
    sdk.clmmOpenPositionFromBase.mockRejectedValueOnce(new Error('tick array error'));

    const error = await run(config({ poolType: 'clmm' })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RaydiumPartialError);
    expect((error as Error).message).toMatch(/ликвидность не внесена.*tick array error/);
  });

  it('нет initialLiquidityTokens → throw до любых запросов', async () => {
    await expect(run(config({ initialLiquidityTokens: undefined }))).rejects.toThrow(/initialLiquidityTokens/);
    expect(rpc.getGenesisHash).not.toHaveBeenCalled();
  });

  it('не хватает токенов или SOL → throw до создания пула', async () => {
    rpc.getParsedTokenAccountsByOwner.mockResolvedValueOnce({ value: [] });
    await expect(run(config())).rejects.toThrow(/Недостаточно токенов/);

    rpc.getBalance.mockResolvedValueOnce(1_000_000_000);
    await expect(run(config())).rejects.toThrow(/Недостаточно SOL/);

    expect(sdk.cpmmCreatePool).not.toHaveBeenCalled();
  });

  it('не mint-аккаунт → throw', async () => {
    rpc.getParsedAccountInfo.mockResolvedValueOnce({ value: null });

    await expect(run(config())).rejects.toThrow(/не mint-аккаунт/);
  });

  it('неизвестная сеть → throw', async () => {
    rpc.getGenesisHash.mockResolvedValueOnce('localnet-genesis');

    await expect(run(config())).rejects.toThrow(/только на mainnet и devnet/);
  });
});

describe('devnet', () => {
  it('берёт devnet-программы и пересчитывает id конфига комиссий', async () => {
    rpc.getGenesisHash.mockResolvedValue(DEVNET_GENESIS);

    await run(config());

    expect(sdk.load.mock.calls[0][0]).toMatchObject({ cluster: 'devnet' });
    const params = sdk.cpmmCreatePool.mock.calls[0][0];
    expect(params.programId.equals(DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM)).toBe(true);
    expect(params.feeConfig.id).toBe(
      getCpmmPdaAmmConfigId(DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, 0).publicKey.toBase58(),
    );
    expect(CPMM_CONFIGS[1].id).not.toBe(params.feeConfig.id); // исходный конфиг не мутирован
  });
});
