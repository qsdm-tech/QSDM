// cspell:words qsdmminer
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  escapeQsdmMinerTomlString,
  normalizeQsdmMinerConfigLineEndings,
  setQsdmMinerConfigStringValue,
  writeQsdmMinerConfigFile,
} from './qsdmMinerConfigFile';

// Shaped like an owner's miner.toml written by an older Hive: 11 lone CRs
// (the line ends before the keys that Hive had replaced) and 5 CRLFs.
const damagedLines: Array<[string, '\r' | '\r\n']> = [
  ['# QSDM console miner config', '\r\n'],
  ['# Edit by hand or re-run `qsdmminer-console --setup` to replace.', '\r'],
  ['validator_url = "https://api.qsdm.tech"', '\r'],
  [`reward_address = "${'a'.repeat(64)}"`, '\r\n'],
  ['batch_count = 0', '\r\n'],
  ['poll_interval = ""', '\r\n'],
  ['plain = false', '\r'],
  ['protocol = "v2"', '\r'],
  ['node_id = "hive-pc-0123456789ab"', '\r'],
  ['gpu_uuid = "GPU-0123"', '\r'],
  ['gpu_name = "NVIDIA GeForce RTX 3050"', '\r'],
  ['gpu_arch = "ampere"', '\r'],
  ['compute_cap = "8.6"', '\r'],
  ['cuda_version = "12.8"', '\r'],
  ['driver_ver = "572.16"', '\r'],
  ['hmac_key_path = "C:\\\\Users\\\\pc\\\\.qsdm\\\\miner-hmac.key"', '\r\n'],
];
const damaged = damagedLines.map(([line, end]) => `${line}${end}`).join('');
const repaired = damagedLines.map(([line]) => `${line}\n`).join('');

describe('miner.toml line endings', () => {
  it('turns CRLF and lone CR into LF', () => {
    expect(damaged.match(/\r(?!\n)/g)).toHaveLength(11);
    expect(damaged.match(/\r\n/g)).toHaveLength(5);
    expect(normalizeQsdmMinerConfigLineEndings(damaged)).toBe(repaired);
    expect(normalizeQsdmMinerConfigLineEndings('a\r\r\nb\n')).toBe('a\n\nb\n');
  });

  it('rewrites a file with CRs with LF only and keeps every other line', () => {
    const signer = 'b'.repeat(64);
    const updated = setQsdmMinerConfigStringValue(
      damaged,
      'reward_address',
      signer
    );

    expect(updated).not.toContain('\r');
    expect(updated).toBe(
      repaired.replace(
        `reward_address = "${'a'.repeat(64)}"`,
        `reward_address = "${signer}"`
      )
    );
    // Same value: the text still changes, so callers rewrite the file.
    expect(setQsdmMinerConfigStringValue(damaged, 'protocol', 'v2')).toBe(
      repaired
    );
    expect(setQsdmMinerConfigStringValue(repaired, 'protocol', 'v2')).toBe(
      repaired
    );
  });

  it('replaces a key on its own line only', () => {
    const config = 'a = 1\n\n  node_id = "old" # kept\nnode_idx = "x"\n';

    expect(setQsdmMinerConfigStringValue(config, 'node_id', 'new')).toBe(
      'a = 1\n\nnode_id = "new" # kept\nnode_idx = "x"\n'
    );
    expect(setQsdmMinerConfigStringValue('a = 1', 'b', 'x')).toBe(
      'a = 1\nb = "x"\n'
    );
    expect(setQsdmMinerConfigStringValue('', 'b', 'x')).toBe('b = "x"\n');
  });

  it('writes values literally and never as a raw line break', () => {
    expect(escapeQsdmMinerTomlString('C:\\q "x"')).toBe('C:\\\\q \\"x\\"');
    expect(
      setQsdmMinerConfigStringValue('gpu_name = "x"\n', 'gpu_name', 'a$&b\r\n')
    ).toBe('gpu_name = "a$&b\\u000d\\u000a"\n');
  });

  it('writes the file with LF line endings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsdm-miner-toml-'));
    try {
      const configPath = path.join(dir, 'miner.toml');
      writeQsdmMinerConfigFile(configPath, damaged);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(repaired);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
