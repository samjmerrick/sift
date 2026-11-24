// Entry point of the live artifact build: loads your data from the personal database, then starts the real app.
// Imports run in order, so ./setup.js has finished (or failed, which stops here) before app.js starts.
import './setup.js';
import '../public/app.js';
