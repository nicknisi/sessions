/**
 * The project's public site.
 *
 * This string is rendered into two independently built HTML documents and two
 * canvas images: the report page and its share card, the wrapped deck and its
 * share card. A share card is the one artifact that travels without any of its
 * context — someone sees a screenshot in a timeline with no link attached — so
 * the domain has to be printed on the image itself rather than only in the page
 * that produced it.
 *
 * One constant because four copies is four things to forget when the domain
 * changes.
 */
export const SITE_HOST = 'sessions.engineering';
export const SITE_URL = `https://${SITE_HOST}`;

/** The no-install command, printed on every wrapped image: an image cannot be
 *  clicked, but a command someone can read off it can be typed. */
// The scheme is explicit: a bare host makes curl start over plain HTTP, and the
// script it fetches is the thing doing the verifying.
export const WRAPPED_CMD = `curl -fsSL ${SITE_URL}/wrapped | sh`;
