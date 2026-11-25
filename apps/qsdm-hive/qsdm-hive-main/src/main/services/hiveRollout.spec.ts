/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { app } from '../app';

import {
  decideHiveUpdateOffer,
  getHiveInstallId,
  getHiveRolloutBucket,
  getQsdmHiveRolloutPercent,
  HIVE_INSTALL_ID_FILE_NAME,
  readOrCreateHiveInstallId,
  resetHiveInstallIdForTests,
} from './hiveRollout';

const ID_A = '0123456789abcdef0123456789abcdef';

// An install ID whose bucket for `version` is exactly `bucket`.
const idWithBucket = (bucket: number, version: string) => {
  for (let n = 0; n < 100000; n += 1) {
    const id = n.toString(16).padStart(32, '0');
    if (getHiveRolloutBucket(id, version) === bucket) return id;
  }
  throw new Error(`no install ID with bucket ${bucket}`);
};

describe('rollout_percent', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts whole numbers from 0 to 100', () => {
    expect(getQsdmHiveRolloutPercent({})).toBeUndefined();
    expect(getQsdmHiveRolloutPercent({ rollout_percent: 0 })).toBe(0);
    expect(getQsdmHiveRolloutPercent({ rollout_percent: 25 })).toBe(25);
    expect(getQsdmHiveRolloutPercent({ rollout_percent: 100 })).toBe(100);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([[-1], [101], [12.5], ['50'], [null], [NaN], [true]])(
    'ignores %p (every Hive is offered the update)',
    (value) => {
      expect(
        getQsdmHiveRolloutPercent({ rollout_percent: value })
      ).toBeUndefined();
      expect(console.warn).toHaveBeenCalledWith(
        'Ignoring an invalid rollout_percent in the release.'
      );
    }
  );
});

describe('rollout bucket', () => {
  it('is stable for one install and one version', () => {
    expect(getHiveRolloutBucket(ID_A, '1.4.28')).toBe(
      getHiveRolloutBucket(ID_A, '1.4.28')
    );
  });

  it('is between 0 and 99 and spread evenly', () => {
    const counts = new Array(10).fill(0);
    for (let n = 0; n < 5000; n += 1) {
      const bucket = getHiveRolloutBucket(
        n.toString(16).padStart(32, '0'),
        '1.4.28'
      );
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
      counts[Math.floor(bucket / 10)] += 1;
    }
    // 500 expected per tenth; a fair hash stays well inside 400..600.
    counts.forEach((count) => {
      expect(count).toBeGreaterThan(400);
      expect(count).toBeLessThan(600);
    });
  });

  it('changes with the release version', () => {
    const ids = Array.from({ length: 50 }, (_, n) =>
      n.toString(16).padStart(32, '0')
    );
    const same = ids.filter(
      (id) =>
        getHiveRolloutBucket(id, '1.4.28') ===
        getHiveRolloutBucket(id, '1.4.29')
    );
    expect(same.length).toBeLessThan(10);
  });
});

