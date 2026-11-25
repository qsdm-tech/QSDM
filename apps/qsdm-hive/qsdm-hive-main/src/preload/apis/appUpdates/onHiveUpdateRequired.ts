import { IpcRendererEvent, ipcRenderer } from 'electron';

import { RendererEndpoints } from 'config/endpoints';

// The version policy refused an action; the renderer offers "Restart to
// update".
export default function onHiveUpdateRequired(
  callback: (event: IpcRendererEvent, ...args: unknown[]) => void
) {
  ipcRenderer.on(RendererEndpoints.HIVE_UPDATE_REQUIRED, callback);
  return () =>
    ipcRenderer.removeListener(
      RendererEndpoints.HIVE_UPDATE_REQUIRED,
      callback
    );
}
