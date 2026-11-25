import {
  getTaskBalanceEligibility,
  isQsdmMinerBondFromRewards,
} from './taskBalanceEligibility';

const CELL = 1_000_000_000;

describe('getTaskBalanceEligibility', () => {
  it.each(['CELL', 'KOII', undefined])(
    'allows a 1 CELL stake from a 5 CELL native wallet for task type %p',
    (taskType) => {
      expect(
        getTaskBalanceEligibility({
          taskType,
          nativeBalance: 5 * CELL,
          tokenBalance: 0,
          stakeAmount: CELL,
          existingStake: 0,
          nativeFeeReserve: CELL / 10,
        })
      ).toMatchObject({
        isKplTask: false,
        hasEnoughBalanceForStaking: true,
        hasEnoughNativeTokens: true,
      });
    }
  );

  it('uses the token balance only for an actual KPL task', () => {
    expect(
      getTaskBalanceEligibility({
        taskType: 'KPL',
        nativeBalance: 5 * CELL,
        tokenBalance: 0,
        stakeAmount: CELL,
        existingStake: 0,
        nativeFeeReserve: CELL / 10,
      })
    ).toMatchObject({
      isKplTask: true,
      hasEnoughBalanceForStaking: false,
      hasEnoughNativeTokens: true,
    });
  });

  it('requires only the fee reserve after stake is already confirmed', () => {
    expect(
      getTaskBalanceEligibility({
        taskType: 'CELL',
        nativeBalance: CELL / 10,
        tokenBalance: 0,
        stakeAmount: CELL,
        existingStake: CELL,
        nativeFeeReserve: CELL / 10,
      })
    ).toMatchObject({
      hasEnoughBalanceForStaking: true,
      hasEnoughNativeTokens: true,
    });
  });

  describe('isQsdmMinerBondFromRewards', () => {
    const filling = {
      ready: true,
      bondMode: 'mining_rewards' as const,
      fullyBonded: false,
    };

    it('counts an active "Use mining earnings" bond that is not fully bonded', () => {
      // Even when the network status is not known (offline, HTTP 429).
      expect(isQsdmMinerBondFromRewards({ enrollment: filling })).toBe(true);
      expect(
        isQsdmMinerBondFromRewards({
          networkOffersDeferredBond: false,
          enrollment: filling,
        })
      ).toBe(true);
    });

    it('stops counting the enrollment once it is fully bonded', () => {
      expect(
        isQsdmMinerBondFromRewards({
          enrollment: { ...filling, fullyBonded: true },
        })
      ).toBe(false);
      expect(
        isQsdmMinerBondFromRewards({
          networkOffersDeferredBond: true,
          enrollment: { ...filling, fullyBonded: true },
        })
      ).toBe(true);
    });

    it('ignores upfront and inactive enrollments', () => {
      expect(
        isQsdmMinerBondFromRewards({
          enrollment: { ready: true, bondMode: 'upfront', fullyBonded: false },
        })
      ).toBe(false);
      expect(
        isQsdmMinerBondFromRewards({ enrollment: { ...filling, ready: false } })
      ).toBe(false);
      expect(isQsdmMinerBondFromRewards({})).toBe(false);
      expect(
        isQsdmMinerBondFromRewards({ networkOffersDeferredBond: true })
      ).toBe(true);
    });
  });

  it('allows a zero-balance miner when its protocol bond and fee come from mining rewards', () => {
    expect(
      getTaskBalanceEligibility({
        taskType: 'CELL',
        nativeBalance: 0,
        tokenBalance: 0,
        stakeAmount: 0,
        existingStake: 0,
        nativeFeeReserve: CELL / 10,
        waiveNativeFeeReserve: true,
      })
    ).toMatchObject({
      hasEnoughBalanceForStaking: true,
      hasEnoughNativeTokens: true,
      requiredNativeBalance: 0,
    });
  });
});
