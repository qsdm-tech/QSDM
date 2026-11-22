import { QueryClient } from 'react-query';

import { QueryKeys } from './reactQueryService';

/**
 * Queries whose answers belong to the ACTIVE QSDM wallet: balance, nonce and signer state, stakes, rewards, miner
 * enrollment, pool, links and referrals. A key matches every query that starts with it.
 */
export const QSDM_WALLET_QUERY_KEYS = [
  QueryKeys.QsdmCellAccount,
  QueryKeys.QsdmCoreStatus,
  QueryKeys.MainAccountBalance,
  QueryKeys.AccountBalance,
  QueryKeys.TaskStake,
  QueryKeys.taskNodeInfo,
  QueryKeys.AllTimeRewards,
  QueryKeys.TaskSubmissionRoundInfo,
  QueryKeys.QsdmMinerRewardStatus,
  QueryKeys.QsdmPulsePool,
  QueryKeys.QsdmSkyFangLinkStatus,
  QueryKeys.ReferralCode,
  QueryKeys.ReferralStatus,
];

/**
 * After a wallet switch: drop every answer of the previous wallet and fetch the new wallet's. A reset query shows
 * "loading", never the previous wallet's numbers, and an answer still on its way for the previous wallet is discarded.
 */
export const resetQsdmWalletQueries = (queryClient: QueryClient) =>
  Promise.all([
    ...QSDM_WALLET_QUERY_KEYS.map((key) => queryClient.resetQueries([key])),
    queryClient.invalidateQueries([QueryKeys.QsdmWalletList]),
  ]);
