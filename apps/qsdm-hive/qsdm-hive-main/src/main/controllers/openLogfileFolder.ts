import { shell } from 'electron';

import {
  getTaskNamespacePath,
  isSafeTaskId,
} from 'main/node/helpers/taskPaths';
import { OpenLogfileFolderParams } from 'models';

const FAILED_TO_OPEN = 'Failed to open path';

export const openLogfileFolder = async (
  event: Event,
  payload: OpenLogfileFolderParams
): Promise<boolean> => {
  try {
    const { taskAccountPublicKey } = payload;
    // shell.openPath opens files with their default program: only ever a
    // task's own log folder.
    if (!isSafeTaskId(taskAccountPublicKey)) return false;

    const logfilePath = getTaskNamespacePath(taskAccountPublicKey);
    const result = await shell.openPath(logfilePath);

    if (result === FAILED_TO_OPEN) return false;
    return true;
  } catch (e: any) {
    console.error(e);
    return false;
  }
};
