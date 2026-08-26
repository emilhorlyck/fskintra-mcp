import { childUrl, type Child } from '../children.js';
import { log } from '../config.js';
import { clean, htmlToText, parseDanishDateTime, textOf, type Doc } from '../html.js';
import { fetchPage, login } from '../login.js';
import { absUrl, getSession } from '../session.js';
import type { Attachment } from './news.js';

/**
 * ForældreIntra ships two message UIs and schools are on one or the other.
 * fskintra sniffed which by looking at the "Besked" link in the top menu;
 * we do the same.
 */
export type MessageUi = 'conversations' | 'inbox';

export interface Message {
  id: string;
  threadId?: string;
  subject: string;
  sender: string;
  recipients: string[];
  date?: string;
  dateText: string;
  body: string;
  /** Quoted earlier messages, when the message is a reply */
  quoted?: string;
  attachments: Attachment[];
  unread: boolean;
}

export interface ConversationSummary {
  threadId: string;
  latestMessageId: string;
  subject: string;
  sender: string;
  dateText: string;
  unread: boolean;
}

export async function detectMessageUi(): Promise<MessageUi> {
  const $ = await login();
  let found: MessageUi | undefined;
  $('a[href]').each((_, a) => {
    if (!/besked/i.test(clean($(a).text()))) return;
    const last = $(a).attr('href')!.replace(/\/$/, '').split('/').pop();
    if (last === 'conversations' || last === 'inbox') found = last;
  });
  return found ?? 'conversations';
}

export async function listConversations(child: Child): Promise<ConversationSummary[]> {
  const ui = await detectMessageUi();
  return ui === 'conversations' ? listFromConversations(child) : listFromTrays(child);
}

/**
 * Fetch every message in a conversation. `threadId` is empty for
 * "threadless" messages (broadcasts to all students), which have their own
 * endpoint.
 */
export async function getConversation(
  child: Child,
  threadId: string,
  latestMessageId: string
): Promise<Message[]> {
  const ui = await detectMessageUi();
  if (ui === 'inbox') return [await getTrayMessage(child, latestMessageId)];

  const suffix = threadId
    ? `/messages/conversations/loadmessagesforselectedconversation` +
      `?threadId=${encodeURIComponent(threadId)}` +
      `&takeFromRootMessageId=${encodeURIComponent(latestMessageId)}` +
      `&takeToMessageId=0&searchRequest=`
    : `/messages/conversations/getmessageforthreadlessconversation` +
      `?messageId=${encodeURIComponent(latestMessageId)}`;

  const res = await getSession().request(childUrl(child, suffix) + `&_=${Date.now()}`);
  let payload: unknown;
  try {
    payload = JSON.parse(res.body);
  } catch {
    throw new Error(`Could not read the message thread ${threadId || latestMessageId}.`);
  }

  const raw = Array.isArray(payload) ? payload : [payload];
  return raw.map((m) => messageFromJson(m as RawMessage, threadId)).reverse();
}

export async function markRead(child: Child, messageId: string, isRead = true): Promise<void> {
  log(`marking message ${messageId} as ${isRead ? 'read' : 'unread'}`);
  await getSession().request(childUrl(child, '/messages/UpdateMessagesReadState'), {
    method: 'POST',
    body: new URLSearchParams({
      'selectionState[MessageIds][]': messageId,
      isRead: String(isRead),
    }),
  });
}

// ---------------------------------------------------------------- new UI ---

interface RawMessage {
  Id: number | string;
  Subject?: string;
  SenderName?: string;
  SentReceivedDateText?: string;
  BaseText?: string;
  PreviousMessagesText?: string;
  Recipients?: string[] | Record<string, { Name?: string }[]>;
  AttachmentsLinks?: { HrefAttributeValue: string; Text: string }[] | null;
  ShowUnreadIndication?: boolean;
  AdditionalLinkUrl?: string | null;
}

interface RawConversation {
  ThreadId?: string;
  LatestMessageId?: number | string;
  Subject?: string;
  SenderName?: string;
  SentReceivedDateText?: string;
  ShowUnreadIndication?: boolean;
}

function messageFromJson(json: RawMessage, threadId: string): Message {
  const dateText = clean(json.SentReceivedDateText);
  return {
    id: String(json.Id),
    threadId: threadId || undefined,
    subject: clean(json.Subject) || '(uden emne)',
    sender: clean(json.SenderName),
    recipients: normalizeRecipients(json.Recipients),
    date: parseDanishDateTime(dateText),
    dateText,
    body: htmlToText(json.BaseText ?? ''),
    quoted: json.PreviousMessagesText ? htmlToText(json.PreviousMessagesText) : undefined,
    attachments: (json.AttachmentsLinks ?? []).map((a) => ({
      name: clean(a.Text),
      url: absUrl(a.HrefAttributeValue),
    })),
    unread: json.ShowUnreadIndication === true,
  };
}

