/**
 * @jest-environment node
 */
import { Endpoints, RendererEndpoints } from 'config/endpoints';
import { sendEventAllWindows } from 'utils/sendEventAllWindows';

import { app } from '../app';

import { setDownloadedHiveUpdate } from './hiveUpdateState';
import {
  assertHiveVersionPolicyAllowsEndpoint,
  getHiveVersionPolicyStatus,
  resetHiveVersionPolicyCacheForTests,
} from './hiveVersionPolicy';
import { getQsdmHiveReleaseWithEnvelopeCache } from './qsdmReleaseEnvelopeCache';
import { getQsdmHiveMinSupportedVersion } from './qsdmReleaseManifest';

jest.mock('./qsdmReleaseEnvelopeCache', () => ({
  RELEASE_ENVELOPE_CACHE_FOLDER_NAME: 'release-envelope-cache',
  getQsdmHiveReleaseWithEnvelopeCache: jest.fn(),
}));

jest.mock('utils/sendEventAllWindows', () => ({
  sendEventAllWindows: jest.fn(),
}));

const signedRelease = (manifest: Record<string, unknown>) => ({
  manifest: { version: '1.4.27', ...manifest },
  manifestUrl: 'https://qsdm.tech/downloads/hive-v2/release.json',
  installerUrl: 'https://qsdm.tech/downloads/hive-v2/qsdm-hive-1.4.27.exe',
  source: 'feed',
});

const statusFor = async (
  installed: string,
  manifest: Record<string, unknown>
) => {
  jest.spyOn(app, 'getVersion').mockReturnValue(installed);
  (getQsdmHiveReleaseWithEnvelopeCache as jest.Mock).mockResolvedValue(
    signedRelease(manifest)
  );
  resetHiveVersionPolicyCacheForTests();
  return getHiveVersionPolicyStatus({ forceRefresh: true });
};

describe('signed min_supported_version', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Leaves the test-run switch-off: the policy reads the (mocked) release.
    process.env = {
      ...originalEnv,
      QSDM_HIVE_VERSION_MANIFEST_URL: 'https://qsdm.tech/downloads/latest.yml',
    };
    delete process.env.QSDM_HIVE_REQUIRED_VERSION;
    delete process.env.QSDM_HIVE_DISABLE_VERSION_POLICY;
    setDownloadedHiveUpdate(null);
    (sendEventAllWindows as jest.Mock).mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  it('keeps an older supported Hive compatible and reports the update', async () => {
    const status = await statusFor('1.4.26', {
      min_supported_version: '1.4.26',
    });

    expect(status).toMatchObject({
      compatible: true,
      updateRequired: false,
      requiredVersion: '1.4.26',
      latestVersion: '1.4.27',
      updateAvailable: true,
      reason: 'current',
    });
    await expect(
      assertHiveVersionPolicyAllowsEndpoint(Endpoints.START_TASK)
    ).resolves.toBeUndefined();
  });

  it('blocks a Hive below it, with Restart to update', async () => {
    const status = await statusFor('1.4.25', {
      min_supported_version: '1.4.26',
    });

    expect(status).toMatchObject({
      compatible: false,
      updateRequired: true,
      requiredVersion: '1.4.26',
    });
    await expect(
      assertHiveVersionPolicyAllowsEndpoint(Endpoints.START_TASK)
    ).rejects.toThrow(
      'QSDM Hive 1.4.25 is blocked by version policy. Required version: 1.4.26. Restart to update.'
    );
    expect(sendEventAllWindows).toHaveBeenCalledWith(
      RendererEndpoints.HIVE_UPDATE_REQUIRED
    );
    // The button's own action is never blocked.
    await expect(
      assertHiveVersionPolicyAllowsEndpoint(Endpoints.RESTART_TO_UPDATE)
    ).resolves.toBeUndefined();
  });

  it('without the field requires exactly the release version, as before', async () => {
    const older = await statusFor('1.4.26', {});
    expect(older).toMatchObject({
      compatible: false,
      requiredVersion: '1.4.27',
      reason: 'version-mismatch',
    });
    expect(older).not.toHaveProperty('latestVersion');
    expect(older).not.toHaveProperty('updateAvailable');

    const newer = await statusFor('1.4.28', {});
    expect(newer.compatible).toBe(false);
    expect((await statusFor('1.4.27', {})).compatible).toBe(true);
  });

  it('ignores an invalid field and keeps the exact rule', async () => {
    for (const value of ['1.4', '1.5.0', 1426, '']) {
      // eslint-disable-next-line no-await-in-loop
      const status = await statusFor('1.4.26', {
        min_supported_version: value,
      });
      expect(status).toMatchObject({
        compatible: false,
        requiredVersion: '1.4.27',
      });
    }
  });

  it('reads only a valid version not above the release', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const read = (value: unknown) =>
      getQsdmHiveMinSupportedVersion({
        version: '1.4.27',
        min_supported_version: value as string,
      });
    expect(read(undefined)).toBeUndefined();
    expect(read('1.4.26')).toBe('1.4.26');
    expect(read('1.4.27')).toBe('1.4.27');
    expect(read('0.9.99')).toBe('0.9.99');
    expect(read('1.4.28')).toBeUndefined();
    expect(read('2.0.0')).toBeUndefined();
    expect(read('v1.4.26')).toBeUndefined();
  });

  it('reports a downloaded update for the Restart to update banner', async () => {
    setDownloadedHiveUpdate('1.4.27');
    const status = await statusFor('1.4.26', {
      min_supported_version: '1.4.26',
    });
    expect(status.updateDownloadedVersion).toBe('1.4.27');
  });
});
