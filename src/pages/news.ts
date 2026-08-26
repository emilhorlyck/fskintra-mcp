import type { Element } from 'domhandler';
import { childUrl, type Child } from '../children.js';
import { clean, parseDanishDateTime, textOf, type Doc } from '../html.js';
import { fetchPage } from '../login.js';
import { absUrl } from '../session.js';

export interface Attachment {
  name: string;
  url: string;
}

export interface NewsItem {
  id: string;
  title: string;
  author: string;
  recipients: string[];
  date?: string;
  dateText: string;
  body: string;
  attachments: Attachment[];
  commentCount: number;
  comments?: string[];
}

export interface Frontpage {
  child: string;
  reminders: string[];
  news: NewsItem[];
}

/** Front page ("opslagstavle") news for one child. */
export async function getFrontpage(
  child: Child,
  opts: { includeComments?: boolean } = {}
): Promise<Frontpage> {
  const $ = await fetchPage(childUrl(child, '/Index'));
  const frontpage = parseFrontpage($, child.name);

  if (opts.includeComments) {
    for (const item of frontpage.news) {
      if (item.commentCount > 0 && item.id) {
        item.comments = await getComments(child, item.id, item.commentCount);
      }
    }
  }

  return frontpage;
}

/** Pure parser, so the markup contract can be tested without the network. */
export function parseFrontpage($: Doc, childName: string): Frontpage {
  const reminders: string[] = [];
  $('ul.sk-reminders-container > li').each((_, li) => {
    const text = clean($(li).text());
    if (text && !/der er aktiviteter i dag/i.test(text)) reminders.push(text);
  });

  const news = $('div.sk-news-item')
    .toArray()
    .map((el) => parseNewsItem($, el));

  return { child: childName, reminders, news };
}

function parseNewsItem($: Doc, el: Element): NewsItem {
  const item = $(el);

  const content = item.find('div.sk-news-item-content').first().clone();
  content.find('.sk-attachments-list, .sk-news-item-comments').remove();
  const body = textOf($, content);

  const author = item.find('div.sk-news-item-author').first();
  const authorName = clean(author.find('span').first().text());

  // Whatever is left in the author line after removing the sender, the "til"
  // and "og" separators and the show-more link is the recipient list.
  const recipientLine = author.clone();
  recipientLine.find('span').first().remove();
  recipientLine.find('.sk-news-item-for, a.sk-news-show-more-link').remove();
  // The " og " separator is its own element; dropping it outright would glue
  // the last two names together.
  recipientLine.find('.sk-news-item-and').replaceWith(', ');
  const recipients = clean(recipientLine.text())
    .split(/\s*(?:,|\bog\b)\s*/)
    .map((r) => r.trim())
    .filter(Boolean);

  const dateText = clean(item.find('div.sk-news-item-timestamp').text())
    .split(/opdateret/i)[0]!
    .trim();

  const attachments: Attachment[] = [];
  item.find('div.sk-attachments-list a[href]').each((_, a) => {
    attachments.push({ name: clean($(a).text()), url: absUrl($(a).attr('href')!) });
  });

  const commentsBlock = item.find('div.sk-news-item-comments');
  const commentCount = Number(/vis (\d+) kommentar/i.exec(clean(commentsBlock.text()))?.[1] ?? 0);

  return {
    id: item.attr('data-feed-item-id') ?? '',
    title: body.split('\n')[0]?.replace(/[ .]+$/, '').trim() ?? '',
    author: authorName,
    recipients,
    date: parseDanishDateTime(dateText),
    dateText,
    body,
    attachments,
    commentCount,
  };
}

async function getComments(child: Child, itemId: string, count: number): Promise<string[]> {
  const $ = await fetchPage(childUrl(child, `/news/pins/${itemId}/comments`), {
    method: 'POST',
    body: new URLSearchParams({ _: String(count) }),
  });

  const comments: string[] = [];
  $('.sk-comments-container .sk-comment, .sk-comments-container li').each((_, el) => {
    const text = textOf($, $(el));
    if (text) comments.push(text);
  });

  if (comments.length === 0) {
    const all = textOf($, $('.sk-comments-container'));
    if (all) comments.push(all);
  }
  return comments;
}
