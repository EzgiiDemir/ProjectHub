import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedTurn {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  usage?: { input: number; output: number };
}

export interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: {
    model: string;
    stream?: boolean;
    system?: { text: string }[];
    tools?: { name: string; eager_input_streaming?: boolean }[];
    messages: { role: string; content: unknown }[];
    [k: string]: unknown;
  };
}

/**
 * Minimal stand-in for the Anthropic Messages API (streaming only). Each request consumes the next
 * scripted turn and answers with the same server-sent event sequence the real API produces
 * (message_start → content blocks with text/input_json deltas → message_delta → message_stop),
 * so the official SDK, the provider adapter and the agent loop run unmodified.
 */
export async function startFakeAnthropic(script: ScriptedTurn[] | ((req: RecordedRequest, index: number) => ScriptedTurn)) {
  const requests: RecordedRequest[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as RecordedRequest['body'];
      const rec = { path: req.url ?? '', headers: req.headers, body };
      requests.push(rec);
      const turn = typeof script === 'function' ? script(rec, n) : script[n];
      n++;
      if (!turn || !req.url?.startsWith('/v1/messages')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'no scripted turn' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_${n}` });
      const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const usage = turn.usage ?? { input: 120, output: 40 };
      send('message_start', {
        message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1 } },
      });
      let index = 0;
      if (turn.text) {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        for (const chunk of turn.text.match(/.{1,12}/gsu) ?? []) send('content_block_delta', { index, delta: { type: 'text_delta', text: chunk } });
        send('content_block_stop', { index });
        index++;
      }
      for (const [i, call] of (turn.toolCalls ?? []).entries()) {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${n}_${i}`, name: call.name, input: {} } });
        const json = JSON.stringify(call.input);
        for (const part of json.match(/.{1,20}/gsu) ?? []) send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: part } });
        send('content_block_stop', { index });
        index++;
      }
      send('message_delta', { delta: { stop_reason: turn.stopReason ?? (turn.toolCalls?.length ? 'tool_use' : 'end_turn'), stop_sequence: null }, usage: { output_tokens: usage.output } });
      send('message_stop', {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
