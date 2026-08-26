/**
 * Live spike: log in to the real ForældreIntra and report which sections
 * actually parse. Run before trusting the MCP server:
 *
 *   FSKINTRA_HOSTNAME=... FSKINTRA_USERNAME=... FSKINTRA_PASSWORD=... \
 *     npm run probe
 *
 * Add `--dump <dir>` to save each fetched page for selector debugging.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getChildren } from './children.js';
import { login } from './login.js';
import { getContacts } from './pages/contacts.js';
import { getDocuments } from './pages/documents.js';
import { getHomework } from './pages/homework.js';
import { detectMessageUi, listConversations } from './pages/messages.js';
import { getFrontpage } from './pages/news.js';
import { getPhotoAlbums } from './pages/photos.js';
import { getSignups } from './pages/signup.js';
import { getWeekplans } from './pages/weekplans.js';

const dumpDir = process.argv.includes('--dump')
  ? process.argv[process.argv.indexOf('--dump') + 1]
  : undefined;

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : JSON.stringify(v)?.slice(0, 40)}`)
      .join(' ');
  }
  return String(value);
}

async function check(label: string, fn: () => Promise<unknown>): Promise<void> {
  process.stdout.write(`${label.padEnd(22)}`);
  try {
    const result = await fn();
    console.log(`OK   ${summarize(result)}`);
    if (dumpDir) {
      await mkdir(dumpDir, { recursive: true });
      await writeFile(
        join(dumpDir, `${label.replace(/\W+/g, '-')}.json`),
        JSON.stringify(result, null, 2)
      );
    }
  } catch (error) {
    console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  }
}

const frontpage = await login();
console.log(`Logged in. Front page title: ${frontpage('title').text().trim() || '(none)'}`);

if (dumpDir) {
  await mkdir(dumpDir, { recursive: true });
  await writeFile(join(dumpDir, 'frontpage.html'), frontpage.html());
  console.log(`Pages dumped to ${dumpDir}`);
}

const children = await getChildren();
console.log(`Children: ${children.map((c) => `${c.name} (#${c.id})`).join(', ')}\n`);
console.log(`Message UI: ${await detectMessageUi()}\n`);

for (const child of children) {
  console.log(`--- ${child.name} ---`);
  await check('news', () => getFrontpage(child));
  await check('messages', () => listConversations(child));
  await check('weekplans', () => getWeekplans(child, 2));
  await check('homework', () => getHomework(child));
  await check('documents', () => getDocuments(child));
  await check('photos', () => getPhotoAlbums(child));
  await check('contacts', () => getContacts(child));
  await check('signups', () => getSignups(child));
  console.log();
}
