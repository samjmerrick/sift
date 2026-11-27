// Talks to bee-database over its MCP endpoint with a service token, the same way Nibble does.
// One MCP session is kept open and re-opened if bee-database restarts.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Errors that mean the call never ran (stale session, nothing listening), so it is safe to send again. */
const neverRan = (e) => (e instanceof StreamableHTTPError && (e.code === 404 || e.code === 400))
  || e?.cause?.code === 'ECONNREFUSED' || e?.message === 'Not connected';

export function createDbClient({ url = mcpUrl(), token = process.env.DB_TOKEN } = {}) {
  if (!token) throw new Error('Set DB_TOKEN (bee-database\'s MCP_API_TOKEN, or another admin token)');
  let connecting = null;

  function connect() {
    connecting ||= (async () => {
      const client = new Client({ name: 'sift', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    })().catch((e) => { connecting = null; throw e; });
    return connecting;
  }
  async function close() {
    const c = connecting;
    connecting = null;
    try { await (await c)?.close(); } catch { /* already gone */ }
  }

  // One call at a time: bee-database shares one SQLite connection between its tool threads, and overlapping
  // calls from one client can fail there.
  let tail = Promise.resolve();
  function call(tool, args = {}) {
    const next = tail.then(() => send(tool, args, true));
    tail = next.catch(() => {});
    return next;
  }

  async function send(tool, args, retry) {
    let res;
    try {
      res = await (await connect()).callTool({ name: tool, arguments: args }, undefined, { timeout: 30000 });
    } catch (e) {
      await close();
      if (retry && neverRan(e)) return send(tool, args, false);
      throw new Error(`The database didn't answer (${e.message}).`);
    }
    const text = (res.content || []).map((c) => c.text || '').join('');
    if (res.isError) throw new Error(text || 'Database error');
    const out = res.structuredContent;
    if (out !== undefined) return out && Object.keys(out).join() === 'result' ? out.result : out;
    try { return JSON.parse(text); } catch { return text; }
  }

  return { call, close };
}

export const dbUrl = () => (process.env.DB_URL || 'http://mcp-db:8000').replace(/\/$/, '');
export const mcpUrl = () => process.env.DB_MCP_URL || `${dbUrl()}/mcp/db`;
