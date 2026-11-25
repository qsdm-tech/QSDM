/**
 * @jest-environment node
 */

import { BrowserWindow, dialog } from 'electron';

import { autoUpdater } from 'electron-updater';

import { RendererEndpoints } from 'config/endpoints';

import { app } from './app';
import {
  checkForUpdates,
  getQsdmHiveUpdateFeedUrl,
  initializeAppUpdater,
  QSDM_HIVE_NO_SELF_UPDATE_MESSAGE,
  resetAppUpdaterForTests,
  restartToUpdate,
  shouldEnableAutoUpdates,
} from './AppUpdater';
import { getHiveInstallId, getHiveRolloutBucket } from './services/hiveRollout';
import { getDownloadedHiveUpdate } from './services/hiveUpdateState';
import {
  getVerifiedQsdmHiveRelease,
  verifyDownloadedQsdmHiveUpdate,
} from './services/qsdmReleaseManifest';

import type { UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import type { EventEmitter } from 'events';

jest.mock('electron-updater', () => {
  const { EventEmitter } = jest.requireActual('events');
  const updater = new EventEmitter();
  Object.assign(updater, {
    app: { baseCachePath: 'original-cache' },
    checkForUpdates: jest.fn(),
    downloadUpdate: jest.fn(),
    quitAndInstall: jest.fn(),
    setFeedURL: jest.fn(),
  });
  return { autoUpdater: updater };
});

jest.mock('./services/hiveRollout', () => ({
  ...jest.requireActual('./services/hiveRollout'),
  getHiveInstallId: jest.fn(() => null),
}));

jest.mock('./services/qsdmReleaseManifest', () => ({
  QSDM_HIVE_RELEASE_BASE_URL: 'https://qsdm.tech/downloads/hive-v2',
  getVerifiedQsdmHiveRelease: jest.fn(),
  verifyDownloadedQsdmHiveUpdate: jest.fn(),
}));

type MockUpdater = EventEmitter & {
  app: { baseCachePath: string };
  checkForUpdates: jest.Mock;
  downloadUpdate: jest.Mock;
  quitAndInstall: jest.Mock;
  setFeedURL: jest.Mock;
};

const updater = autoUpdater as unknown as MockUpdater;
const release = {
  manifest: { version: '1.4.12' },
  installerUrl: 'https://qsdm.tech/downloads/qsdm-hive-1.4.12.exe',
  installer: { name: 'qsdm-hive-1.4.12.exe' },
};

const flushPromises = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const updateInfo: UpdateInfo = {
  version: '1.4.12',
  files: [],
  path: 'qsdm-hive-1.4.12.exe',
  sha512: 'test-sha512',
  releaseDate: '2026-08-04T00:00:00.000Z',
};

describe('AppUpdater release channels', () => {
  it('keeps stable builds on the production feed', () => {
    expect(getQsdmHiveUpdateFeedUrl({}, '1.3.95')).toBe(
      'https://qsdm.tech/downloads/hive-v2'
    );
  });

  it('isolates unsigned previews and disables their automatic updater', () => {
    const previewVersion = '1.3.95-unsigned-preview.1';

    expect(getQsdmHiveUpdateFeedUrl({}, previewVersion)).toBe(
      'https://qsdm.tech/downloads/unsigned-preview'
    );
    expect(shouldEnableAutoUpdates({}, previewVersion)).toBe(false);
    expect(
      shouldEnableAutoUpdates({ QSDM_ENABLE_AUTO_UPDATES: '1' }, previewVersion)
    ).toBe(false);
  });

  it('does not let environment overrides disable stable production updates', () => {
    for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
      expect(
        shouldEnableAutoUpdates(
          {
            NODE_ENV: 'production',
            QSDM_DISABLE_AUTO_UPDATES: '1',
          },
          '1.4.12',
          platform
        )
      ).toBe(true);
    }
  });

  it('runs no updater in an e2e run of a build that is not packaged, but always in a packaged one', () => {
    const env = { NODE_ENV: 'production', QSDM_HIVE_E2E: '1' };
    expect(shouldEnableAutoUpdates(env, '1.4.28', 'linux')).toBe(false);
    const packaged = jest.replaceProperty(app, 'isPackaged', true);
    try {
      expect(shouldEnableAutoUpdates(env, '1.4.28', 'linux')).toBe(true);
    } finally {
      packaged.restore();
    }
  });

  it('never installs signed Windows or Linux updates on macOS', () => {
    expect(
      shouldEnableAutoUpdates(
        { NODE_ENV: 'production', QSDM_ENABLE_AUTO_UPDATES: '1' },
        '1.4.12',
        'darwin'
      )
    ).toBe(false);
  });

  it('never configures, fetches or runs the updater on macOS', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    const calls = () => [
      updater.setFeedURL.mock.calls.length,
      updater.checkForUpdates.mock.calls.length,
      updater.downloadUpdate.mock.calls.length,
      (getVerifiedQsdmHiveRelease as jest.Mock).mock.calls.length,
    ];
    const before = calls();
    resetAppUpdaterForTests();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      await initializeAppUpdater(undefined, jest.fn());
      // The update screen's own check is refused too.
      await expect(checkForUpdates()).rejects.toThrow(
        QSDM_HIVE_NO_SELF_UPDATE_MESSAGE
      );
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
      resetAppUpdaterForTests();
    }
    expect(calls()).toEqual(before);
  });
});

