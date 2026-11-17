import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire, deliver, resolveSameOrigin } from './transport.mjs';
import { inspect } from './reader.mjs';
import { messageIdentity, micAlgorithm, examine, buildMdn } from './as2.mjs';

export async function startService({ source, directory, port = 0, as2 = {} }) {
  const local = { id: as2.id ?? 'benefit-inbox', partner: as2.partner ?? null };
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/as2/receptions' && request.method === 'GET') {
        return response.end(JSON.stringify(await store.listReceptions()));
      }
      if (url.pathname.startsWith('/as2/receptions/') && request.method === 'GET') {
        const id = decodeURIComponent(url.pathname.slice('/as2/receptions/'.length));
        const found = (await store.listReceptions()).find(reception => reception.id === id);
        if (!found) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        return response.end(JSON.stringify(found));
      }
      if (url.pathname === '/as2' && request.method === 'POST') {
        const chunks = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 8 * 1024 * 1024) throw new Error('request_too_large');
          chunks.push(chunk);
        }
        const entity = Buffer.concat(chunks);
        const identity = messageIdentity(request.headers);
        if (identity.to !== local.id) throw new Error('as2_to_mismatch');
        if (local.partner && identity.from !== local.partner) throw new Error('as2_from_mismatch');
        micAlgorithm(request.headers);
        const examined = examine(entity, request.headers['content-type']);
        const receiptOption = request.headers['receipt-delivery-option'];
        const receiptTarget = receiptOption === undefined ? null : resolveSameOrigin(source, receiptOption).href;
        // 先持久保存原件与收件记录，再发送任何回执。
        const { outcome, reception } = await store.acceptReception({ identity,
          digest: examined.parsed.rawDigest, mic: examined.mic, micAlgorithm: examined.micAlgorithm,
          bytes: entity, parsed: examined.parsed });
        if (outcome === 'conflict') {
          response.statusCode = 409;
          return response.end(JSON.stringify({ error: 'message_content_conflict', reception: reception.id }));
        }
        const mdn = buildMdn({ messageId: identity.messageId, recipient: local.id,
          mic: examined.mic, micAlgorithm: examined.micAlgorithm });
        if (receiptTarget) {
          let attempt;
          try {
            const delivered = await deliver(source, receiptTarget, mdn);
            attempt = { mode: 'async', target: receiptTarget, outcome: 'sent', detail: `status_${delivered.status}` };
          } catch (error) {
            attempt = { mode: 'async', target: receiptTarget, outcome: 'failed', detail: error.message };
          }
          const updated = await store.recordAttempt(reception.id, attempt);
          return response.end(JSON.stringify({ reception: updated.id, status: updated.status, mdn: attempt.outcome }));
        }
        await store.recordAttempt(reception.id, { mode: 'sync', outcome: 'sent' });
        response.setHeader('Content-Type', mdn.contentType);
        return response.end(mdn.body);
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const chunks = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 16384) throw new Error('request_too_large');
          chunks.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102),
    as2: { id: process.env.AS2_ID ?? 'benefit-inbox', partner: process.env.AS2_PARTNER ?? null } });
  console.log(JSON.stringify({ product: service.url }));
}
