/**
 * The `foraldreintra.discover` tool — the thing this server exists for.
 *
 * One call returns a typed manifest: the children on the account, which
 * sections this school actually has, and which tools are therefore worth
 * calling. The agent picks from that menu instead of us hard-coding a fixed
 * tool tree.
 *
 * The argument for this pattern is the same as in aula-mcp, and if anything
 * stronger here:
 *
 *   - A parent with one child should not see per-child variants of every tool.
 *   - A school without the homework module should not be offered homework
 *     tools; ForældreIntra answers those with "ikke autoriseret", and an agent
 *     that can't tell that from "no homework this week" will tell the parent
 *     something false.
 *   - Which message UI the school runs changes what `get_message` needs. The
 *     manifest says which, so the agent doesn't have to discover it by failing.
 */

import {
  detectMessageUi,
  probeSections,
  SECTION_IDS,
  type SectionId,
  type SectionStatus,
} from '@fskintra-mcp/fskintra-client';
import type { FskintraContext } from './context.ts';

export interface DiscoveredChild {
  id: string;
  name: string;
  /** Absolute URL prefix for this child's pages. Diagnostic value mostly. */
  urlPrefix: string;
  /** Per-section availability for this child's school. */
  sections: SectionStatus[];
}

export interface DiscoveredCapability {
  /** Human description for the agent. */
  summary: string;
  /** MCP tool names the agent can call to use this capability. */
  tools: string[];
  /** Which children have it. Empty means no child does. */
  availableFor: string[];
  notes?: string;
}

export interface DiscoverManifest {
  school: {
    hostname: string;
    username: string;
  };
  children: DiscoveredChild[];
  /**
   * Which of the two message UIs this school runs. `get_message` needs a
   * thread id on `conversations` and ignores it on `inbox`.
   */
  messageUi: 'conversations' | 'inbox';
  session: {
    /** Unix epoch seconds when the session was last confirmed live. */
    verified_at?: number;
    /** Whether a silent re-login is possible without user interaction. */
    canReauthenticate: boolean;
  };
  capabilities: Record<string, DiscoveredCapability>;
  /** Section ids that no child has. Named so the agent can say why. */
  unavailableSections: SectionId[];
  /** True when FSKINTRA_MCP_RAW=1 — the raw_request escape hatch is callable. */
  rawRequestEnabled: boolean;
  /** True when FSKINTRA_MCP_WRITE=1 — the server is read-only without it. */
  writeEnabled: boolean;
  /**
   * Inline hints repeating the server `instructions`, so the agent has the
   * workflow next to the data it just read. Cheaper to ground on this than to
   * re-fetch context — keep tight.
   */
  usage: {
    cache: string;
    nameResolution: string;
    sectionAvailability: string;
    messages: string;
    language: string;
  };
}

const CAPABILITY_TOOLS: Readonly<Record<SectionId, { summary: string; tools: string[] }>> =
  Object.freeze({
    news: {
      summary: 'Front page news ("opslagstavle") with authors, recipients, dates and attachments.',
      tools: ['foraldreintra.news'],
    },
    messages: {
      summary: 'Messages ("beskeder") — conversation list and full threads.',
      tools: ['foraldreintra.messages.list', 'foraldreintra.messages.get'],
    },
    weekplans: {
      summary: 'Weekly plans ("ugeplaner") broken down per day.',
      tools: ['foraldreintra.weekplans'],
    },
    homework: {
      summary: 'Homework ("lektier") grouped by due date.',
      tools: ['foraldreintra.homework'],
    },
    documents: {
      summary: 'Class documents, including sub-folders. Fetch one with foraldreintra.download.',
      tools: ['foraldreintra.documents'],
    },
    photos: {
      summary: 'Photo albums and their image URLs.',
      tools: ['foraldreintra.photos'],
    },
    contacts: {
      summary: "Contact cards for the pupils in a child's class.",
      tools: ['foraldreintra.contacts'],
    },
    signups: {
      summary: 'Open sign-ups for parent-teacher conversations and school events.',
      tools: ['foraldreintra.signups'],
    },
  });

export async function buildDiscoverManifest(context: FskintraContext): Promise<DiscoverManifest> {
  const client = await context.getClient();
  const children = await client.getChildren();

  const discovered: DiscoveredChild[] = [];
  for (const child of children) {
    discovered.push({
      id: child.id,
      name: child.name,
      urlPrefix: child.urlPrefix,
      sections: await probeSections(client, child),
    });
  }

  const capabilities: Record<string, DiscoveredCapability> = {};
  const unavailableSections: SectionId[] = [];

  for (const id of SECTION_IDS) {
    const availableFor = discovered
      .filter((child) => child.sections.find((s) => s.id === id)?.available)
      .map((child) => child.name);

    const spec = CAPABILITY_TOOLS[id];
    const note = availableFor.length
      ? undefined
      : (discovered[0]?.sections.find((s) => s.id === id)?.note ??
        'Not available for any child on this account.');

    capabilities[id] = {
      summary: spec.summary,
      tools: spec.tools,
      availableFor,
      ...(note ? { notes: note } : {}),
    };

    if (availableFor.length === 0) unavailableSections.push(id);
  }

  return {
    school: {
      hostname: client.hostname ?? '(unknown)',
      username: client.username ?? '(unknown)',
    },
    children: discovered,
    messageUi: await detectMessageUi(client),
    session: {
      ...(client.verifiedAt ? { verified_at: client.verifiedAt } : {}),
      // A resumed or env-credentialed client can always re-login silently.
      canReauthenticate: true,
    },
    capabilities,
    unavailableSections,
    rawRequestEnabled: process.env.FSKINTRA_MCP_RAW === '1',
    writeEnabled: process.env.FSKINTRA_MCP_WRITE === '1',
    usage: {
      cache: 'Call discover ONCE per session and reuse the manifest.',
      nameResolution:
        'Match names from the user prompt against children[].name (case-insensitive, ' +
        'partial). Pass the matched name or id as the `child` argument.',
      sectionAvailability:
        'Never call a tool whose capability lists an empty availableFor. If the user asks ' +
        'about it, say the school does not use that module — do not report it as empty.',
      messages:
        'On `conversations` pass both thread_id and message_id to foraldreintra.messages.get. ' +
        'On `inbox` thread_id is ignored; pass an empty string.',
      language:
        "Reply in the user's language (Danish if they wrote Danish). Render dates as " +
        '`mandag 12. maj`-style, not ISO, unless asked otherwise.',
    },
  };
}
