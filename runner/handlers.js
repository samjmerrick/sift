// What the runner does for each kind of job the app queues.
import { previewSource } from './lib/fetcher.js';
import { fetchSources, fetchAll, readItem } from './jobs.js';

export const makeHandlers = (store) => ({
  async preview({ source }) {
    return (await previewSource(source)).slice(0, 15).map(({ content_html: _, ...rest }) => rest);
  },
  async read({ item }) { return readItem(store, item); },
  async fetch_source({ id }) {
    await store.load();
    const src = store.rows('sources').find((s) => s.id === Number(id));
    if (!src) throw new Error('Source not found');
    return fetchSources(store, [src]);
  },
  async fetch_all() {
    await store.load();
    return (await fetchAll(store)).results;
  },
});
