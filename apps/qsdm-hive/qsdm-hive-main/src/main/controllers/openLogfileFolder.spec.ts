/**
 * @jest-environment node
 */

import { shell } from 'electron';
import path from 'path';

import { openLogfileFolder } from './openLogfileFolder';

jest.mock('main/node/helpers/getAppDataPath', () => ({
  getAppDataPath: () => '/hive-data',
}));

describe('openLogfileFolder', () => {
  beforeEach(() => {
    (shell.openPath as jest.Mock).mockReset();
    (shell.openPath as jest.Mock).mockResolvedValue('');
  });

  it("opens a task's log folder", async () => {
    await expect(
      openLogfileFolder({} as Event, {
        taskAccountPublicKey: 'qsdm-edge-worker',
      })
    ).resolves.toBe(true);
    expect(shell.openPath).toHaveBeenCalledWith(
      path.resolve('/hive-data', 'namespace', 'qsdm-edge-worker')
    );
  });

  it.each([
    '../../Windows/System32/calc.exe',
    '..',
    'a/b',
    'C:\\Windows\\notepad.exe',
    undefined,
  ])('opens nothing for the task id %p', async (taskAccountPublicKey) => {
    await expect(
      openLogfileFolder({} as Event, {
        taskAccountPublicKey: taskAccountPublicKey as string,
      })
    ).resolves.toBe(false);
    expect(shell.openPath).not.toHaveBeenCalled();
  });
});
