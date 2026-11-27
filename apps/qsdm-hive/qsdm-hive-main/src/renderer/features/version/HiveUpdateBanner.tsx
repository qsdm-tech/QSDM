import React from 'react';

import { formatHiveVersion } from 'utils';

type Props = {
  version?: string;
  restarting: boolean;
  error?: string;
  onRestart: () => void;
};

// Shown over the app while a verified update waits for a restart. It stays
// until Hive restarts: mining keeps running in the meantime.
export function HiveUpdateBanner({
  version,
  restarting,
  error,
  onRestart,
}: Props): JSX.Element {
  const label = formatHiveVersion(version);
  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-3 border-b border-qsdm-teal/40 bg-qsdm-panel px-4 py-2 text-sm text-qsdm-text"
    >
      <span>
        {label
          ? `QSDM Hive ${label} is ready.`
          : 'A QSDM Hive update is ready.'}{' '}
        Mining keeps running until you restart.
      </span>
      <button
        type="button"
        className="rounded-lg border border-qsdm-teal/40 bg-qsdm-teal px-4 py-1 font-semibold text-qsdm-bg transition hover:brightness-105 disabled:opacity-60"
        disabled={restarting}
        onClick={onRestart}
      >
        {restarting ? 'Restarting...' : 'Restart to update'}
      </button>
      {error && <span className="text-[#ffb4b4]">{error}</span>}
    </div>
  );
}
