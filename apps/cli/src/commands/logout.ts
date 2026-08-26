/** `fskintra logout` — forget the stored session. */

import { info, ok } from '../io.ts';
import { resolveStore, storeBackendName } from '../store.ts';

export async function runLogout(): Promise<number> {
  const backend = storeBackendName();
  await resolveStore().clear();
  ok(`Session cleared from ${backend}.`);
  info('The encryption key file, if any, is left in place. Delete it by hand if you want it gone.');
  return 0;
}
