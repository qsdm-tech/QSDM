// The verified Hive update that is downloaded and installs on restart.
// AppUpdater sets it; the version policy reports it to the renderer, which
// then shows the "Restart to update" banner. A module of its own, so that the
// policy does not import the updater (the updater imports the policy).
let downloadedVersion: string | null = null;

export const setDownloadedHiveUpdate = (version: string | null) => {
  downloadedVersion = version;
};

export const getDownloadedHiveUpdate = () => downloadedVersion;
