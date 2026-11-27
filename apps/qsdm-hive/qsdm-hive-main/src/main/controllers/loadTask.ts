import { Event } from 'electron';
import * as fsSync from 'fs';
import path from 'path';

import { SystemDbKeys } from 'config/systemDbKeys';
import db from 'main/db';
import { getTaskExecutablePath } from 'main/node/helpers/taskPaths';

import { getTaskSource } from './getTaskSource';

async function saveTaskAuditProgramIdToTaskIdMap(
  taskId: string,
  taskAuditProgram: string
) {
  let currentMap: Record<string, string>;

  try {
    const currentMapString = await db.get(
      SystemDbKeys.TaskIdToAuditProgramIdMap
    );
    currentMap = JSON.parse(currentMapString as string) as Record<
      string,
      string
    >;
  } catch (error) {
    currentMap = {};
  }

  currentMap[taskAuditProgram] = taskId;

  await db.put(
    SystemDbKeys.TaskIdToAuditProgramIdMap,
    JSON.stringify(currentMap)
  );
}

const readFileIfPresent = (filePath: string): string | null => {
  try {
    return fsSync.readFileSync(filePath, 'utf8');
  } catch (error) {
    return null;
  }
};

/**
 * Writes the runner Hive starts for a task, <app data>/executables/<task
 * program id>.js. The runner is rebuilt from the QSDM task catalog on every
 * start, so a file left in that folder (for example code an older Hive
 * downloaded) never runs. The file is written only when its content changes:
 * the executable monitor restarts tasks whose runner changed.
 */
export async function loadTask({
  taskAuditProgram,
  taskId,
}: {
  taskAuditProgram: string;
  taskId: string;
}) {
  const sourceCodePath = getTaskExecutablePath(taskAuditProgram);
  const sourceCode: string = await getTaskSource({} as Event, {
    taskAuditProgram,
  });
  /**
   * @dev save record in task_id -> taskAuditProgram map in db
   * it will be used for tracking the task and its executable
   */
  await saveTaskAuditProgramIdToTaskIdMap(taskId, taskAuditProgram);
  if (readFileIfPresent(sourceCodePath) !== sourceCode) {
    fsSync.mkdirSync(path.dirname(sourceCodePath), { recursive: true });
    fsSync.writeFileSync(sourceCodePath, sourceCode);
  }
}
