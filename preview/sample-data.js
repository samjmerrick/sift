// Sample content for the preview build: which starter packs to install, the articles each source "fetched", and
// some reading history (seen, liked, saved, studied cards) so every screen has something on it.
// All of it is made up. Edit freely: it only ever lives in the preview page.

export const PACKS = ['ai.json', 'programming.json', 'science.json', 'uk-news.json', 'russian.json', 'piano.json', 'sight-reading.json', 'machine-learning.json'];

const p = (...paras) => paras.map((x) => (x.startsWith('<') ? x : `<p>${x}</p>`)).join('\n');

/**
 * Articles by source name. ageH = hours since published. body = reader HTML (omit it and the reader shows its
 * "couldn't load" state, as it does for sites that block reading). YouTube sources get video URLs automatically.
 * state: 'seen' | 'up' | 'down' | 'saved' (saved also marks it read and liked).
 */
export const ARTICLES = {
  // ---- AI ----
  'Hacker News: AI': [
    { title: 'Show HN: A 40-line evaluation harness for comparing small language models', domain: 'github.com', ageH: 3, score: 412, comments: 138,
      summary: 'A single-file tool that runs the same prompt set against several local models and prints a side-by-side table of answers and timings.' },
    { title: 'Why long context windows still miss the middle of the document', domain: 'arxiv.org', ageH: 9, score: 287, comments: 96,
      summary: 'New measurements show retrieval accuracy dipping for facts placed in the middle of long inputs, even in recent models.' },
    { title: 'Running a 7B model on a ten-year-old laptop', domain: 'blog.lowtech.dev', ageH: 26, score: 655, comments: 241, state: 'saved',
      summary: 'Quantisation, a swap file and a lot of patience: what actually works on 8 GB of RAM and an old dual-core CPU.',
      body: p('My daily machine is a 2015 laptop with 8 GB of RAM and a dual-core i5. Everyone told me local language models were out of reach. They were mostly right, but not entirely.',
        '<h2>The setup</h2>', 'I used a 4-bit quantised 7B model, which takes a little under 4 GB on disk. Loading it takes about forty seconds from a SATA SSD. Generation runs at roughly two tokens per second, which is slow but usable for drafting short replies or summarising a page.',
        '<h2>What helped</h2>', '<ul><li>Closing the browser. It was using more memory than the model.</li><li>Pinning the thread count to the number of physical cores, not logical ones.</li><li>Keeping prompts short: prompt processing, not generation, was the real bottleneck.</li></ul>',
        'It will not replace a hosted model for anything heavy. But for private notes and offline use on a train, it is surprisingly good, and it costs nothing to run.') },
  ],
  'Simon Willison': [
    { title: 'Notes on structured output and when to trust it', ageH: 5, state: 'up',
      summary: 'Asking a model for JSON is easy. Knowing when the JSON is right is harder. Some patterns that have worked for me.',
      body: p('Most of my day-to-day LLM use now involves asking for structured output: JSON objects with a fixed schema that I can feed into other tools.',
        'Schema-constrained decoding guarantees the shape, but not the content. A field called <code>date</code> will always contain a string, but nothing ensures it is the right date.',
        '<h2>Three habits</h2>', '<ol><li><strong>Ask for evidence.</strong> Add a field for the exact quote the value came from, then check the quote really appears in the source.</li><li><strong>Allow "unknown".</strong> Models invent values when the schema leaves no way to say nothing was found.</li><li><strong>Spot-check by hand.</strong> Ten random rows tell you more than any automated score.</li></ol>',
        'None of this is new. It is the same discipline you would apply to any data pipeline with an unreliable step in the middle.') },
    { title: 'A small tool for diffing two prompt runs', ageH: 50, summary: 'I wanted to see exactly what changed when I tweaked a system prompt, so I built a tiny HTML page that highlights the differences.' },
  ],
  'Hugging Face blog': [
    { title: 'Smaller, faster embeddings for on-device search', ageH: 14,
      summary: 'A walkthrough of distilling a sentence embedding model to a fifth of its size while keeping most of its retrieval quality.' },
    { title: 'Open dataset release: multilingual reading comprehension', ageH: 70, summary: 'Questions and passages in 24 languages, written by native speakers rather than translated.' },
  ],
  'Lobsters: AI': [
    { title: 'Tokenisers are the least glamorous part of the stack', ageH: 20, summary: 'Why byte-level BPE still causes surprises with numbers, code indentation and non-Latin scripts.' },
  ],
  'Ahead of AI (Sebastian Raschka)': [
    { title: 'Understanding mixture-of-experts layers from scratch', ageH: 33, state: 'saved',
      summary: 'Building a minimal MoE layer in PyTorch, with routing, load balancing and the reasons each piece exists.',
      body: p('Mixture-of-experts (MoE) layers replace a single feed-forward block with several smaller "experts" and a router that picks which ones each token uses.',
        '<h2>The router</h2>', 'The router is a single linear layer that scores every expert for every token. We keep the top two scores, apply a softmax over just those two, and send the token to both experts, weighting their outputs by the softmax.',
        '<pre><code>scores = router(x)            # [tokens, experts]\ntop, idx = scores.topk(2, dim=-1)\nweights = top.softmax(dim=-1)</code></pre>',
        '<h2>Load balancing</h2>', 'Left alone, the router learns to favour a few experts and the rest go unused. An auxiliary loss that rewards even usage across a batch fixes this. It is a small term, but training without it usually collapses within a few thousand steps.',
        'The payoff is a model with many more parameters but roughly the same compute per token, because each token only visits two experts.') },
  ],
  'Interconnects (Nathan Lambert)': [
    { title: 'What post-training actually changes in a model', ageH: 44, summary: 'A tour of instruction tuning, preference tuning and reinforcement learning, and which behaviours each stage is responsible for.' },
  ],
  'Latent Space': [
    { title: 'The year in AI engineering, in twelve charts', ageH: 96, summary: 'Context lengths, prices per million tokens, open-weight releases and the tools people actually adopted.' },
  ],

  // ---- Programming ----
  'Hacker News: programming': [
    { title: 'SQLite is not a toy database', domain: 'blog.sqlitefan.net', ageH: 7, score: 903, comments: 412, state: 'up',
      summary: 'Concurrency, durability and the workloads where a single file beats a database server.' },
    { title: 'I replaced our build system with a 200-line Makefile', domain: 'eng.smallteam.io', ageH: 18, score: 341, comments: 287,
      summary: 'Incremental builds, parallelism and readable rules, without plugins.' },
    { title: 'The surprising cost of a page fault', domain: 'perf.notes.dev', ageH: 40, score: 198, comments: 54, summary: 'Measuring minor and major faults on modern Linux, and why your benchmark might be timing the kernel.' },
  ],
  'Lobsters: programming': [
    { title: 'Writing a tiny regex engine in an afternoon', domain: 'lobste.rs', ageH: 11, summary: 'Thompson NFA construction in about 150 lines, with a test suite.' },
  ],
  'Julia Evans': [
    { title: 'Some things I learned about DNS caching', ageH: 22, state: 'saved',
      summary: 'TTLs, negative caching, and why the change you made an hour ago still has not shown up.',
      body: p('I made a DNS change last week and spent an hour confused about why it was not working. Here are some things I learned along the way.',
        '<h2>TTLs are a maximum, not a promise</h2>', 'A record with a TTL of 3600 can be cached for up to an hour. Resolvers are allowed to drop it sooner, and some do. But you can never count on it being dropped sooner.',
        '<h2>Negative answers are cached too</h2>', 'If you look up a name <em>before</em> creating it, the "this does not exist" answer gets cached. How long for is set by the SOA record, and it is often longer than you would guess.',
        '<h2>Checking what a resolver sees</h2>', '<pre><code>dig +noall +answer example.com @1.1.1.1</code></pre>', 'Asking a specific resolver directly is the fastest way to tell "my change is wrong" apart from "my change is cached".') },
    { title: 'A zine about how terminals work', ageH: 120, state: 'seen', summary: 'Escape codes, the pty, and what actually happens when you press Ctrl-C.' },
  ],

  // ---- Science ----
  'Quanta Magazine': [
    { title: 'Mathematicians find a simpler proof of an old tiling problem', ageH: 6,
      summary: 'A short new argument settles which shapes can tile the plane in only non-repeating ways, a question first asked decades ago.',
      body: p('For most shapes that tile the plane, the tiling eventually repeats: shift it the right distance and it lines up with itself. A rare few shapes tile only in patterns that never repeat.',
        'A new paper gives a much shorter proof of which shapes belong to that rare family. Where the original argument ran to dozens of pages of case analysis, the new one fits in eight.',
        '<blockquote>The key idea is to colour the tiles and track how the colours must propagate. Once you see it, the rest follows quickly.</blockquote>',
        'Researchers say the method may extend to tilings in three dimensions, where far less is known.') },
    { title: 'How cells decide when to divide', ageH: 30, summary: 'Size, time or a molecular clock? New experiments on yeast suggest the answer depends on what the cell has been eating.' },
  ],
  'Ars Technica: science': [
    { title: 'Spacecraft returns samples from a near-Earth asteroid', ageH: 12, summary: 'The capsule landed on schedule; scientists will spend the next year cataloguing what is inside.' },
    { title: 'A cheap sensor that detects crop disease before leaves change colour', ageH: 48, state: 'down', summary: 'The device measures gases released by stressed plants and costs less than a basic soil probe.' },
  ],
  'Nature: news': [
    { title: 'Global survey maps where insects are declining fastest', ageH: 20, summary: 'Data from thousands of sites show the steepest losses in areas of intensive farming.' },
    { title: 'Funding agencies agree common rules for sharing research data', ageH: 75, summary: 'Grant holders will have to deposit datasets in public repositories within a year of publication.' },
  ],

  // ---- UK news ----
  'BBC News: UK': [
    { title: 'Rail operators publish winter timetable changes', ageH: 2, summary: 'Some early-morning services will be reduced between December and February, while weekend capacity increases on busy routes.' },
    { title: 'Libraries report record use of free study spaces', ageH: 15, summary: 'Visits have risen sharply as students and remote workers look for warm, quiet places to work.' },
  ],
  'BBC News: Politics': [
    { title: 'What the new planning rules mean for home extensions', ageH: 8, summary: 'A guide to which projects still need permission and which can go ahead under permitted development.' },
  ],
  'The Guardian: UK news': [
    { title: 'Volunteers restore a canal towpath closed for a decade', ageH: 19, summary: 'The two-mile stretch reopens to walkers and cyclists after three years of weekend work parties.' },
  ],
  'Sky News: UK': [
    { title: 'Weather warning for strong winds across the south', ageH: 4, summary: 'Gusts of up to 60 mph are expected along exposed coasts, with possible disruption to ferries.' },
  ],
  'BBC News: Berkshire': [
    { title: 'New cycle lane planned for town centre route', ageH: 10, summary: 'The council says the protected lane will link the station with the university campus.' },
  ],
  'Reading Chronicle': [
    { title: 'Riverside park café to reopen in spring', ageH: 28, summary: 'The kiosk closed after flood damage last winter and has been rebuilt on raised foundations.' },
  ],
  'Bracknell News': [
    { title: 'Leisure centre pool reopens after refit', ageH: 60, state: 'seen', summary: 'The main pool has new changing rooms, a moveable floor and a learner pool for swimming lessons.' },
  ],

  // ---- Russian (YouTube) ----
  'Russian With Max': [
    { title: 'Verbs of motion explained without the headache', ageH: 16, summary: 'идти, ходить, ехать, ездить: when to use each, with lots of everyday examples.' },
    { title: 'Slow Russian: a morning in Moscow', ageH: 140, summary: 'An easy listening story with Russian and English subtitles.' },
  ],
  'Real Russian Club': [
    { title: '20 phrases you will hear in every Russian shop', ageH: 36, state: 'saved', summary: 'Пакет нужен? Картой или наличными? Learn the questions before you get to the till.' },
  ],

  // ---- Piano ----
  'Nahre Sol': [
    { title: 'One melody, five styles of accompaniment', ageH: 24, summary: 'Taking a simple tune through stride, Alberti bass, arpeggios, block chords and a gentle ostinato.' },
  ],
  'Josh Wright': [
    { title: 'The practice mistake that slows down most intermediate players', ageH: 58, summary: 'Why playing pieces through from the start every time holds you back, and what to do instead.' },
  ],
  'PianoTV': [
    { title: 'How to read ledger lines quickly', ageH: 31, summary: 'Landmark notes and interval reading, so you can stop counting lines one by one.',
      body: p('Ledger lines slow most readers down because we count them: one, two, three lines above the staff, so it must be… E?',
        'A faster approach is to learn a handful of landmark notes cold. High C, two ledger lines above the treble staff, is the most useful. From a landmark, read by interval: a step up, a skip down, and so on.',
        '<h2>A five-minute drill</h2>', '<ul><li>Pick one landmark note per week.</li><li>Find it on the staff and on the keyboard ten times without counting.</li><li>Then read short melodies that start from it.</li></ul>',
        'After a month you will have four or five landmarks, and most ledger-line notes are only a step or two from one of them.') },
  ],
  'Musicnotes blog': [
    { title: 'Ten easy pieces that sound harder than they are', ageH: 90, summary: 'Satisfying repertoire for late beginners, with notes on what each one teaches.' },
  ],

  // ---- Machine learning ----
  'Hacker News: machine learning': [
    { title: 'Gradient checkpointing, visualised', domain: 'ml-visuals.dev', ageH: 13, score: 230, comments: 41, summary: 'An interactive explainer of trading compute for memory during backpropagation.' },
  ],
  'Import AI': [
    { title: 'Robots that learn from watching videos', ageH: 38, summary: 'This week: a household robot trained mostly on online footage, a new benchmark for scientific reasoning, and more.' },
  ],
  'Google Research blog': [
    { title: 'Forecasting floods days in advance with a global model', ageH: 66, summary: 'How a river-level model trained on public gauge data extends warnings to places without local monitoring.' },
  ],
  'Two Minute Papers': [
    { title: 'This AI turns sketches into 3D scenes', ageH: 21, summary: 'A look at a new paper that builds editable 3D layouts from rough drawings.' },
  ],
  '3Blue1Brown (neural networks, transformers)': [
    { title: 'Attention in transformers, visually explained', ageH: 200, state: 'saved', summary: 'How queries, keys and values let each word update its meaning from the words around it.' },
  ],
  "Lilian Weng: Lil'Log": [
    { title: 'A survey of reward hacking in reinforcement learning', ageH: 110, summary: 'Examples, causes and mitigations when an agent optimises the measure instead of the goal.' },
  ],
  'Eugene Yan': [
    { title: 'Patterns for building evaluation sets you trust', ageH: 52, summary: 'Start small, label by hand, and grow the set from real failures.' },
  ],
};

