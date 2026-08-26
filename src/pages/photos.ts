import { childUrl, type Child } from '../children.js';
import { clean } from '../html.js';
import { fetchPage } from '../login.js';
import { absUrl } from '../session.js';

export interface PhotoAlbum {
  title: string;
  url: string;
  photos: string[];
}

/** Photo albums are the options of a filter dropdown, each its own page. */
export async function getPhotoAlbums(child: Child): Promise<PhotoAlbum[]> {
  const $ = await fetchPage(childUrl(child, '/photos/archives'));

  const albums: { title: string; url: string }[] = [];
  $('#sk-photos-toolbar-filter option[value]').each((_, opt) => {
    const url = absUrl($(opt).attr('value')!);
    // Guard against the dropdown pointing outside this child's area.
    if (!url.startsWith(child.urlPrefix)) return;
    albums.push({ title: clean($(opt).text()), url });
  });

  const result: PhotoAlbum[] = [];
  for (const album of albums) {
    const $album = await fetchPage(album.url);
    const photos: string[] = [];
    $album('img[src]').each((_, img) => {
      const src = $album(img).attr('src')!;
      if (!/placeholder/i.test(src)) photos.push(absUrl(src));
    });
    result.push({
      title: clean($album('h2').first().text()) || album.title,
      url: album.url,
      photos,
    });
  }

  return result;
}
