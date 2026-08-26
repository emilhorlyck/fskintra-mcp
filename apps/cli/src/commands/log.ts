/** `fskintra log` — recent login attempts. */

import { fmt, info, printJson } from '../io.ts';
import { loginLogPath, readLoginLog } from '../login-log.ts';

export async function runLog(flags: {
  json?: boolean | undefined;
  last?: string | boolean | undefined;
}): Promise<number> {
  const limit = typeof flags.last === 'string' ? Number.parseInt(flags.last, 10) || 20 : 20;
  const entries = await readLoginLog(limit);

  if (flags.json) {
    printJson({ path: loginLogPath(), entries });
    return 0;
  }

  if (entries.length === 0) {
    info(`No login attempts recorded yet (${loginLogPath()}).`);
    return 0;
  }

  for (const entry of entries) {
    const when = new Date(entry.ts).toLocaleString('da-DK');
    const mark = entry.outcome === 'success' ? fmt.green('✓') : fmt.red('✗');
    const detail = entry.error ? ` ${fmt.dim(entry.error)}` : '';
    const took = entry.durationMs ? fmt.dim(` ${entry.durationMs}ms`) : '';
    process.stdout.write(`${mark} ${when}  ${entry.username}@${entry.hostname}${detail}${took}\n`);
  }
  return 0;
}
