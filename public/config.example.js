// Local use only: copy to public/config.js (gitignored). In production the deploy workflow writes config.js
// from the repository variables SUPABASE_URL and SUPABASE_ANON_KEY (see README).
// Both values are public by design: your data is protected by row level security and your login.
window.SIFT_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseKey: 'YOUR-ANON-OR-PUBLISHABLE-KEY',
};
