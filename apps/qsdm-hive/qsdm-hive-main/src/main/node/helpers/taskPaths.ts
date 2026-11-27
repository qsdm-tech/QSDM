import path from 'path';

import { getAppDataPath } from './getAppDataPath';

// Task ids, task program ids and task metadata ids come from the QSDM API (or
// from a custom core API the user points Hive at). Hive uses them as file and
// folder names under its data folder, so each one must be a single plain name:
// letters, digits, ".", "_" and "-", at most 128 characters, no "..", no path
// separator, no ":" (a drive letter or an alternate data stream on Windows) and
// no Windows device name such as CON or NUL.
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

export const isSafeTaskId = (id: unknown): id is string =>
  typeof id === 'string' &&
  SAFE_TASK_ID.test(id) &&
  !id.includes('..') &&
  !WINDOWS_DEVICE_NAME.test(id);

export const assertSafeTaskId = (id: unknown, what = 'task id'): string => {
  if (!isSafeTaskId(id)) {
    throw new Error(`Refusing an unsafe ${what}.`);
  }
  return id;
};

// Resolves name inside root, and refuses any result outside root (or root
// itself).
export const childPath = (root: string, name: string): string => {
  const base = path.resolve(root);
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  const full = path.resolve(base, name);
  if (!full.startsWith(prefix)) {
    throw new Error('Refusing a path outside the Hive data folder.');
  }
  return full;
};

// <app data>/namespace/<task id>: the task's log and cache folder.
export const getTaskNamespacePath = (taskId: string): string =>
  childPath(path.join(getAppDataPath(), 'namespace'), assertSafeTaskId(taskId));

// <app data>/executables/<task program id>.js: the task runner Hive starts.
export const getTaskExecutablePath = (taskAuditProgram: string): string =>
  childPath(
    path.join(getAppDataPath(), 'executables'),
    `${assertSafeTaskId(taskAuditProgram, 'task program id')}.js`
  );
