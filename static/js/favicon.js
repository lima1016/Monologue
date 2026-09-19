/* Paints the browser-tab icon in the current theme's accent.
 *
 * static/favicon.svg stays the file the <link> points to before any JS runs
 * (first paint, no-JS) -- this module repaints the same tab icon once the
 * page is up, from the *effective* --accent (theme x light/dark), which a
 * static file can never know. The shapes below are copied from
 * favicon.svg's five <rect>s exactly; only the fill changes.
 *
 * A data: URL, not a second <img>/<canvas> render: the tab icon is just the
 * href of the existing <link rel="icon">, so swapping it is the whole job.
 */
const FAVICON_LINK_ID = 'favicon-link';

/* x, y, width, height, rx -- straight from favicon.svg's five <rect>s. */
const BARS = [
  [5, 10, 8, 44, 4],
  [17, 16, 8, 32, 4],
  [28, 22, 8, 20, 4],
  [39, 16, 8, 32, 4],
  [51, 10, 8, 44, 4],
];

function buildSvg(color) {
  const rects = BARS.map(
    ([x, y, w, h, rx]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="${color}">${rects}</svg>`;
}

/* Loose on purpose: --accent is always authored as a hex/rgb()/hsl()/named
   value in tokens.css, never with anything that would need escaping in an
   SVG fill attribute. Empty (the property missing) and stray text (a typo,
   a token that resolved to nothing) both fail this and leave the icon
   alone -- a broken/blank favicon is worse than a stale one. */
function looksLikeColor(value) {
  return /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla)\([^)]*\)|[a-zA-Z]+)$/.test(value);
}

/* Reads the effective --accent off <html> and repaints the tab icon to
   match. Safe to call before the page has a favicon <link> at all (creates
   one), with no getComputedStyle (SSR-ish/test environments -- no-op), and
   with a blank/junk accent (leaves the current icon alone). */
export function paintFavicon() {
  if (typeof getComputedStyle !== 'function') return;
  let color;
  try {
    color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  } catch {
    return;
  }
  if (!looksLikeColor(color)) return;

  let link = document.getElementById(FAVICON_LINK_ID);
  if (!link) {
    link = document.createElement('link');
    link.id = FAVICON_LINK_ID;
    link.setAttribute('rel', 'icon');
    document.head.appendChild(link);
  }
  link.setAttribute('type', 'image/svg+xml');
  link.setAttribute('href', 'data:image/svg+xml,' + encodeURIComponent(buildSvg(color)));
}
