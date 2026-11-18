import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { As2Store } from '../src/as2-store.mjs';
import { acquire } from '../src/transport.mjs';
import { buildDelivery, sendAs2 } from '../src/as2-client.mjs';
import { parseMdn } from '../src/as2.mjs';

async function setup({ receiptOrigins, deliver, retry = { baseDelayMs: 20, maxDelayMs: 80, maxAttempts: 5 } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'as2-test-'));
  const provider = await startProvider();
  const service = await startService({
    source: provider.url, directory, receiptOrigins,
    ...(deliver ? { retry: { ...retry, deliver } } : { retry }),
  });
  return {
    directory, provider, service,
    cleanup: async () => {
      await service.close();
      await provider.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// 确定性投递器：前 failTimes 次返回 503，之后走消息声明的真实回执地址。
function flakyDeliver({ failTimes } = {}) {
  let calls = 0;
  return async (url, mdn) => {
    calls += 1;
    if (calls <= failTimes) return { ok: false, status: 503, error: 'receipt_status_503' };
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/report; report-type=disposition-notification' },
      body: mdn,
    });
    return response.ok ? { ok: true, status: response.status }
      : { ok: false, status: response.status, error: `receipt_status_${response.status}` };
  };
}

async function deliveryFor(source, entityPath, override = {}) {
  const metadataBytes = (await acquire(source, '/delivery')).bytes;
  const metadata = { ...JSON.parse(metadataBytes.toString('utf8')), entity: entityPath, ...override };
  const entity = await acquire(source, metadata.entity);
  const headers = {
    'Content-Type': 'application/edi-x12',
    'AS2-Version': '1.1',
    'AS2-From': metadata.as2From,
    'AS2-To': metadata.as2To,
    'Message-ID': metadata.messageId,
  };
  if (metadata.receiptMode === 'async') {
    headers['Disposition-Notification-To'] = metadata.as2From;
    headers['Receipt-Delivery-Option'] = new URL(metadata.receiptUrl, source).href;
  }
  return { metadata, bytes: entity.bytes, headers };
}

async function waitFor(callback, { tries = 100, gap = 30 } = {}) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    last = await callback();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, gap));
  }
  throw new Error(`condition_not_met: ${JSON.stringify(last)}`);
}

test('同步 AS2：原件先持久化，MDN 按真实实体核对 MIC 与消息身份', async () => {
  const { directory, provider, service, cleanup } = await setup();
  try {
    const delivery = await deliveryFor(provider.url, '/primary', { receiptMode: 'sync' });
    const response = await sendAs2(`${service.url}/as2/inbox`, delivery);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /multipart\/report/);
    const mdnBytes = Buffer.from(await response.arrayBuffer());
    const fields = parseMdn(mdnBytes);
    assert.equal(fields['original-message-id'], delivery.metadata.messageId);
    assert.match(fields.disposition, /processed$/);
    const expectedMic = createHash('sha256')
      .update(Buffer.from('ISA*LOCAL-SYNTHETIC~\r\n')).digest('base64');
    assert.equal(fields['received-content-mic'], `${expectedMic}, sha-256`);
    const [record] = await (await fetch(`${service.url}/as2/messages`)).json();
    assert.equal(record.mode, 'sync');
    assert.equal(record.status, 'received');
    assert.equal(record.mdnOutcome, 'synchronous:processed');
    assert.equal(record.receiptAttempts[0].mode, 'sync');
    // 原件字节与落地对象一致，未被重新序列化。
    const stored = Buffer.from(await (await fetch(`${service.url}/as2/objects/${record.digest}`)).arrayBuffer());
    assert.deepEqual(stored, delivery.bytes);
    assert.deepEqual(stored, await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
    assert.equal(record.digest, createHash('sha256').update(delivery.bytes).digest('hex'));
  } finally { await cleanup(); }
});