/** Articles that a "Fetch now" adds, so refreshing visibly does something. Taken in order, per topic. */
export const FRESH = {
  AI: [
    { source: 'Hacker News: AI', title: 'Ask HN: What are you using local models for?', domain: 'news.ycombinator.com', score: 120, comments: 210,
      summary: 'Readers share the everyday jobs they hand to models running on their own machines.' },
    { source: 'Simon Willison', title: 'Quick note: a prompt that summarises long threads well', summary: 'The trick is to ask for the disagreements first, then the consensus.' },
  ],
  Science: [{ source: 'Quanta Magazine', title: 'Physicists measure gravity at the smallest scale yet', summary: 'A tabletop experiment detects the pull between two gold spheres the size of sand grains.' }],
  'UK news': [{ source: 'BBC News: UK', title: 'Post offices extend opening hours before Christmas', summary: 'Many branches will open on Sundays through December.' }],
  Programming: [{ source: 'Lobsters: programming', title: 'Why I still write shell scripts', domain: 'lobste.rs', summary: 'Small, boring, and still the quickest way to glue tools together.' }],
};

/** Saved practice cards (the Saved tab shows these alongside articles). payload is what the feed card held. */
export const SAVED_CARDS = [
  { topic: 'Piano practice', payload: { kind: 'prompt', generator: 'Practice prompts', text: 'Play a C major scale hands together, eyes closed, at a slow steady tempo.' } },
];

/** Flashcard progress: how many cards of each deck have been studied, and how many of those are due now. */
export const STUDY = { 'Russian core vocabulary': { studied: 24, dueNow: 9 } };

/** What the preview's Edge Function "reader" says for articles without a body. */
export const READ_FAILURE = 'The site blocked the reader (this is sample data with no article text).';
