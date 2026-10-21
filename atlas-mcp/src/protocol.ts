/**
 * Minimal MCP JSON-RPC 2.0 server core (tools only), shared by the stdio and streamable-HTTP
 * entries. No SDK dependency: initialize, notifications/initialized, ping, tools/list,
 * tools/call. The principal is fixed by the transport before any message is handled.
 */
import {SERVER_INFO, type AtlasMcp} from './tools.ts';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'Atlas (Rhys AI), Phase A, read-only. Start with whoami. Use list_tasks / get_task / get_draft for the task board, search_calls to find a call and ask_call to answer from one call with verified quotes. Nothing here creates, assigns, approves or sends anything.';

type Rpc = {jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown};
const error = (id: unknown, code: number, message: string) => ({jsonrpc: '2.0', id: id ?? null, error: {code, message}});

/** Returns the response object, or null for notifications. Never throws. */
export async function handleMessage(server: AtlasMcp, principal: string, transport: 'http' | 'stdio', msg: unknown): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return error(null, -32600, 'Invalid request (batches are not supported).');
  const m = msg as Rpc;
  const isNotification = !('id' in m);
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return isNotification ? null : error(m.id, -32600, 'Invalid request.');
  if (!isNotification && !(typeof m.id === 'string' || (typeof m.id === 'number' && Number.isFinite(m.id)))) return error(null, -32600, 'Invalid id.');
  if (isNotification) return null; // notifications/initialized, cancelled, etc.: nothing to do
  const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>;
  switch (m.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {jsonrpc: '2.0', id: m.id, result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: {tools: {listChanged: false}}, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS,
      }};
    }
    case 'ping': return {jsonrpc: '2.0', id: m.id, result: {}};
    case 'tools/list': return {jsonrpc: '2.0', id: m.id, result: {tools: server.toolsFor(principal)}};
    case 'tools/call': {
      if (typeof params.name !== 'string') return error(m.id, -32602, 'Tool name required.');
      const r = await server.callTool(principal, params.name, params.arguments ?? {}, transport);
      return {jsonrpc: '2.0', id: m.id, result: {content: [{type: 'text', text: JSON.stringify(r.structured, null, 1)}], structuredContent: r.structured, isError: r.isError}};
    }
    default: return error(m.id, -32601, 'Method not found.');
  }
}