test('同一消息号完全重投不重复登记，且再次返回 MDN', async () => {
  const { provider, service, cleanup } = await setup();
  try {
    const delivery = await deliveryFor(provider.url, '/primary', { receiptMode: 'sync' });
    const first = await sendAs2(`${service.url}/as2/inbox`, delivery);
    const second = await sendAs2(`${service.url}/as2/inbox`, delivery);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.match(second.headers.get('content-type'), /multipart\/report/);
    const messages = await (await fetch(`${service.url}/as2/messages`)).json();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].receiptAttempts.length, 2);
  } finally { await cleanup(); }
});

test('同一消息号内容变化不是重投：拒绝覆盖并返回失败 MDN，冲突留痕', async () => {
  const { provider, service, cleanup } = await setup();
  try {
    const first = await deliveryFor(provider.url, '/primary', { receiptMode: 'sync' });
    const changed = await deliveryFor(provider.url, '/conflicting', { receiptMode: 'sync' });
    assert.equal((await sendAs2(`${service.url}/as2/inbox`, first)).status, 200);
    const response = await sendAs2(`${service.url}/as2/inbox`, changed);
    assert.equal(response.status, 200);
    const fields = parseMdn(Buffer.from(await response.arrayBuffer()));
    assert.match(fields.disposition, /content-mismatch-on-redelivery/);
    assert.equal(fields['received-content-mic'], undefined);
    const messages = await (await fetch(`${service.url}/as2/messages`)).json();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].conflicts.length, 1);
    assert.notEqual(messages[0].conflicts[0].receivedDigest, messages[0].digest);
    assert.equal(messages[0].mdnOutcome, 'synchronous:failed');
  } finally { await cleanup(); }
});

test('异步通道下同消息号内容变化：不覆盖原件，失败 MDN 经独立通道投递并留痕', async () => {
  const { provider, service, cleanup } = await setup();
  try {
    const first = await deliveryFor(provider.url, '/primary');
    const changed = await deliveryFor(provider.url, '/conflicting');
    assert.equal((await sendAs2(`${service.url}/as2/inbox`, first)).status, 200);
    assert.equal((await sendAs2(`${service.url}/as2/inbox`, changed)).status, 200);
    const messages = await waitFor(async () => {
      const current = await (await fetch(`${service.url}/as2/messages`)).json();
      return current.length === 1 && current[0].receiptAttempts.length === 2 ? current : null;
    });
    assert.equal(messages[0].conflicts.length, 1);
    assert.equal(messages[0].status, 'receipt-delivered');
    assert.equal(messages[0].mdnOutcome, 'failed');
    const callbacks = await (await fetch(`${provider.url}/_callbacks`)).json();
    assert.equal(callbacks.length, 2);
    const failureMdn = parseMdn(Buffer.from(callbacks.at(-1).body, 'base64'));
    assert.match(failureMdn.disposition, /content-mismatch-on-redelivery/);
    assert.equal(failureMdn['received-content-mic'], undefined);
    // 落地原件仍是首条消息的字节，冲突内容未覆盖。
    const stored = Buffer.from(await (await fetch(`${service.url}/as2/objects/${messages[0].digest}`)).arrayBuffer());
    assert.deepEqual(stored, first.bytes);
  } finally { await cleanup(); }
});

