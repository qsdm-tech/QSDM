import fs from 'fs';

// Every place Hive rewrites miner.toml goes through these helpers, so the file
// always has LF line endings. TOML allows a CR only as part of CRLF, and the
// miner bundled since Hive 1.4.24 (BurntSushi/toml v1.6.0) refuses to start on
// a lone CR ("TOML files cannot contain control characters: '0x0d'").
//
// Older Hive builds replaced a key with a multi-line regex whose ^ also
// matched between the CR and the LF of a CRLF line end. Its \s* then took the
// LF, so every replaced key left a lone CR on the line before it.

export const normalizeQsdmMinerConfigLineEndings = (config: string) =>
  config.replace(/\r\n?/g, '\n');

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A TOML basic string. Control characters (a CR or LF in a value included)
// are written as \uXXXX escapes, so no value can put a raw line break into
// the file.
export const escapeQsdmMinerTomlString = (value: string) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, (character) => {
      const code = character.charCodeAt(0).toString(16).padStart(4, '0');
      return `\\u${code}`;
    });

// Sets one top-level `key = "value"` line, or appends it. The result has LF
// line endings only. The match stays on one line: [ \t] instead of \s.
export const setQsdmMinerConfigStringValue = (
  config: string,
  key: string,
  value: string
) => {
  const normalized = normalizeQsdmMinerConfigLineEndings(config);
  const line = `${key} = "${escapeQsdmMinerTomlString(value)}"`;
  const matcher = new RegExp(
    `^[ \\t]*${escapeRegExp(
      key
    )}[ \\t]*=[ \\t]*(?:"[^"\\n]*"|'[^'\\n]*'|[^#\\n]*)`,
    'm'
  );
  if (matcher.test(normalized)) return normalized.replace(matcher, () => line);
  const separator =
    normalized.trim().length > 0 && !normalized.endsWith('\n') ? '\n' : '';
  return `${normalized}${separator}${line}\n`;
};

export const writeQsdmMinerConfigFile = (configPath: string, config: string) =>
  fs.writeFileSync(configPath, normalizeQsdmMinerConfigLineEndings(config), {
    encoding: 'utf8',
    mode: 0o600,
  });
