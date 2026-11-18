// Form schemas for article sources, used by the Settings screen.
export const SOURCE_KINDS = {
  rss: {
    label: 'RSS / Atom feed',
    description: 'Any RSS or Atom feed: blogs, Substack (/feed), YouTube channels (youtube.com/feeds/videos.xml?channel_id=…), arXiv, podcasts.',
    fields: [
      { key: 'url', label: 'Feed URL', type: 'text', default: '' },
      { key: 'max_age_days', label: 'Ignore posts older than (days)', type: 'number', default: 14 },
    ],
  },
  hn: {
    label: 'Hacker News',
    description: 'Popular HN stories. Use the keyword filter to keep only those on your topic.',
    fields: [
      { key: 'min_points', label: 'Minimum points', type: 'number', default: 150 },
      { key: 'days', label: 'Look back (days)', type: 'number', default: 3 },
    ],
  },
  reddit: {
    label: 'Subreddit',
    description: 'Top posts from a subreddit. Only posts above the score threshold are kept.',
    fields: [
      { key: 'subreddit', label: 'Subreddit (without r/)', type: 'text', default: '' },
      { key: 'period', label: 'Top of the', type: 'select', options: ['day', 'week', 'month'], default: 'week' },
      { key: 'limit', label: 'Max posts per fetch', type: 'number', default: 15 },
      { key: 'min_score', label: 'Minimum upvotes', type: 'number', default: 50 },
    ],
  },
};
