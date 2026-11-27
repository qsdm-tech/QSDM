import { Event } from 'electron';

import {
  buildQsdmCoreApiUrl,
  QSDM_CELL_DECIMALS,
  QSDM_TASK_RUNTIME_MODE,
  QSDM_WALLET_ADDRESS,
} from 'config/qsdm';
import { onQsdmActiveWalletChanged } from 'main/services/qsdmActiveWallet';
import { getQsdmTaskActionSender } from 'main/services/qsdmTaskActionSigner';
import { getQsdmCanonicalChainSafety } from 'main/services/qsdmCanonicalChain';
import { qsdmGetJson } from 'main/services/qsdmHttpRead';
import { selectQsdmWalletAddress } from 'main/services/qsdmWalletAddress';
import sdk from 'main/services/sdk';
import { QsdmWalletBalanceResponse } from 'models/api/qsdm';
import { PublicKey } from 'vendor/qsdm-chain/web3';

const balanceCache: Record<string, { balance: number; timestamp: number }> = {};
const CACHE_TIME = 5000;
const QSDM_ADDRESS = /^[0-9a-f]{64}$/i;

// A wallet switch drops every cached balance.
onQsdmActiveWalletChanged(() => {
  Object.keys(balanceCache).forEach((key) => {
    delete balanceCache[key];
  });
});

const getCachedBalance = (pubkey: string) => {
  const cached = balanceCache[pubkey];
  if (!cached || Date.now() - cached.timestamp >= CACHE_TIME) return undefined;

  return cached.balance;
};

const getStaleCachedBalance = (pubkey: string) => balanceCache[pubkey]?.balance;

const setCachedBalance = (pubkey: string, balance: number) => {
  balanceCache[pubkey] = { balance, timestamp: Date.now() };
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  return String(error);
};

// A QSDM address is read as it is; a legacy key (the K2 main account the renderer passes) stands for the ACTIVE
// wallet. Balances are cached under the QSDM address that was read, never under the legacy key: after a wallet
// switch that key must not answer with the previous wallet's balance.
const resolveQsdmBalanceAddress = (pubkey: string) => {
  const requested = pubkey?.trim() || '';
  if (
    QSDM_ADDRESS.test(requested) ||
    (!!requested && requested === QSDM_WALLET_ADDRESS)
  ) {
    return requested;
  }
  return selectQsdmWalletAddress({
    signerAddress: getQsdmTaskActionSender(),
    configuredAddress: QSDM_WALLET_ADDRESS,
  });
};

const getQsdmNativeBalance = async (qsdmAddress: string) => {
  const safety = await getQsdmCanonicalChainSafety();
  if (!safety.safe) {
    throw new Error(
      safety.detail || 'QSDM canonical network could not be verified'
    );
  }

  const url = new URL(buildQsdmCoreApiUrl('/wallet/balance'));
  url.searchParams.set('address', qsdmAddress);

  const response = await qsdmGetJson<QsdmWalletBalanceResponse>(
    url.toString(),
    { timeout: 4000 }
  );

  return Math.round(
    Number(response.balance || 0) * 10 ** QSDM_CELL_DECIMALS
  );
};

const getAccountBalance = async (_: Event, pubkey: string): Promise<number> => {
  const qsdmAddress =
    QSDM_TASK_RUNTIME_MODE === 'qsdm-native'
      ? resolveQsdmBalanceAddress(pubkey)
      : '';
  const cacheKey = qsdmAddress ? `qsdm:${qsdmAddress.toLowerCase()}` : pubkey;
  const cachedBalance = getCachedBalance(cacheKey);
  if (cachedBalance !== undefined) return cachedBalance;

  try {
    if (qsdmAddress) {
      const qsdmBalance = await getQsdmNativeBalance(qsdmAddress);
      setCachedBalance(cacheKey, qsdmBalance);
      return qsdmBalance;
    }

    const balance = await sdk.k2Connection.getBalance(
      new PublicKey(pubkey),
      'processed'
    );
    setCachedBalance(cacheKey, balance);
    return balance;
  } catch (error) {
    const staleBalance = getStaleCachedBalance(cacheKey);
    console.warn(
      staleBalance === undefined
        ? `Account balance lookup failed for ${pubkey}; no confirmed balance is cached yet. ${getErrorMessage(
            error
          )}`
        : `Account balance lookup failed for ${pubkey}; retaining the last confirmed balance. ${getErrorMessage(
            error
          )}`
    );
    return staleBalance ?? 0;
  }
};

export default getAccountBalance;
