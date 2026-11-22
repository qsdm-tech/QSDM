/**
 * Switches of the ACTIVE QSDM wallet. Main-process caches of wallet data register here and drop what they hold for the
 * previous wallet; every window gets QSDM_WALLET_CHANGED and drops its wallet data too, so nothing of the previous
 * wallet is shown or used under the new one. Only the address is sent.
 */
import { RendererEndpoints } from 'config/endpoints';
import { sendEventAllWindows } from 'utils/sendEventAllWindows';

type ActiveWalletListener = (address: string) => void;

const listeners = new Set<ActiveWalletListener>();

export const onQsdmActiveWalletChanged = (listener: ActiveWalletListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const notifyQsdmActiveWalletChanged = (address: string) => {
  listeners.forEach((listener) => {
    try {
      listener(address);
    } catch (error) {
      console.warn(
        'A QSDM wallet cache could not be cleared after a wallet switch.',
        (error as Error)?.message
      );
    }
  });
  try {
    sendEventAllWindows(RendererEndpoints.QSDM_WALLET_CHANGED, { address });
  } catch (error) {
    console.warn(
      'Hive could not tell its windows about the wallet switch.',
      (error as Error)?.message
    );
  }
};
