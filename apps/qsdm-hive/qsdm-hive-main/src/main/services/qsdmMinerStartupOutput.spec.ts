/**
 * @jest-environment node
 */
// cspell:words qsdmminer
import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildProcessStartupExitDetail,
  createQsdmProcessOutputTail,
  readQsdmFileState,
  waitForChildProcessStartup,
} from './qsdmSystemTasks';

// The error a miner bundled since Hive 1.4.24 printed for a miner.toml with
// lone CRs. It reached only stderr (and task.log), never miner.log.
const tomlError =
  "load config: decode C:\\Users\\pc\\.qsdm\\miner.toml: toml: line 1: TOML files cannot contain control characters: '0x0d'";

describe('miner startup errors show the output of this start', () => {
  let directory = '';
  let logPath = '';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qsdm-hive-start-'));
    logPath = path.join(directory, 'miner.log');
    fs.writeFileSync(
      logPath,
      'qsdmminer service starting at 2026-11-01T00:00:00Z\nan older run: accepted proof\n'
    );
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('shows stderr instead of a miner.log this start never wrote', () => {
    const stderr = createQsdmProcessOutputTail();
    stderr.push(`${tomlError}\npassphrase=hunter2-do-not-display`);

    const detail = buildProcessStartupExitDetail(
      'QSDM Miner',
      1,
      null,
      logPath,
      { stderr: stderr.text(), logBefore: readQsdmFileState(logPath) }
    );

    expect(detail).toContain(`Miner error output:\n${tomlError}`);
    expect(detail).toContain('passphrase=[redacted]');
    expect(detail).not.toContain('do-not-display');
    expect(detail).not.toContain('an older run');
    expect(detail).not.toContain('Miner log tail');
  });

  it('shows only the miner.log lines this start added', () => {
    const logBefore = readQsdmFileState(logPath);
    fs.appendFileSync(
      logPath,
      'qsdmminer service starting at 2026-11-22T00:00:00Z\nCUDA proof solver required: no device\n'
    );

    const detail = buildProcessStartupExitDetail(
      'QSDM Miner',
      1,
      null,
      logPath,
      { stderr: '', logBefore }
    );

    expect(detail).toContain(
      'Miner log tail:\nqsdmminer service starting at 2026-11-22T00:00:00Z\nCUDA proof solver required: no device'
    );
    expect(detail).not.toContain('an older run');
    expect(detail).not.toContain('Miner error output');
  });

  it('waits for stderr that arrives after the exit event', async () => {
    const stderr = createQsdmProcessOutputTail();
    const child = new EventEmitter() as ChildProcess;
    const startup = waitForChildProcessStartup(child, 'QSDM Miner', logPath, {
      stderr: stderr.text,
      logBefore: readQsdmFileState(logPath),
    });

    child.emit('exit', 1, null);
    stderr.push(tomlError);
    child.emit('close', 1, null);

    await expect(startup).rejects.toThrow(
      `QSDM Miner exited during startup with code 1 and signal null. Log: ${logPath}.\nMiner error output:\n${tomlError}`
    );
  });

  it('keeps only the newest stderr lines', () => {
    const stderr = createQsdmProcessOutputTail();
    for (let line = 1; line <= 20; line += 1) stderr.push(`line ${line}`);

    expect(stderr.text().split('\n')).toEqual(
      Array.from({ length: 12 }, (_, index) => `line ${index + 9}`)
    );
  });
});