test('异步 MDN：先落盘再投递，前两次 503 触发退避重试，最终送达且只登记一次', async () => {
  const { provider, service, cleanup } = await setup({ deliver: flakyDeliver({ failTimes: 2 }) });
  try {
    const delivery = await buildDelivery(provider.url, { acquire });
    assert.equal(delivery.metadata.receiptMode, 'async');
    const response = await sendAs2(`${service.url}/as2/inbox`, delivery);
    assert.equal(response.status, 200);
    const accepted = await response.json();
    assert.equal(accepted.receipt, 'asynchronous');
    const messages = await (await fetch(`${service.url}/as2/messages`)).json();
    assert.equal(messages.length, 1);
    const record = await waitFor(async () => {
      const current = await (await fetch(`${service.url}/as2/messages/${accepted.id}`)).json();
      return current.status === 'receipt-delivered' ? current : null;
    });
    assert.equal(record.status, 'receipt-delivered');
    assert.equal(record.receiptAttempts.length, 3);
    assert.equal(record.receiptAttempts[0].httpStatus, 503);
    assert.equal(record.receiptAttempts[1].httpStatus, 503);
    assert.equal(record.receiptAttempts.at(-1).status, 'delivered');
    const callbacks = await (await fetch(`${provider.url}/_callbacks`)).json();
    assert.equal(callbacks.length, 1);
    const lastMdn = parseMdn(Buffer.from(callbacks.at(-1).body, 'base64'));
    assert.equal(lastMdn['original-message-id'], delivery.metadata.messageId);
    assert.match(lastMdn.disposition, /processed$/);
    // 重投同样内容：不产生第二条登记，只增加一次回执投递。
    const attemptsBefore = record.receiptAttempts.length;
    await sendAs2(`${service.url}/as2/inbox`, delivery);
    await waitFor(async () => {
      const current = await (await fetch(`${service.url}/as2/messages/${accepted.id}`)).json();
      return current.receiptAttempts.length > attemptsBefore ? current : null;
    });
    assert.equal((await (await fetch(`${service.url}/as2/messages`)).json()).length, 1);
  } finally { await cleanup(); }
});

test('base64 实体按原字节落地，MIC 按解码内容核对', async () => {
  const { provider, service, cleanup } = await setup();
  try {
    const delivery = await deliveryFor(provider.url, '/base64', { receiptMode: 'sync' });
    delete delivery.headers['Receipt-Delivery-Option'];
    const response = await sendAs2(`${service.url}/as2/inbox`, delivery);
    assert.equal(response.status, 200);
    const fields = parseMdn(Buffer.from(await response.arrayBuffer()));
    const expectedMic = createHash('sha256')
      .update(Buffer.from('SVNBKkxPQ0FMLVNZTlRIRVRJQ34=', 'base64')).digest('base64');
    assert.equal(fields['received-content-mic'], `${expectedMic}, sha-256`);
    const [record] = await (await fetch(`${service.url}/as2/messages`)).json();
    assert.equal(record.transferEncoding, 'base64');
    const stored = Buffer.from(await (await fetch(`${service.url}/as2/objects/${record.digest}`)).arrayBuffer());
    assert.deepEqual(stored, delivery.bytes);
  } finally { await cleanup(); }
});

