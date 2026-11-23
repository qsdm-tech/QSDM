/**
 * @jest-environment node
 */
// cspell:ignore bafybeiabhpqrknrzz otptaw lubz kruk

import fs from 'fs';
import os from 'os';
import path from 'path';

import { getTaskSource } from './getTaskSource';
import { loadTask } from './loadTask';

const mockState = { appDataPath: '' };
const mockDbValues = new Map<string, string>();

jest.mock('main/node/helpers/getAppDataPath', () => ({
  getAppDataPath: () => mockState.appDataPath,
}));

jest.mock('main/db', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (key: string) => mockDbValues.get(key)),
    put: jest.fn(async (key: string, value: string) => {
      mockDbValues.set(key, value);
    }),
  },
}));

jest.mock('./getTaskSource', () => ({
  getTaskSource: jest.fn(),
}));

const mockedGetTaskSource = getTaskSource as jest.Mock;
const CID = 'bafybeiabhpqrknrzz5fka2otptaw7lubz7awh5f7n2kruk52akq4jr5dh4';
const NATIVE_RUNNER = "const http = require('http'); // built-in runner";

describe('loadTask', () => {
  beforeEach(() => {
    mockState.appDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qsdm-hive-load-task-')
    );
    mockDbValues.clear();
    mockedGetTaskSource.mockReset();
  });

  afterEach(() => {
    fs.rmSync(mockState.appDataPath, { recursive: true, force: true });
  });

  const executablePath = (name: string) =>
    path.join(mockState.appDataPath, 'executables', `${name}.js`);

  it('writes the built-in runner for a catalog task', async () => {
    mockedGetTaskSource.mockResolvedValue(NATIVE_RUNNER);

    await loadTask({ taskAuditProgram: CID, taskId: 'task-1' });

    expect(mockedGetTaskSource).toHaveBeenCalledWith(
      {},
      { taskAuditProgram: CID }
    );
    expect(fs.readFileSync(executablePath(CID), 'utf8')).toBe(NATIVE_RUNNER);
    expect(JSON.parse(mockDbValues.values().next().value as string)).toEqual({
      [CID]: 'task-1',
    });
  });

  it('replaces a file already in the executables folder', async () => {
    fs.mkdirSync(path.join(mockState.appDataPath, 'executables'));
    fs.writeFileSync(executablePath(CID), 'downloaded task code');
    mockedGetTaskSource.mockResolvedValue(NATIVE_RUNNER);

    await loadTask({ taskAuditProgram: CID, taskId: 'task-1' });

    expect(mockedGetTaskSource).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(executablePath(CID), 'utf8')).toBe(NATIVE_RUNNER);
  });

  it('leaves an unchanged runner untouched', async () => {
    fs.mkdirSync(path.join(mockState.appDataPath, 'executables'));
    fs.writeFileSync(executablePath(CID), NATIVE_RUNNER);
    const writeFileSync = jest.spyOn(fs, 'writeFileSync');
    mockedGetTaskSource.mockResolvedValue(NATIVE_RUNNER);

    try {
      await loadTask({ taskAuditProgram: CID, taskId: 'task-1' });
      expect(writeFileSync).not.toHaveBeenCalled();
    } finally {
      writeFileSync.mockRestore();
    }
    expect(fs.readFileSync(executablePath(CID), 'utf8')).toBe(NATIVE_RUNNER);
  });

  it('fails when the catalog refuses the task, writing nothing', async () => {
    mockedGetTaskSource.mockRejectedValue(
      new Error('This task is not in the QSDM catalog.')
    );

    await expect(
      loadTask({ taskAuditProgram: CID, taskId: 'task-1' })
    ).rejects.toThrow('This task is not in the QSDM catalog.');
    expect(fs.existsSync(executablePath(CID))).toBe(false);
  });

  it.each(['../../evil', '..', 'a/b', 'a\\b', 'C:evil'])(
    'refuses the task program id %p before reading the catalog',
    async (taskAuditProgram) => {
      mockedGetTaskSource.mockResolvedValue(NATIVE_RUNNER);

      await expect(
        loadTask({ taskAuditProgram, taskId: 'task-1' })
      ).rejects.toThrow('Refusing an unsafe task program id.');
      expect(mockedGetTaskSource).not.toHaveBeenCalled();
      expect(fs.readdirSync(mockState.appDataPath)).toEqual([]);
    }
  );
});
