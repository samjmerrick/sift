// Defensive client-side sanitiser for article HTML from the `read` Edge Function action. The server already
// sanitises; this walks the parsed DOM again with the same allowlist and rebuilds a clean tree, so nothing the
// server missed (scripts, handlers, styles, javascript: URLs…) can ever reach the page.
// Pure over a DOM: pass any `Document` (browser or linkedom) to build the output nodes with.

const ALLOWED = new Set([
  'p', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'br', 'hr',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup', 'small', 'abbr', 'cite', 'q', 'kbd', 'samp', 'var', 'time',
  'a', 'img', 'figure', 'figcaption',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'dl', 'dt', 'dd',
]);
// Dropped together with everything inside them.
const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'template', 'svg', 'math', 'canvas',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'video', 'audio', 'source', 'track', 'link', 'meta', 'base', 'head', 'title', 'dialog',
]);
// Attributes kept per tag (everything else, including on*, style, class and id, is dropped).
const ATTRS = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  ol: ['start'],
  abbr: ['title'],
};
const HEADING_UP = { h1: 'h2' };

/** Keep only plain http(s) URLs. Control characters and whitespace tricks like "java\nscript:" are stripped first. */
export function safeHttpUrl(value) {
  const v = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return /^https?:\/\/[^/?#\s]/i.test(v) ? v : null;
}

function clean(node, out, doc) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3) { out.appendChild(doc.createTextNode(child.nodeValue)); continue; }
    if (child.nodeType !== 1) continue; // comments, processing instructions…
    const tag = String(child.localName || child.nodeName).toLowerCase();
    if (DROP.has(tag)) continue;
    const name = HEADING_UP[tag] || tag;
    if (!ALLOWED.has(name)) { clean(child, out, doc); continue; } // unknown wrapper (div, span, section…): keep its content
    if (name === 'img') {
      const src = safeHttpUrl(child.getAttribute('src'));
      if (!src) continue;
      const img = doc.createElement('img');
      img.setAttribute('src', src);
      img.setAttribute('alt', child.getAttribute('alt') || '');
      const title = child.getAttribute('title');
      if (title) img.setAttribute('title', title);
      img.setAttribute('loading', 'lazy');
      img.setAttribute('referrerpolicy', 'no-referrer');
      out.appendChild(img);
      continue;
    }
    const el = doc.createElement(name);
    for (const attr of ATTRS[name] || []) {
      const v = child.getAttribute(attr);
      if (v == null) continue;
      if (attr === 'href') {
        const href = safeHttpUrl(v);
        if (href) el.setAttribute('href', href);
      } else if (attr === 'colspan' || attr === 'rowspan' || attr === 'start') {
        if (/^\d{1,3}$/.test(v.trim())) el.setAttribute(attr, v.trim());
      } else el.setAttribute(attr, v);
    }
    if (name === 'a') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
    clean(child, el, doc);
    out.appendChild(el);
  }
}

/** Sanitise an already-parsed DOM node; returns a DocumentFragment built with `doc`. */
export function sanitiseNode(root, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  clean(root, frag, doc);
  return frag;
}

/** Sanitise an HTML string. `parse(html)` must return a Document (defaults to the browser's DOMParser). */
export function sanitiseHtml(html, { doc = globalThis.document, parse } = {}) {
  const parsed = parse ? parse(String(html ?? '')) : new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  return sanitiseNode(parsed.body || parsed, doc);
}