describe('decideHiveUpdateOffer', () => {
  const release = (fields: Record<string, unknown>) => ({
    version: '1.4.28',
    ...fields,
  });

  it('offers nothing to a Hive on the release or newer', () => {
    for (const currentVersion of ['1.4.28', '1.4.29', '1.5.0']) {
      expect(
        decideHiveUpdateOffer({
          currentVersion,
          manifest: release({
            min_supported_version: '1.4.27',
            rollout_percent: 100,
          }),
          installId: ID_A,
        })
      ).toEqual({ offer: false, reason: 'up-to-date' });
    }
  });

  it('offers the update to every Hive without rollout_percent (as before)', () => {
    expect(
      decideHiveUpdateOffer({
        currentVersion: '1.4.27',
        manifest: release({ min_supported_version: '1.4.27' }),
        installId: ID_A,
      })
    ).toEqual({ offer: true, reason: 'no-rollout' });
  });

  it('offers it inside the rollout and holds it back outside', () => {
    const inside = idWithBucket(9, '1.4.28');
    const edge = idWithBucket(10, '1.4.28');
    const manifest = release({
      min_supported_version: '1.4.27',
      rollout_percent: 10,
    });
    expect(
      decideHiveUpdateOffer({
        currentVersion: '1.4.27',
        manifest,
        installId: inside,
      })
    ).toEqual({ offer: true, reason: 'in-rollout', rolloutPercent: 10 });
    expect(
      decideHiveUpdateOffer({
        currentVersion: '1.4.27',
        manifest,
        installId: edge,
      })
    ).toEqual({ offer: false, reason: 'outside-rollout', rolloutPercent: 10 });
  });

  it('keeps a Hive in as the percentage grows', () => {
    const id = idWithBucket(42, '1.4.28');
    const offers = [0, 10, 42, 43, 50, 100].map(
      (rollout_percent) =>
        decideHiveUpdateOffer({
          currentVersion: '1.4.27',
          manifest: release({
            min_supported_version: '1.4.26',
            rollout_percent,
          }),
          installId: id,
        }).offer
    );
    expect(offers).toEqual([false, false, false, true, true, true]);
  });

  it('0 holds back every supported Hive; 100 offers it to all', () => {
    const ids = Array.from({ length: 200 }, (_, n) =>
      n.toString(16).padStart(32, '0')
    );
    const offered = (rollout_percent: number) =>
      ids.filter(
        (installId) =>
          decideHiveUpdateOffer({
            currentVersion: '1.4.27',
            manifest: release({
              min_supported_version: '1.4.27',
              rollout_percent,
            }),
            installId,
          }).offer
      ).length;
    expect(offered(0)).toBe(0);
    expect(offered(100)).toBe(200);
  });

  it('never holds back a Hive below min_supported_version', () => {
    expect(
      decideHiveUpdateOffer({
        currentVersion: '1.4.26',
        manifest: release({
          min_supported_version: '1.4.27',
          rollout_percent: 0,
        }),
        installId: ID_A,
      })
    ).toEqual({ offer: true, reason: 'required' });
  });

  it('never holds back a security release (min = version)', () => {
    expect(
      decideHiveUpdateOffer({
        currentVersion: '1.4.27',
        manifest: release({
          min_supported_version: '1.4.28',
          rollout_percent: 0,
        }),
        installId: ID_A,
      })
    ).toEqual({ offer: true, reason: 'required' });
  });

  it('without a valid min_supported_version every older Hive must update', () => {
    for (const min_supported_version of [undefined, '1.4', '1.4.29', 7]) {
      expect(
        decideHiveUpdateOffer({
          currentVersion: '1.4.27',
          manifest: release({ min_supported_version, rollout_percent: 0 }),
          installId: ID_A,
        })
      ).toEqual({ offer: true, reason: 'required' });
    }
  });

  it('offers it when there is no install ID (as before the rollout)', () => {
    expect(
      decideHiveUpdateOffer({
        currentVersion: '1.4.27',
        manifest: release({
          min_supported_version: '1.4.27',
          rollout_percent: 0,
        }),
        installId: null,
      })
    ).toEqual({ offer: true, reason: 'no-install-id', rolloutPercent: 0 });
  });

  it('offers it to a build without a release version (as before)', () => {
    expect(
      decideHiveUpdateOffer({
        currentVersion: '',
        manifest: release({
          min_supported_version: '1.4.27',
          rollout_percent: 0,
        }),
        installId: ID_A,
      }).offer
    ).toBe(true);
  });
});

describe('install ID', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-rollout-'));
    resetHiveInstallIdForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    resetHiveInstallIdForTests();
    jest.restoreAllMocks();
  });

  it('is made once, saved, and read back the same', () => {
    const first = readOrCreateHiveInstallId(directory);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    const file = path.join(directory, HIVE_INSTALL_ID_FILE_NAME);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${first}\n`);
    expect(readOrCreateHiveInstallId(directory)).toBe(first);
    expect(fs.readdirSync(directory)).toEqual([HIVE_INSTALL_ID_FILE_NAME]);
  });

  it('is readable by this user only (0600; not checked on Windows)', () => {
    readOrCreateHiveInstallId(directory);
    const file = path.join(directory, HIVE_INSTALL_ID_FILE_NAME);
    // eslint-disable-next-line no-bitwise
    const mode = fs.statSync(file).mode & 0o777;
    expect(process.platform === 'win32' || mode === 0o600).toBe(true);
  });

  it('is random per install', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-rollout-'));
    try {
      expect(readOrCreateHiveInstallId(directory)).not.toBe(
        readOrCreateHiveInstallId(other)
      );
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('replaces a damaged file with a new ID', () => {
    const file = path.join(directory, HIVE_INSTALL_ID_FILE_NAME);
    fs.writeFileSync(file, 'not an id\n');
    const id = readOrCreateHiveInstallId(directory);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${id}\n`);
  });

  it('is null when it cannot be saved', () => {
    const blocker = path.join(directory, 'a-file');
    fs.writeFileSync(blocker, 'x');
    expect(readOrCreateHiveInstallId(path.join(blocker, 'below'))).toBeNull();
  });

  it('lives in the user-data folder and is cached', () => {
    const getPath = jest.fn(() => directory);
    const original = app.getPath;
    (app as unknown as { getPath: typeof getPath }).getPath = getPath;
    try {
      const id = getHiveInstallId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(getHiveInstallId()).toBe(id);
      expect(getPath).toHaveBeenCalledTimes(1);
      expect(getPath).toHaveBeenCalledWith('userData');
      expect(
        fs.readFileSync(path.join(directory, HIVE_INSTALL_ID_FILE_NAME), 'utf8')
      ).toBe(`${id}\n`);
    } finally {
      (app as unknown as { getPath: typeof original }).getPath = original;
    }
  });

  it('never leaves the PC: the module has no network or IPC code', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'hiveRollout.ts'),
      'utf8'
    );
    expect(source).not.toMatch(
      /axios|fetch\(|https?\.request|ipcMain|webContents|sendEvent|console\.log/
    );
  });
});
