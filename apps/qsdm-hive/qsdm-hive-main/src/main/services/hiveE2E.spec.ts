/**
 * @jest-environment node
 */
import { app } from '../app';

import { isHiveE2ETestRun } from './hiveE2E';
import {
  getHiveVersionPolicyStatus,
  resetHiveVersionPolicyCacheForTests,
} from './hiveVersionPolicy';
import { getQsdmBountyLedgerUrl } from './qsdmBountyLedger';
import { getQsdmHiveReleaseWithEnvelopeCache } from './qsdmReleaseEnvelopeCache';

jest.mock('./qsdmReleaseEnvelopeCache', () => ({
  RELEASE_ENVELOPE_CACHE_FOLDER_NAME: 'release-envelope-cache',
  getQsdmHiveReleaseWithEnvelopeCache: jest.fn(),
}));

const setPackaged = (packaged: boolean) => {
  (app as unknown as { isPackaged: boolean }).isPackaged = packaged;
};

describe('isHiveE2ETestRun', () => {
  afterEach(() => setPackaged(false));

  it('is true only for QSDM_HIVE_E2E=1 in a build that is not packaged', () => {
    expect(isHiveE2ETestRun({ QSDM_HIVE_E2E: '1' }, false)).toBe(true);
    expect(isHiveE2ETestRun({ QSDM_HIVE_E2E: '1' }, true)).toBe(false);
    expect(isHiveE2ETestRun({}, false)).toBe(false);
    for (const value of ['0', 'true', 'yes', ' 1', '']) {
      expect(isHiveE2ETestRun({ QSDM_HIVE_E2E: value }, false)).toBe(false);
    }
  });

  it('reads app.isPackaged by default', () => {
    setPackaged(true);
    expect(isHiveE2ETestRun({ QSDM_HIVE_E2E: '1' })).toBe(false);
    setPackaged(false);
    expect(isHiveE2ETestRun({ QSDM_HIVE_E2E: '1' })).toBe(true);
  });
});

describe('bug bounty ledger URL', () => {
  const MOCK = 'http://127.0.0.1:4567/bounty/payouts.json';
  const PUBLIC = 'https://qsdm.tech/bounty/payouts.json';

  afterEach(() => setPackaged(false));

  it('is the public ledger unless an e2e run names another', () => {
    expect(getQsdmBountyLedgerUrl({})).toBe(PUBLIC);
    expect(
      getQsdmBountyLedgerUrl({ QSDM_HIVE_E2E_BOUNTY_LEDGER_URL: MOCK })
    ).toBe(PUBLIC);
    expect(
      getQsdmBountyLedgerUrl({
        QSDM_HIVE_E2E: '1',
        QSDM_HIVE_E2E_BOUNTY_LEDGER_URL: MOCK,
      })
    ).toBe(MOCK);
    expect(getQsdmBountyLedgerUrl({ QSDM_HIVE_E2E: '1' })).toBe(PUBLIC);
  });

  it('a packaged Hive always reads the public ledger', () => {
    setPackaged(true);
    expect(
      getQsdmBountyLedgerUrl({
        QSDM_HIVE_E2E: '1',
        QSDM_HIVE_E2E_BOUNTY_LEDGER_URL: MOCK,
      })
    ).toBe(PUBLIC);
  });
});

describe('version policy in an e2e run', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      // Leaves the jest-only switch-off, so only QSDM_HIVE_E2E decides.
      QSDM_HIVE_VERSION_MANIFEST_URL: 'https://qsdm.tech/downloads/latest.yml',
      QSDM_HIVE_E2E: '1',
    };
    delete process.env.QSDM_HIVE_REQUIRED_VERSION;
    delete process.env.QSDM_HIVE_DISABLE_VERSION_POLICY;
    (getQsdmHiveReleaseWithEnvelopeCache as jest.Mock).mockReset();
    (getQsdmHiveReleaseWithEnvelopeCache as jest.Mock).mockRejectedValue(
      new Error('feed unavailable')
    );
    resetHiveVersionPolicyCacheForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    setPackaged(false);
    resetHiveVersionPolicyCacheForTests();
  });

  it('is switched off in an e2e run (not packaged), without reading the feed', async () => {
    const status = await getHiveVersionPolicyStatus({ forceRefresh: true });
    expect(status).toMatchObject({
      compatible: true,
      reason: 'policy-disabled',
    });
    expect(getQsdmHiveReleaseWithEnvelopeCache).not.toHaveBeenCalled();
  });

  it('still applies in a packaged Hive with the same switch', async () => {
    setPackaged(true);
    const status = await getHiveVersionPolicyStatus({ forceRefresh: true });
    expect(status).toMatchObject({
      compatible: false,
      reason: 'manifest-unavailable',
    });
    expect(getQsdmHiveReleaseWithEnvelopeCache).toHaveBeenCalled();
  });
});
