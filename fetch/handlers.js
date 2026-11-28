// The slow work the app asks for: previewing a source, reading an article, fetching one source or all of them.
import { previewSource } from './lib/fetcher.js';
import { fetchSources, fetchAll, readItem } from './jobs.js';
import { openStore } from './store.js';

export function makeFetcher(db) {
  // Fetches run one at a time, so two of them never hand out the same item id.
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const run = chain.then(async () => { const store = openStore(db); await store.load(); return fn(store); });
    chain = run.catch(() => {});
    return run;
  };
  return {
    async preview({ source }) {
      return (await previewSource(source)).slice(0, 15).map(({ content_html: _, ...rest }) => rest);
    },
    // Reading touches one article's text only, so it doesn't wait behind a running fetch.
    async read({ item }) { return readItem(openStore(db), item); },
    async fetch_source({ id }) {
      return exclusive((store) => {
        const src = store.rows('sources').find((s) => s.id === Number(id));
        if (!src) throw new Error('Source not found');
        return fetchSources(store, [src]);
      });
    },
    async fetch_all() { return (await exclusive(fetchAll)).results; },
    /** The timed run over every source. */
    scheduled: () => exclusive(fetchAll),
  };
}
