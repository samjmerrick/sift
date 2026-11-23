// Entry point of the preview build: sets up the in-memory backend and sample data, then starts the real app.
// Imports run in order, so ./setup.js has finished (and wrapped supabase.createClient) before app.js starts.
import './setup.js';
import '../public/app.js';
