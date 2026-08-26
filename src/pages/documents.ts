import { childUrl, type Child } from '../children.js';
import { clean, parseDanishDateTime, type Doc } from '../html.js';
import { fetchPage } from '../login.js';
import { absUrl } from '../session.js';

export interface Document {
  name: string;
  folder: string;
  url: string;
  date?: string;
  dateText: string;
}

interface Folder {
  Name?: string;
  Title?: string;
  Url?: string;
}

/** All documents in "Klassens dokumenter", including one level of sub-folders. */
export async function getDocuments(child: Child): Promise<Document[]> {
  const rootTitle = 'Klassens dokumenter';
  const $ = await fetchPage(childUrl(child, '/documents/class'));

  const documents = collectDocuments($, rootTitle);

  // Sub-folders are listed as JSON in a hidden field rather than as links.
  const foldersJson = $('#FoldersJson').attr('value');
  if (foldersJson) {
    let folders: Folder[] = [];
    try {
      folders = JSON.parse(foldersJson) as Folder[];
    } catch {
      folders = [];
    }

    for (const folder of folders) {
      // Names starting with "$" are ForældreIntra's own internal folders.
      if (!folder.Url || folder.Name?.startsWith('$')) continue;
      const $folder = await fetchPage(absUrl(folder.Url));
      const label = `${rootTitle} / ${clean(folder.Title).replace(/>/g, '/')}`;
      documents.push(...collectDocuments($folder, label));
    }
  }

  return documents;
}

function collectDocuments($: Doc, folder: string): Document[] {
  const docs: Document[] = [];
  $('div.sk-document').each((_, el) => {
    const doc = $(el);
    const name = clean(doc.find('span.sk-documents-document-title').first().text());
    const dateText = clean(doc.find('div.sk-documents-date-column').first().text());
    const href = doc.find('a[href]').first().attr('href');
    if (!name || !dateText || !href) return;

    docs.push({ name, folder, url: absUrl(href), date: parseDanishDateTime(dateText), dateText });
  });
  return docs;
}
