/**
 * What a logged-in ForældreIntra front page looks like, expressed as the one
 * thing it always carries: a link per child.
 *
 * Two layers ask the same question and used to answer it with two subtly
 * different regexes. The login flow (`fskintra-auth`) asks "am I on the front
 * page yet?" to know it is done; the client (`fskintra-client`) asks "is this
 * the front page I can scrape children off?". Those are the same question, so
 * they must share the same answer — otherwise a page login accepts (an
 * absolute href, a trailing slash) is one the client then finds no children
 * on, and you get a login that succeeds into zero children.
 *
 * A child link is three path segments followed by `/Index`, e.g.
 * `/parent/1234/Andrea/Index`. It may be an absolute URL or a bare path, and
 * may carry a trailing slash. This is the permissive, canonical form; both
 * layers use it and nothing else.
 */
const CHILD_LINK_RE = /^(?:https?:\/\/[^/]+)?(?:\/[^/]*){3}\/Index\/?$/i;

/** Is this href a link to a child's front page? */
export function isChildLink(href: string | undefined | null): boolean {
  return href != null && CHILD_LINK_RE.test(href);
}
