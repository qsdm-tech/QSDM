import { IpcRendererEvent, ipcRenderer } from 'electron';

import { RendererEndpoints } from 'config/endpoints';

/** The active QSDM wallet changed (a switch); payload.address is the new active wallet. Returns the unsubscribe. */
export default function onQsdmWalletChanged(
  callback: (event: IpcRendererEvent, payload: { address?: string }) => void
) {
  ipcRenderer.on(RendererEndpoints.QSDM_WALLET_CHANGED, callback);
  return () => {
    ipcRenderer.removeListener(RendererEndpoints.QSDM_WALLET_CHANGED, callback);
  };
}