describe('AppUpdater mandatory update flow', () => {
  const originalEnableAutoUpdates = process.env.QSDM_ENABLE_AUTO_UPDATES;
  const mainWindow = {
    isDestroyed: jest.fn(() => false),
    isMinimized: jest.fn(() => true),
    restore: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
    webContents: {
      isDestroyed: jest.fn(() => false),
      send: jest.fn(),
    },
  };
  const appCleanup = jest.fn(() => Promise.resolve());

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    process.env.QSDM_ENABLE_AUTO_UPDATES = '1';
    resetAppUpdaterForTests();
    updater.removeAllListeners();
    updater.app = { baseCachePath: 'original-cache' };
    updater.checkForUpdates.mockReset();
    updater.downloadUpdate.mockReset();
    updater.quitAndInstall.mockReset();
    updater.setFeedURL.mockReset();
    updater.downloadUpdate.mockResolvedValue(['installer']);
    (getVerifiedQsdmHiveRelease as jest.Mock).mockReset();
    (getVerifiedQsdmHiveRelease as jest.Mock).mockResolvedValue(release);
    (verifyDownloadedQsdmHiveUpdate as jest.Mock).mockReset();
    (verifyDownloadedQsdmHiveUpdate as jest.Mock).mockResolvedValue(undefined);
    (dialog.showErrorBox as jest.Mock).mockReset();
    (dialog.showMessageBox as jest.Mock).mockReset();
    (dialog.showMessageBox as jest.Mock).mockResolvedValue({ response: 0 });
    mainWindow.isDestroyed.mockClear();
    mainWindow.isMinimized.mockClear();
    mainWindow.restore.mockClear();
    mainWindow.show.mockClear();
    mainWindow.focus.mockClear();
    mainWindow.webContents.isDestroyed.mockClear();
    mainWindow.webContents.send.mockClear();
    appCleanup.mockClear();
    app.isQuitting = false;
  });

  afterEach(() => {
    resetAppUpdaterForTests();
    updater.removeAllListeners();
    jest.useRealTimers();
    if (originalEnableAutoUpdates === undefined) {
      delete process.env.QSDM_ENABLE_AUTO_UPDATES;
    } else {
      process.env.QSDM_ENABLE_AUTO_UPDATES = originalEnableAutoUpdates;
    }
  });

  it('checks immediately after startup and always starts the trusted download', async () => {
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', updateInfo);
      return {
        isUpdateAvailable: true,
        updateInfo,
      };
    });

    await initializeAppUpdater(
      mainWindow as unknown as BrowserWindow,
      appCleanup
    );
    expect(updater.listenerCount('update-available')).toBe(1);
    await flushPromises();
    await flushPromises();

    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://qsdm.tech/downloads/hive-v2',
    });
    expect(getVerifiedQsdmHiveRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://qsdm.tech/downloads/hive-v2',
      })
    );
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      RendererEndpoints.UPDATE_AVAILABLE,
      updateInfo
    );
    expect(mainWindow.restore).toHaveBeenCalledTimes(1);
    expect(mainWindow.show).toHaveBeenCalledTimes(1);
    expect(mainWindow.focus).toHaveBeenCalledTimes(1);
  });

  it('retries a transient startup failure after one minute', async () => {
    updater.checkForUpdates
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce({
        isUpdateAvailable: false,
        updateInfo: { version: '1.4.11' },
      });

    await initializeAppUpdater(
      mainWindow as unknown as BrowserWindow,
      appCleanup
    );
    await flushPromises();
    await flushPromises();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('verifies the installer, notifies every renderer, and waits for Restart to update', async () => {
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '1.4.11' },
    });
    await initializeAppUpdater(
      mainWindow as unknown as BrowserWindow,
      appCleanup
    );

    const downloadedInfo: UpdateDownloadedEvent = {
      ...updateInfo,
      downloadedFile: 'qsdm-hive-1.4.12.exe',
    };
    updater.emit('update-downloaded', downloadedInfo);
    await flushPromises();
    await flushPromises();

    expect(verifyDownloadedQsdmHiveUpdate).toHaveBeenCalledWith(
      'qsdm-hive-1.4.12.exe',
      release
    );
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      RendererEndpoints.UPDATE_DOWNLOADED,
      expect.objectContaining({ version: '1.4.12' })
    );
    // No prompt and no restart on its own: Hive and its miner keep running.
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(getDownloadedHiveUpdate()).toBe('1.4.12');

    await expect(restartToUpdate()).resolves.toEqual({ restarting: true });
    expect(appCleanup).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(app.isQuitting).toBe(true);
  });

  it('downloads first and restarts once verified when Restart to update comes early', async () => {
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo,
    });
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('update-downloaded', {
        ...updateInfo,
        downloadedFile: 'qsdm-hive-1.4.12.exe',
      });
      return ['installer'];
    });
    await initializeAppUpdater(
      mainWindow as unknown as BrowserWindow,
      appCleanup
    );
    await flushPromises();

    await expect(restartToUpdate()).resolves.toEqual({ restarting: false });
    await flushPromises();
    await flushPromises();

    expect(verifyDownloadedQsdmHiveUpdate).toHaveBeenCalled();
    expect(appCleanup).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe('AppUpdater staged rollout (rollout_percent)', () => {
  const originalEnableAutoUpdates = process.env.QSDM_ENABLE_AUTO_UPDATES;
  const appCleanup = jest.fn(() => Promise.resolve());
  // An install ID whose bucket for 1.4.12 is exactly `bucket`.
  const idWithBucket = (bucket: number) => {
    for (let n = 0; n < 100000; n += 1) {
      const id = n.toString(16).padStart(32, '0');
      if (getHiveRolloutBucket(id, '1.4.12') === bucket) return id;
    }
    throw new Error('no install ID');
  };
  const releaseWith = (fields: Record<string, unknown>) => ({
    ...release,
    manifest: { version: '1.4.12', ...fields },
  });
  const startWith = async (
    installed: string,
    fields: Record<string, unknown>,
    bucket: number
  ) => {
    (app.getVersion as jest.Mock).mockReturnValue(installed);
    (getHiveInstallId as jest.Mock).mockReturnValue(idWithBucket(bucket));
    (getVerifiedQsdmHiveRelease as jest.Mock).mockResolvedValue(
      releaseWith(fields)
    );
    await initializeAppUpdater(undefined, appCleanup);
    await flushPromises();
    await flushPromises();
  };

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    process.env.QSDM_ENABLE_AUTO_UPDATES = '1';
    resetAppUpdaterForTests();
    updater.removeAllListeners();
    updater.checkForUpdates.mockReset();
    updater.downloadUpdate.mockReset();
    updater.downloadUpdate.mockResolvedValue(['installer']);
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', updateInfo);
      return { isUpdateAvailable: true, updateInfo };
    });
    (getVerifiedQsdmHiveRelease as jest.Mock).mockReset();
    (getHiveInstallId as jest.Mock).mockReset();
  });

  afterEach(() => {
    resetAppUpdaterForTests();
    updater.removeAllListeners();
    jest.useRealTimers();
    (app.getVersion as jest.Mock).mockReturnValue('0.0.0');
    if (originalEnableAutoUpdates === undefined) {
      delete process.env.QSDM_ENABLE_AUTO_UPDATES;
    } else {
      process.env.QSDM_ENABLE_AUTO_UPDATES = originalEnableAutoUpdates;
    }
  });

  it('holds the automatic download back outside the rollout', async () => {
    await startWith(
      '1.4.11',
      { min_supported_version: '1.4.11', rollout_percent: 10 },
      10
    );
    expect(getVerifiedQsdmHiveRelease).toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    // The next automatic check (30 minutes) asks again, and is held back again.
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    await flushPromises();
    expect(getVerifiedQsdmHiveRelease).toHaveBeenCalledTimes(2);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('downloads at once inside the rollout', async () => {
    await startWith(
      '1.4.11',
      { min_supported_version: '1.4.11', rollout_percent: 10 },
      9
    );
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('starts downloading once a re-signed release raises the percentage', async () => {
    await startWith(
      '1.4.11',
      { min_supported_version: '1.4.11', rollout_percent: 10 },
      40
    );
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    (getVerifiedQsdmHiveRelease as jest.Mock).mockResolvedValue(
      releaseWith({ min_supported_version: '1.4.11', rollout_percent: 50 })
    );
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    await flushPromises();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('never holds back a Hive below min_supported_version', async () => {
    await startWith(
      '1.4.10',
      { min_supported_version: '1.4.11', rollout_percent: 0 },
      99
    );
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('never holds back a security release (min = version)', async () => {
    await startWith(
      '1.4.11',
      { min_supported_version: '1.4.12', rollout_percent: 0 },
      99
    );
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('without rollout_percent it updates as before and reads no install ID', async () => {
    await startWith('1.4.11', { min_supported_version: '1.4.11' }, 99);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(getHiveInstallId).not.toHaveBeenCalled();
  });

  it('a check the user asks for is not held back', async () => {
    await startWith(
      '1.4.11',
      { min_supported_version: '1.4.11', rollout_percent: 0 },
      99
    );
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await expect(checkForUpdates()).resolves.toEqual(
      expect.objectContaining({ isUpdateAvailable: true })
    );
    await flushPromises();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });
});
