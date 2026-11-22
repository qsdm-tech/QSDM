import { restartToUpdate as restartToUpdateNow } from '../../AppUpdater';

export const restartToUpdate = async (): Promise<{ restarting: boolean }> => {
  return restartToUpdateNow();
};
