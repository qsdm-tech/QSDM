/**
 * @jest-environment node
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const mockState = { appDataPath: '' };

jest.mock('main/node/helpers/getAppDataPath', () => ({
  getAppDataPath: () => mockState.appDataPath,
}));

describe('tasks-cache-utils', () => {
  let workDir = '';

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsdm-hive-task-cache-'));
    mockState.appDataPath = path.join(workDir, 'appdata');
    fs.mkdirSync(mockState.appDataPath);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('keeps task cache files in the task folder', async () => {
    const { getTaskDataFromCache, updateTaskCacheRecord } = await import(
      './tasks-cache-utils'
    );

    await updateTaskCacheRecord('qsdm-hive-local-task', {
      task_name: 'Local task',
    });

    expect(
      fs.existsSync(
        path.join(
          mockState.appDataPath,
          'namespace',
          'qsdm-hive-local-task',
          'cache',
          'baseState.json'
        )
      )
    ).toBe(true);
    await expect(getTaskDataFromCache('qsdm-hive-local-task')).resolves.toEqual(
      { task_name: 'Local task' }
    );
  });

  it('refuses a task id that leaves the namespace folder', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { getTaskDataFromCache, updateTaskCacheRecord } = await import(
      './tasks-cache-utils'
    );

    await updateTaskCacheRecord('../../outside', { task_name: 'x' });
    await updateTaskCacheRecord('..', { task_name: 'x' }, 'stakeList');

    expect(fs.readdirSync(workDir)).toEqual(['appdata']);
    expect(fs.readdirSync(mockState.appDataPath)).toEqual([]);
    // the task id is an argument, never part of the format string
    expect(consoleError).toHaveBeenCalledWith(
      'Error caching task %s for task %s',
      'base state',
      '../../outside',
      expect.any(Error)
    );
    expect(consoleError).toHaveBeenCalledWith(
      'Error caching task %s for task %s',
      'stakeList',
      '..',
      expect.any(Error)
    );
    await expect(getTaskDataFromCache('../../outside')).resolves.toEqual({});
  });
});
