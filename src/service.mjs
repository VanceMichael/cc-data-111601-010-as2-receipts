import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { As2Store } from './as2-store.mjs';
import { ReceiptDelivery } from './receipt-delivery.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { describeAs2Message, buildMdn, mdnContentType } from './as2.mjs';
import { startProvider } from './provider.mjs';

const MAX_BODY = 8 * 1024 * 1024;

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function startService({ source, directory, port = 0,
  receiptOrigins, retry = {}, now } = {}) {
  const store = await new Store(directory).initialize();
  const as2Store = await new As2Store(directory).initialize();
  const allowedOrigins = receiptOrigins ?? [new URL(source).origin];
  const receipts = new ReceiptDelivery({ store: as2Store, allowedOrigins, now, ...retry });
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
      if (url.pathname.startsWith('/as2/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await as2Store.object(url.pathname.slice('/as2/objects/'.length)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = JSON.parse((await readBody(request)).toString());
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      // AS2 收件：按真实接收的 MIME 实体核对 MIC 与消息身份，原件先持久化再回执。
      if (url.pathname === '/as2/inbox' && request.method === 'POST') {
        const rawEntity = await readBody(request);
        const descriptor = describeAs2Message(rawEntity, request.headers);
        if (descriptor.mode === 'async') receipts.assertAllowed(descriptor.receiptUrl);
        const { record, result } = await as2Store.accept(descriptor, rawEntity);
        if (descriptor.mode === 'sync') {
          const outcome = result === 'conflict' ? 'failed' : 'processed';
          const mdn = buildMdn({ record, outcome });
          await as2Store.noteSyncOutcome(record.id, outcome);
          response.statusCode = 200;
          response.setHeader('Content-Type', mdnContentType(mdn));
          response.setHeader('AS2-Version', '1.1');
          return response.end(mdn);
        }
        // 异步：先确认已持久落盘，再由独立通道投递 MDN；重投只复用记录，不重复登记。
        receipts.enqueue(record, result === 'conflict' ? 'failed' : 'processed');
        response.statusCode = 200;
        return response.end(JSON.stringify({
          id: record.id, messageId: record.messageId,
          status: 'accepted', receipt: 'asynchronous', redelivery: result !== 'created',
        }));
      }
      if (url.pathname === '/as2/messages' && request.method === 'GET') {
        return response.end(JSON.stringify(await as2Store.list()));
      }
      if (url.pathname.startsWith('/as2/messages/') && request.method === 'GET') {
        const record = await as2Store.get(url.pathname.slice('/as2/messages/'.length));
        if (!record) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        return response.end(JSON.stringify(record));
      }
      if (url.pathname.startsWith('/as2/messages/') && url.pathname.endsWith('/redrive') && request.method === 'POST') {
        const id = url.pathname.slice('/as2/messages/'.length, -'/redrive'.length);
        const record = await receipts.redrive(id);
        response.statusCode = 202;
        return response.end(JSON.stringify(record));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) {
      response.statusCode = 422;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  await receipts.recover();
  return {
    server, store, as2Store, receipts,
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await receipts.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = process.env.SOURCE_URL ? null : await startProvider();
  const source = process.env.SOURCE_URL ?? provider.url;
  const receiptOrigins = process.env.RECEIPT_ORIGINS
    ? process.env.RECEIPT_ORIGINS.split(',').map(value => value.trim()).filter(Boolean) : undefined;
  let service;
  try {
    service = await startService({
      source,
      directory: process.env.DATA_DIR ?? './data',
      port: Number(process.env.PORT ?? 4102),
      receiptOrigins,
      retry: {
        baseDelayMs: Number(process.env.RETRY_BASE_MS ?? 50),
        maxDelayMs: Number(process.env.RETRY_MAX_MS ?? 5000),
        maxAttempts: Number(process.env.RETRY_MAX_ATTEMPTS ?? 8),
      },
    });
  } catch (error) {
    if (provider) await provider.close();
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    if (provider) await provider.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  console.log(JSON.stringify({ product: service.url, source }));
}
