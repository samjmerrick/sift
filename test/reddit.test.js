import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { previewSource } from '../supabase/functions/_shared/fetcher.js';

// Mock Reddit's OAuth + listing endpoints.
const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (String(url) === 'https://www.reddit.com/api/v1/access_token') {
    const expected = `Basic ${btoa('my-id:my-secret')}`;
    if (init.headers.Authorization !== expected) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    assert.equal(init.body, 'grant_type=client_credentials');
    return new Response(JSON.stringify({ access_token: 'tok123', expires_in: 3600 }), { status: 200 });
  }
  const m = /^https:\/\/oauth\.reddit\.com\/r\/(\w+)\/top\?t=week&limit=15&raw_json=1$/.exec(String(url));
  if (m) {
    assert.equal(init.headers.Authorization, 'Bearer tok123');
    assert.match(init.headers['User-Agent'], /sift/);
    return new Response(JSON.stringify({ data: { children: [
      { data: { title: 'Great self post', permalink: `/r/${m[1]}/comments/a/x/`, is_self: true, url: '', selftext: 'Useful text', score: 500, num_comments: 40, created_utc: 1795000000 } },
      { data: { title: 'Link post', permalink: `/r/${m[1]}/comments/b/y/`, is_self: false, url: 'https://example.com/article', selftext: '', score: 120, num_comments: 9, created_utc: 1795000000 } },
      { data: { title: 'Low score', permalink: `/r/${m[1]}/comments/c/z/`, is_self: true, url: '', selftext: '', score: 3, num_comments: 0, created_utc: 1795000000 } },
      { data: { title: 'Mod sticky', permalink: `/r/${m[1]}/comments/d/w/`, is_self: true, stickied: true, url: '', selftext: '', score: 9000, num_comments: 0, created_utc: 1795000000 } },
    ] } }), { status: 200 });
  }
  return new Response('blocked', { status: 403 });
};
after(() => { globalThis.fetch = realFetch; delete process.env.REDDIT_CLIENT_ID; delete process.env.REDDIT_CLIENT_SECRET; });

test('reddit via official API: sign in once, filter by score, map links', async () => {
  process.env.REDDIT_CLIENT_ID = 'my-id';
  process.env.REDDIT_CLIENT_SECRET = 'my-secret';
  const src = (subreddit) => ({ kind: 'reddit', config: { subreddit, period: 'week', limit: 15, min_score: 100 } });
  const piano = await previewSource(src('piano'));
  const guitar = await previewSource(src('r/guitarlessons'));
  assert.deepEqual(piano.map((p) => p.title), ['Great self post', 'Link post']);
  assert.equal(piano[0].url, 'https://www.reddit.com/r/piano/comments/a/x/');
  assert.equal(piano[0].summary, 'Useful text');
  assert.equal(piano[1].url, 'https://example.com/article');
  assert.equal(piano[1].comments_url, 'https://www.reddit.com/r/piano/comments/b/y/');
  assert.equal(piano[1].community_score, 120);
  assert.equal(guitar.length, 2);
  assert.equal(calls.filter((c) => c.url.includes('access_token')).length, 1, 'token is reused across subreddits');
});

test('without credentials, a blocked Reddit gives an actionable error', async () => {
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
  await assert.rejects(previewSource({ kind: 'reddit', config: { subreddit: 'piano' } }), /REDDIT_CLIENT_ID/);
});
