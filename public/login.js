// Sign in with the platform's PocketBase (shared by every app on this origin), then swap its token for Sift's cookie.
const pb = new PocketBase(location.origin);
const status = document.getElementById('status');
const button = document.getElementById('google');
const SIGNED_OUT = 'sift-signed-out';

async function enter() {
  const res = await fetch('session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: pb.authStore.token }) });
  if (res.ok) { localStorage.removeItem(SIGNED_OUT); location.replace('./'); return; }
  throw new Error((await res.json()).message);
}
const failed = (e) => { status.textContent = e.message; button.disabled = false; };

button.addEventListener('click', () => {
  status.textContent = '';
  button.disabled = true;
  // Called straight from the click, so the browser lets the popup open.
  pb.collection('users').authWithOAuth2({ provider: 'google' }).then(enter).catch(failed);
});

// Already signed in to another app here: go straight in, unless you signed out of Sift.
if (pb.authStore.isValid && !localStorage.getItem(SIGNED_OUT)) {
  button.disabled = true;
  enter().catch(failed);
}
