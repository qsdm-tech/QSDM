type QsdmMinerEnrollmentBond = {
  ready?: boolean;
  bondMode?: 'upfront' | 'mining_rewards';
  fullyBonded?: boolean;
};

// Whether a miner's bond comes from mining rewards, so a wallet without CELL
// is ready to start the miner (no fee reserve). True when the network offers
// "Use mining earnings" for a new enrollment, or when this miner's active
// "Use mining earnings" enrollment is not fully_bonded yet: its rewards still
// fill the bond, so the wallet may stay empty. Once fully_bonded, the rewards
// are spendable again and only the network offer counts.
export const isQsdmMinerBondFromRewards = ({
  networkOffersDeferredBond,
  enrollment,
}: {
  networkOffersDeferredBond?: boolean;
  enrollment?: QsdmMinerEnrollmentBond;
}) =>
  Boolean(networkOffersDeferredBond) ||
  Boolean(
    enrollment?.ready &&
      enrollment.bondMode === 'mining_rewards' &&
      enrollment.fullyBonded !== true
  );

type TaskBalanceEligibilityInput = {
  taskType?: string;
  nativeBalance: number;
  tokenBalance: number;
  stakeAmount: number;
  existingStake: number;
  nativeFeeReserve: number;
  waiveNativeFeeReserve?: boolean;
};

export const getTaskBalanceEligibility = ({
  taskType,
  nativeBalance,
  tokenBalance,
  stakeAmount,
  existingStake,
  nativeFeeReserve,
  waiveNativeFeeReserve = false,
}: TaskBalanceEligibilityInput) => {
  const isKplTask = taskType === 'KPL';
  const hasExistingStake = existingStake > 0;
  const stakingBalance = isKplTask ? tokenBalance : nativeBalance;
  const effectiveNativeFeeReserve = waiveNativeFeeReserve
    ? 0
    : nativeFeeReserve;
  const requiredNativeBalance =
    isKplTask || hasExistingStake
      ? effectiveNativeFeeReserve
      : stakeAmount + effectiveNativeFeeReserve;

  return {
    isKplTask,
    hasEnoughBalanceForStaking:
      hasExistingStake || stakingBalance >= stakeAmount,
    hasEnoughNativeTokens: nativeBalance >= requiredNativeBalance,
    requiredNativeBalance,
  };
};