/**
 * Recipients were a plain array until August 2025, when they became a map
 * keyed by group with the flat list under "".
 */
function normalizeRecipients(recipients: RawMessage['Recipients']): string[] {
  if (!recipients) return [];
  if (Array.isArray(recipients)) return recipients.map(clean).filter(Boolean);
  return Object.values(recipients)
    .flat()
    .map((r) => clean(r?.Name))
    .filter(Boolean);
}

/**
 * The conversation list is not in the markup — it is JSON stashed in a data
 * attribute on some div inside the content wrapper. We look for the attribute
 * rather than a fixed name, because the name has changed before.
 */
async function listFromConversations(child: Child): Promise<ConversationSummary[]> {
  const $ = await fetchPage(childUrl(child, '/messages/conversations'));
  const conversations = findConversationsJson($);

  if (!conversations) {
    throw new Error(
      'No message data found on the conversations page. The school may not use messages, ' +
        'or the page layout has changed.'
    );
  }

  return conversations
    .filter((c) => c.LatestMessageId)
    .map((c) => ({
      threadId: c.ThreadId ?? '',
      latestMessageId: String(c.LatestMessageId),
      subject: clean(c.Subject) || '(uden emne)',
      sender: clean(c.SenderName),
      dateText: clean(c.SentReceivedDateText),
      unread: c.ShowUnreadIndication === true,
    }));
}

function findConversationsJson($: Doc): RawConversation[] | undefined {
  let result: RawConversation[] | undefined;
  $('.sk-l-content-wrapper div').each((_, el) => {
    if (result) return false;
    for (const [name, value] of Object.entries(el.attribs ?? {})) {
      if (!name.toLowerCase().includes('message') || value.length < 100) continue;
      try {
        const parsed = JSON.parse(value) as { Conversations?: RawConversation[] };
        if (parsed && Array.isArray(parsed.Conversations)) {
          result = parsed.Conversations;
          return false;
        }
      } catch {
        // Not the attribute we are after — keep looking.
      }
    }
    return undefined;
  });
  return result;
}

// ---------------------------------------------------------------- old UI ---

async function listFromTrays(child: Child): Promise<ConversationSummary[]> {
  const out: ConversationSummary[] = [];

  for (const tray of ['inbox', 'outbox'] as const) {
    const $ = await fetchPage(childUrl(child, `/messages/${tray}`));
    $('.sk-message-list-item').each((_, el) => {
      const item = $(el);
      const href = item.find('a[href]').first().attr('href') ?? '';
      const id = /\/message\/(\d+)/.exec(href)?.[1];
      if (!id) return;

      // Senders render as "Jens Hansen (klasselærer)"
      const sender = clean(item.find('.sk-message-senderrecipient-name').first().text()).replace(
        /\s*\(.*\)$/,
        ''
      );

      out.push({
        threadId: '',
        latestMessageId: id,
        subject: clean(item.find('.sk-message-title').first().text()) || '(uden emne)',
        sender,
        dateText: clean(item.find('.sk-message-send-date').first().text()),
        unread: item.hasClass('sk-message-unread') || item.find('.sk-unread').length > 0,
      });
    });
  }

  return out;
}

async function getTrayMessage(child: Child, messageId: string): Promise<Message> {
  const $ = await fetchPage(childUrl(child, `/messages/message/${messageId}`));

  const recipientBlock = $(
    '.sk-message-title-rows-container div.sk-message-senderrecipient-name'
  ).first();
  const recipients = (recipientBlock.length
    ? recipientBlock
    : $('div.sk-message-senderrecipient-name').first()
  ).clone();
  recipients.find('span').first().remove(); // "Til:"
  recipients.find('a.sk-message-show-more-link').remove();

  const dateText = clean($('div.sk-message-send-date').first().text());
  const quoted = $('div.sk-message-text + a + div').first();

  const attachments: Attachment[] = [];
  $('div.sk-attachments-list a[href]').each((_, a) => {
    attachments.push({ name: clean($(a).text()), url: absUrl($(a).attr('href')!) });
  });

  return {
    id: messageId,
    subject: clean($('div.sk-message-subject-text').first().text()) || '(uden emne)',
    sender: clean($('.sk-message-sender-name, .sk-message-senderrecipient-name').first().text()),
    recipients: clean(recipients.text())
      .split(/\s*(?:,|\bog\b)\s*/)
      .filter(Boolean),
    date: parseDanishDateTime(dateText),
    dateText,
    body: textOf($, $('div.sk-message-text').first()),
    quoted: quoted.length ? textOf($, quoted) : undefined,
    attachments,
    unread: false,
  };
}
