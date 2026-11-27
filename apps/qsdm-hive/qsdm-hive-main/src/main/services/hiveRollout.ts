import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { app } from '../app';

/**
 * Staged rollout of a signed Hive release (Hive 1.4.28+).
 *
 * The signed release manifest may carry `rollout_percent` (a whole number
 * from 0 to 100). The ML-DSA-87 signature covers the exact manifest bytes, so
 * the field is signed like every other. Each Hive keeps a random install ID in
 * its user-data folder. It is made on this PC, never sent anywhere and never
 * logged. From it and the release version, Hive computes a bucket from 0 to 99
 * and offers the update on its own only when the bucket is below the
 * percentage. Raising the percentage for the same version keeps every Hive
 * that was already in; a new version gives each Hive a new bucket.
 *
 * Without the field, every Hive is offered the update, as before. A Hive that
 * the release no longer supports (below `min_supported_version`, or any other
 * version when the manifest has no `min_supported_version`) must update, so
 * the rollout never holds it back. A check the user asks for is not held back
 * either.
 */

export const HIVE_INSTALL_ID_FILE_NAME = 'rollout-install-id';
const INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const BUCKET_DOMAIN = 'qsdm-hive-rollout-v1';

export type HiveRolloutManifest = {
  version: string;
  min_supported_version?: unknown;
  rollout_percent?: unknown;
};

export type HiveUpdateOfferReason =
  // This Hive is the release version or newer: nothing to offer.
  | 'up-to-date'
  // This Hive is below the supported minimum (or the release has none): it
  // must update, whatever the rollout says.
  | 'required'
  // The release has no (valid) rollout_percent: offered to every Hive.
  | 'no-rollout'
  // No install ID could be read or saved: offered, as before the rollout.
  | 'no-install-id'
  | 'in-rollout'
  | 'outside-rollout';

export type HiveUpdateOffer = {
  offer: boolean;
  reason: HiveUpdateOfferReason;
  rolloutPercent?: number;
};

let cachedInstallId: string | null | undefined;

export function resetHiveInstallIdForTests() {
  cachedInstallId = undefined;
}

// -1, 0 or 1 for MAJOR.MINOR.PATCH versions; null when either is not one.
function compareVersions(left: unknown, right: unknown): -1 | 0 | 1 | null {
  if (
    typeof left !== 'string' ||
    typeof right !== 'string' ||
    !VERSION_PATTERN.test(left) ||
    !VERSION_PATTERN.test(right)
  ) {
    return null;
  }
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

/** The signed rollout_percent when it is a whole number from 0 to 100. */
export function getQsdmHiveRolloutPercent(
  manifest: Pick<HiveRolloutManifest, 'rollout_percent'>
): number | undefined {
  const value = manifest.rollout_percent;
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 100
  ) {
    console.warn('Ignoring an invalid rollout_percent in the release.');
    return undefined;
  }
  return value;
}

/** A stable bucket from 0 to 99 for this install and this release version. */
export function getHiveRolloutBucket(installId: string, version: string) {
  const digest = crypto
    .createHash('sha256')
    .update(`${BUCKET_DOMAIN}\n${version}\n${installId}`, 'utf8')
    .digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * Reads the install ID from `directory`, or makes and saves a new random one.
 * Returns null when it can be neither read nor saved.
 */
export function readOrCreateHiveInstallId(directory: string): string | null {
  const file = path.join(directory, HIVE_INSTALL_ID_FILE_NAME);
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (INSTALL_ID_PATTERN.test(saved)) return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('QSDM Hive could not read its rollout install ID.');
      return null;
    }
  }
  const installId = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${installId}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return installId;
  } catch {
    console.warn('QSDM Hive could not save its rollout install ID.');
    return null;
  }
}

/** This Hive's install ID, from <userData>/rollout-install-id. */
export function getHiveInstallId(): string | null {
  if (cachedInstallId !== undefined) return cachedInstallId;
  let directory = '';
  try {
    directory = app.getPath?.('userData') || '';
  } catch {
    directory = '';
  }
  cachedInstallId = directory ? readOrCreateHiveInstallId(directory) : null;
  return cachedInstallId;
}

/** Whether this Hive should download `manifest`'s release on its own now. */
export function decideHiveUpdateOffer({
  currentVersion,
  manifest,
  installId,
}: {
  currentVersion: string;
  manifest: HiveRolloutManifest;
  // The install ID, or a function that gives it: then it is read (or made)
  // only when the release has a rollout_percent.
  installId: string | null | (() => string | null);
}): HiveUpdateOffer {
  const toLatest = compareVersions(currentVersion, manifest.version);
  if (toLatest !== null && toLatest >= 0) {
    return { offer: false, reason: 'up-to-date' };
  }

  // The same rule as the version policy: a valid minimum not above the
  // release; without one, only the release version itself is supported.
  const minimum = manifest.min_supported_version;
  const minimumValid =
    compareVersions(minimum, manifest.version) !== null &&
    (compareVersions(minimum, manifest.version) as number) <= 0;
  if (
    toLatest === null ||
    !minimumValid ||
    (compareVersions(currentVersion, minimum) as number) < 0
  ) {
    return { offer: true, reason: 'required' };
  }

  const rolloutPercent = getQsdmHiveRolloutPercent(manifest);
  if (rolloutPercent === undefined) {
    return { offer: true, reason: 'no-rollout' };
  }
  const id = typeof installId === 'function' ? installId() : installId;
  if (!id) {
    return { offer: true, reason: 'no-install-id', rolloutPercent };
  }
  const inside = getHiveRolloutBucket(id, manifest.version) < rolloutPercent;
  return {
    offer: inside,
    reason: inside ? 'in-rollout' : 'outside-rollout',
    rolloutPercent,
  };
}
