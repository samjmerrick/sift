// Builds the self-contained preview of Sift: the real app (public/) running against an in-memory backend with
// sample data (preview/), in one HTML file with no Supabase and no network. Used for quick UI reviews.
//
//   npm run preview            → dist/sift-preview.html        (an HTML fragment, the form published as an artifact)
//                              → dist/sift-preview.local.html  (the same as a full document, to open in a browser)
import { build } from 'esbuild';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

// Starter packs, bundled so Settings → Add a starter pack works offline. Order follows starters/index.json.
const order = JSON.parse(read('public/starters/index.json'));
const packs = Object.fromEntries(order.map((f) => [f, JSON.parse(read(`public/starters/${f}`))]));
const startersPlugin = {
  name: 'starters',
  setup(b) {
    b.onResolve({ filter: /starters\.gen\.js$/ }, () => ({ path: 'starters', namespace: 'starters' }));
    b.onLoad({ filter: /.*/, namespace: 'starters' }, () => ({ contents: `export default ${JSON.stringify(packs)};`, loader: 'js' }));
  },
};

const result = await build({
  entryPoints: [join(root, 'preview/entry.js')],
  bundle: true, format: 'esm', target: 'es2022', write: false, minify: false, legalComments: 'none',
  plugins: [startersPlugin],
});
const appJs = result.outputFiles[0].text;

const html = read('public/index.html');
const bodyMarkup = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script')).trim();
const diagnostics = /<script>\s*\/\/ Startup diagnostics[\s\S]*?<\/script>/.exec(html)?.[0] || '';
const vendor = readdirSync(join(root, 'public/vendor')).find((f) => f.startsWith('supabase-js'));
const script = (js, attrs = '') => `<script${attrs}>${js.replace(/<\/script/gi, '<\\/script')}</script>`;
const build_id = new Date().toISOString().slice(0, 16).replace('T', ' ');

const PREVIEW_CSS = `
/* Preview build only: a badge so nobody mistakes this for the real app. */
.wordmark::after { content: "preview"; margin-left: 8px; padding: 2px 7px; border-radius: 999px; vertical-align: 3px;
  font: 600 11px/1.4 var(--sans); letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3); background: var(--surface-2); }
`;

const fragment = [
  '<title>Sift preview</title>',
  '<meta name="theme-color" content="#f5f2ec" media="(prefers-color-scheme: light)">',
  '<meta name="theme-color" content="#151413" media="(prefers-color-scheme: dark)">',
  `<style>${read('public/style.css').replace(/<\/style/gi, '<\\/style')}${PREVIEW_CSS}</style>`,
  bodyMarkup,
  diagnostics.replace("window.SIFT_BUILD = 'dev'", `window.SIFT_BUILD = 'preview ${build_id}'`),
  script(read(`public/vendor/${vendor}`)),
  script(appJs, ' type="module"'),
].join('\n');

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/sift-preview.html'), fragment);
writeFileSync(join(root, 'dist/sift-preview.local.html'),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`);
console.log(`dist/sift-preview.html  ${(fragment.length / 1024).toFixed(0)} KB`);
