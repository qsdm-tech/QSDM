/**
 * @jest-environment node
 */
// cspell:ignore bafybeiabhpqrknrzz otptaw lubz kruk tâche

import os from 'os';
import path from 'path';

import {
  QSDM_EDGE_WORKER_GPU_SYSTEM_TASK_METADATA_ID,
  QSDM_EDGE_WORKER_RAM_SYSTEM_TASK_METADATA_ID,
  QSDM_EDGE_WORKER_SYSTEM_TASK_METADATA_ID,
  QSDM_HIVE_INTERNAL_TASK_IDS,
  QSDM_MINER_SYSTEM_TASK_METADATA_ID,
  QSDM_MOTHER_HIVE_SYSTEM_TASK_METADATA_ID,
  QSDM_POOL_MINER_SYSTEM_TASK_METADATA_ID,
  QSDM_SKYFANG_LINK_SYSTEM_TASK_METADATA_ID,
  QSDM_SYSTEM_TASK_IDS,
} from 'config/qsdmSystemTasks';

import {
  assertSafeTaskId,
  childPath,
  getTaskExecutablePath,
  getTaskNamespacePath,
  isSafeTaskId,
} from './taskPaths';

const mockAppDataPath = path.join(os.tmpdir(), 'qsdm-hive-task-paths');

jest.mock('./getAppDataPath', () => ({
  getAppDataPath: () => mockAppDataPath,
}));

const UNSAFE_IDS: unknown[] = [
  '../x',
  '..',
  '.',
  '',
  'a/b',
  '/etc/passwd',
  'a\\b',
  '..\\..\\x',
  'C:x',
  'C:\\Windows',
  'task:stream',
  'a..b',
  '.hidden',
  '-flag',
  'task id',
  'tâche',
  'x'.repeat(129),
  'CON',
  'nul',
  'nul.js',
  'Lpt1',
  'com9.txt',
  undefined,
  null,
  42,
];

const SAFE_IDS = [
  ...QSDM_SYSTEM_TASK_IDS,
  ...QSDM_HIVE_INTERNAL_TASK_IDS,
  QSDM_MINER_SYSTEM_TASK_METADATA_ID,
  QSDM_POOL_MINER_SYSTEM_TASK_METADATA_ID,
  QSDM_EDGE_WORKER_SYSTEM_TASK_METADATA_ID,
  QSDM_EDGE_WORKER_GPU_SYSTEM_TASK_METADATA_ID,
  QSDM_EDGE_WORKER_RAM_SYSTEM_TASK_METADATA_ID,
  QSDM_MOTHER_HIVE_SYSTEM_TASK_METADATA_ID,
  QSDM_SKYFANG_LINK_SYSTEM_TASK_METADATA_ID,
  // CIDv1, a canonical hex task id, a legacy base58 task key, catalog ids
  'bafybeiabhpqrknrzz5fka2otptaw7lubz7awh5f7n2kruk52akq4jr5dh4',
  'a3f1c0de9b8e7d6c5b4a39281706f5e4d3c2b1a0918273645546372819a0b1c2',
  'Attention22222222222222222222222222222222222',
  'community.task-1_v2',
  'console',
  'x'.repeat(128),
];

describe('taskPaths', () => {
  it.each(UNSAFE_IDS.map((id) => [id]))('refuses the task id %p', (id) => {
    expect(isSafeTaskId(id)).toBe(false);
    expect(() => assertSafeTaskId(id)).toThrow('Refusing an unsafe task id.');
  });

  it.each(SAFE_IDS.map((id) => [id]))('accepts the task id %p', (id) => {
    expect(isSafeTaskId(id)).toBe(true);
    expect(assertSafeTaskId(id)).toBe(id);
  });

  it('names what it refused', () => {
    expect(() => assertSafeTaskId('../x', 'task program id')).toThrow(
      'Refusing an unsafe task program id.'
    );
  });

  it('keeps child paths inside their folder', () => {
    const root = path.join(mockAppDataPath, 'namespace');
    expect(childPath(root, 'abc')).toBe(path.join(root, 'abc'));
    expect(() => childPath(root, '..')).toThrow(
      'Refusing a path outside the Hive data folder.'
    );
    expect(() => childPath(root, '../wallets')).toThrow(
      'Refusing a path outside the Hive data folder.'
    );
    expect(() => childPath(root, path.resolve('/tmp/elsewhere'))).toThrow(
      'Refusing a path outside the Hive data folder.'
    );
    expect(() => childPath(root, '')).toThrow(
      'Refusing a path outside the Hive data folder.'
    );
    // a sibling folder whose name starts with the folder's name
    expect(() => childPath(root, '../namespace-other/abc')).toThrow(
      'Refusing a path outside the Hive data folder.'
    );
  });

  it('builds the namespace folder and the executable inside the Hive data folder', () => {
    expect(getTaskNamespacePath('qsdm-system-miner')).toBe(
      path.join(mockAppDataPath, 'namespace', 'qsdm-system-miner')
    );
    expect(
      getTaskExecutablePath(
        'bafybeiabhpqrknrzz5fka2otptaw7lubz7awh5f7n2kruk52akq4jr5dh4'
      )
    ).toBe(
      path.join(
        mockAppDataPath,
        'executables',
        'bafybeiabhpqrknrzz5fka2otptaw7lubz7awh5f7n2kruk52akq4jr5dh4.js'
      )
    );
    expect(() => getTaskNamespacePath('../wallets')).toThrow(
      'Refusing an unsafe task id.'
    );
    expect(() => getTaskExecutablePath('../../evil')).toThrow(
      'Refusing an unsafe task program id.'
    );
  });
});
