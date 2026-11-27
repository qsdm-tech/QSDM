/**
 * @jest-environment node
 */
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';

import {
  detectQsdmNvidiaGPU,
  getQsdmMinerEnrollmentStatus,
  isQsdmNoNvidiaGpuPc,
  isQsdmNoNvidiaGpuProbeResult,
  QSDM_NO_NVIDIA_GPU_MESSAGE,
} from './qsdmMinerEnrollment';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

jest.mock('main/services/qsdmTaskActionSigner', () => ({
  getQsdmTaskActionCliPath: jest.fn(),
  getQsdmTaskActionKeystorePath: jest.fn(),
  getQsdmTaskActionPassphraseFile: jest.fn(),
  getQsdmTaskActionSender: () => 'a'.repeat(64),
}));

type ExecCallback = (
  error: (Error & { code?: unknown }) | null,
  stdout: string,
  stderr: string
) => void;

const nvidiaSmi = (
  error: (Error & { code?: unknown }) | null,
  stdout = '',
  stderr = ''
) =>
  (execFile as unknown as jest.Mock).mockImplementation(
    (_command: string, _args: string[], _options: object, callback) =>
      (callback as ExecCallback)(error, stdout, stderr)
  );

const failure = (message: string, code: unknown) =>
  Object.assign(new Error(message), { code });

describe('a PC without an NVIDIA GPU', () => {
  const previousConfig = process.env.QSDM_MINER_CONFIG;

  beforeAll(() => {
    process.env.QSDM_MINER_CONFIG = path.join(
      os.tmpdir(),
      'qsdm-no-gpu-missing',
      'miner.toml'
    );
  });

  afterAll(() => {
    if (previousConfig === undefined) delete process.env.QSDM_MINER_CONFIG;
    else process.env.QSDM_MINER_CONFIG = previousConfig;
  });

  it('tells no NVIDIA GPU apart from a driver problem', () => {
    expect(isQsdmNoNvidiaGpuProbeResult({ code: 'ENOENT' }, '')).toBe(true);
    expect(
      isQsdmNoNvidiaGpuProbeResult({ code: 6 }, 'No devices were found\n')
    ).toBe(true);
    expect(isQsdmNoNvidiaGpuProbeResult(null, ' \n')).toBe(true);
    expect(
      isQsdmNoNvidiaGpuProbeResult(
        { code: 9 },
        "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."
      )
    ).toBe(false);
    expect(
      isQsdmNoNvidiaGpuProbeResult(
        null,
        'GPU-1, NVIDIA GeForce RTX 3050, 8.6, 572.16'
      )
    ).toBe(false);
  });

  it('says so plainly when nvidia-smi is missing', async () => {
    nvidiaSmi(failure('spawn nvidia-smi ENOENT', 'ENOENT'));

    await expect(detectQsdmNvidiaGPU()).rejects.toThrow(
      QSDM_NO_NVIDIA_GPU_MESSAGE
    );
    await expect(isQsdmNoNvidiaGpuPc()).resolves.toBe(true);

    const status = await getQsdmMinerEnrollmentStatus();
    expect(status).toMatchObject({
      eligible: false,
      ready: false,
      noNvidiaGpu: true,
      error: QSDM_NO_NVIDIA_GPU_MESSAGE,
    });
  });

  it('says so when nvidia-smi finds no device', async () => {
    nvidiaSmi(failure('Command failed', 6), 'No devices were found\n');

    await expect(isQsdmNoNvidiaGpuPc()).resolves.toBe(true);
  });

  it('keeps the driver message when nvidia-smi fails', async () => {
    nvidiaSmi(
      failure('Command failed', 9),
      "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."
    );

    await expect(isQsdmNoNvidiaGpuPc()).resolves.toBe(false);
    await expect(detectQsdmNvidiaGPU()).rejects.toThrow(
      'NVIDIA GPU detection failed.'
    );
    const status = await getQsdmMinerEnrollmentStatus();
    expect(status.noNvidiaGpu).toBe(false);
  });
});