test('Receipt-Delivery-Option 跨源被拒绝且不登记；畸形请求不产生记录', async () => {
  const { provider, service, cleanup } = await setup();
  try {
    const delivery = await deliveryFor(provider.url, '/primary');
    delivery.headers['Receipt-Delivery-Option'] = 'http://foreign.example.invalid/receipts';
    const rejected = await sendAs2(`${service.url}/as2/inbox`, delivery);
    assert.equal(rejected.status, 422);
    assert.match((await rejected.text()), /receipt_origin_not_allowed/);
    const missingIdentity = await fetch(`${service.url}/as2/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/edi-x12', 'AS2-From': 'a', 'AS2-To': 'b' },
      body: delivery.bytes,
    });
    assert.equal(missingIdentity.status, 422);
    assert.deepEqual(await (await fetch(`${service.url}/as2/messages`)).json(), []);
  } finally { await cleanup(); }
});

test('本轮重试额度耗尽后搁置且不丢记录，操作员 redrive 重新投递成功', async () => {
  const { provider, service, cleanup } = await setup({
    retry: { baseDelayMs: 10, maxDelayMs: 20, maxAttempts: 3 },
    deliver: (() => {
      let fail = true;
      const fn = async (url, mdn) => {
        if (fail) return { ok: false, status: 503, error: 'receipt_status_503' };
        const response = await fetch(url, { method: 'POST', body: mdn });
        return response.ok ? { ok: true, status: response.status }
          : { ok: false, status: response.status, error: `receipt_status_${response.status}` };
      };
      fn.setHealthy = () => { fail = false; };
      return fn;
    })(),
  });
  try {
    const delivery = await buildDelivery(provider.url, { acquire });
    const accepted = await (await sendAs2(`${service.url}/as2/inbox`, delivery)).json();
    const stalled = await waitFor(async () => {
      const current = await (await fetch(`${service.url}/as2/messages/${accepted.id}`)).json();
      return current.receiptAttempts.length === 3 ? current : null;
    });
    assert.equal(stalled.status, 'receipt-retrying');
    assert.equal(stalled.receiptAttempts.every(attempt => attempt.status === 'failed'), true);
    service.receipts.deliver.setHealthy();
    const redriven = await fetch(`${service.url}/as2/messages/${accepted.id}/redrive`, { method: 'POST' });
    assert.equal(redriven.status, 202);
    await waitFor(async () => {
      const current = await (await fetch(`${service.url}/as2/messages/${accepted.id}`)).json();
      return current.status === 'receipt-delivered' ? current : null;
    });
    const record = await (await fetch(`${service.url}/as2/messages/${accepted.id}`)).json();
    assert.equal(record.runEpoch, 1);
    assert.equal(record.receiptAttempts.at(-1).status, 'delivered');
    assert.equal(record.receiptAttempts.at(-1).epoch, 1);
    assert.equal(record.receiptAttempts.at(-1).attempt, 1);
    assert.equal(record.receiptAttempts.length, 4);
  } finally { await cleanup(); }
});

test('服务重启后恢复未送达的异步 MDN；耗尽周期由 redrive 开启新周期，历史保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'as2-restart-'));
  const provider = await startProvider();
  let service = await startService({
    source: provider.url, directory,
    retry: { baseDelayMs: 10, maxDelayMs: 20, maxAttempts: 3,
      deliver: async () => ({ ok: false, status: 503, error: 'receipt_status_503' }) },
  });
  try {
    const delivery = await buildDelivery(provider.url, { acquire });
    const accepted = await (await sendAs2(`${service.url}/as2/inbox`, delivery)).json();
    await waitFor(async () => {
      const current = await (await fetch(`${service.url}/as2/messages/${accepted.id}`)).json();
      return current.receiptAttempts.length === 3 ? current : null;
    });
    await service.close();

    // 重启后：本轮周期已耗尽，记录仍保留且不会自行冲过额度上限。
    service = await startService({
      source: provider.url, directory,
      retry: { baseDelayMs: 10, maxDelayMs: 20, maxAttempts: 3 },
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    let current = await (await fetch(`${service.url}/as2/messages/${accepted.id}`)).json();
    assert.equal(current.receiptAttempts.length, 3);
    assert.notEqual(current.status, 'receipt-delivered');

    // 操作员 redrive 开启新投递周期（epoch 递增），新周期走真实回执地址并送达。
    const redriven = await fetch(`${service.url}/as2/messages/${accepted.id}/redrive`, { method: 'POST' });
    assert.equal(redriven.status, 202);
    await waitFor(async () => {
      const latest = await (await fetch(`${service.url}/as2/messages/${accepted.id}`)).json();
      return latest.status === 'receipt-delivered' ? latest : null;
    });
    const reopened = await new As2Store(directory).initialize();
    const [record] = await reopened.list();
    assert.equal(record.runEpoch, 1);
    assert.equal(record.receiptAttempts.length, 4);
    assert.deepEqual(record.receiptAttempts.map(entry => entry.epoch), [0, 0, 0, 1]);
    assert.equal(record.receiptAttempts.at(-1).status, 'delivered');
    assert.deepEqual(await reopened.object(record.digest), delivery.bytes);
    await service.close();
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
