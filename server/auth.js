// Sign-in. The platform's PocketBase signs people in (Google); Sift checks that token once, then keeps its own signed,
// HttpOnly cookie. Only verified addresses listed in SIFT_EMAILS get in, checked again on every request.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const COOKIE = 'sift_session';
const MAX_AGE = 90 * 86400;

export function sessionSecret(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function createAuth({ secret, emails, pbUrl, fetchImpl = fetch }) {
  const allowed = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const sign = (text) => createHmac('sha256', secret).update(text).digest('base64url');
  const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/sift/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
  return {
    /** The signed-in user, or null. */
    identify(request) {
      const value = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(request.headers.get('cookie') ?? '')?.[1];
      const [body, mac] = String(value ?? '').split('.');
      if (!body || !mac) return null;
      const want = Buffer.from(sign(body)), got = Buffer.from(mac);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
      const { email, exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
      return exp > Date.now() / 1000 && allowed.has(email) ? { email } : null;
    },
    /** Swap a PocketBase `users` token for a Sift cookie. */
    async signIn(token) {
      if (typeof token !== 'string' || !token) return { status: 401, error: 'Not signed in' };
      const res = await fetchImpl(`${pbUrl}/api/collections/users/auth-refresh`, { method: 'POST', headers: { Authorization: token }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return { status: 401, error: 'Not signed in' };
      const { record } = await res.json();
      const email = String(record?.email ?? '').toLowerCase();
      // Anyone can register with PocketBase under any address, so an unverified one proves nothing.
      if (!record?.verified || !allowed.has(email)) return { status: 403, error: `${email || 'This account'} hasn't been given access to Sift.` };
      const body = Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + MAX_AGE })).toString('base64url');
      return { status: 200, cookie: cookie(`${body}.${sign(body)}`, MAX_AGE) };
    },
    signedOut: cookie('', 0),
  };
}
