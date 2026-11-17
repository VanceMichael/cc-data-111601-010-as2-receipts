import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';

const micOf = content => createHash('sha256').update(content).digest('base64');

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'as2-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory,
    as2: { id: 'benefit-inbox', partner: 'benefit-source' } });
  return { directory, provider, service,
    close: async () => { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); } };
}

async function entityBytes(provider, path) {
  return Buffer.from(await (await fetch(`${provider.url}${path}`)).arrayBuffer());
}

function as2Headers(metadata, overrides = {}) {
  return {
    'content-type': 'application/edi-x12',
    'as2-from': metadata.as2From,
    'as2-to': metadata.as2To,
    'message-id': metadata.messageId,
    'disposition-notification-to': metadata.as2From,
    'disposition-notification-options': 'signed-receipt-micalg=optional, sha-256',
    ...overrides,
  };
}

const postAs2 = (service, headers, entity) =>
  fetch(`${service.url}/as2`, { method: 'POST', headers, body: entity });

test('同步 MDN 按真实接收实体核对 MIC 与消息身份', async () => {
  const { provider, service, close } = await setup();
  try {
    const metadata = await (await fetch(`${provider.url}/delivery`)).json();
    const entity = await entityBytes(provider, metadata.entity);
    const response = await postAs2(service, as2Headers(metadata), entity);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^multipart\/report; report-type=disposition-notification/);
    const mdn = await response.text();
    assert.ok(mdn.includes(`Original-Message-ID: ${metadata.messageId}`));
    assert.ok(mdn.includes('Final-Recipient: rfc822; benefit-inbox'));
    assert.ok(mdn.includes('Disposition: automatic-action/MDN-sent-automatically; processed'));
    assert.ok(mdn.includes(`Received-content-MIC: ${micOf(Buffer.from('ISA*LOCAL-SYNTHETIC~\r\n'))}, sha-256`));
    const receptions = await (await fetch(`${service.url}/as2/receptions`)).json();
    assert.equal(receptions.length, 1);
    assert.equal(receptions[0].status, 'mdn-sent');
    assert.deepEqual(receptions[0].attempts.map(attempt => [attempt.mode, attempt.outcome]), [['sync', 'sent']]);
    const records = await (await fetch(`${service.url}/records`)).json();
    assert.equal(records.length, 1);
    assert.equal(receptions[0].recordId, records[0].id);
    assert.equal(receptions[0].digest, records[0].digest);
    const object = await fetch(`${service.url}/objects/${receptions[0].digest}`);
    assert.deepEqual(Buffer.from(await object.arrayBuffer()), entity);
  } finally { await close(); }
});

test('异步 MDN 投递，回执失败后重投不重复登记', async () => {
  const { provider, service, close } = await setup();
  try {
    const metadata = await (await fetch(`${provider.url}/delivery`)).json();
    const primary = await entityBytes(provider, '/primary');
    const base64 = await entityBytes(provider, '/base64');
    const first = await postAs2(service,
      as2Headers(metadata, { 'receipt-delivery-option': metadata.receiptUrl }), primary);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).mdn, 'sent');
    let callbacks = await (await fetch(`${provider.url}/_callbacks`)).json();
    assert.equal(callbacks.length, 1);
    const mdnBody = Buffer.from(callbacks[0].body, 'base64').toString();
    assert.ok(mdnBody.includes(`Original-Message-ID: ${metadata.messageId}`));
    assert.ok(mdnBody.includes(`Received-content-MIC: ${micOf(Buffer.from('ISA*LOCAL-SYNTHETIC~\r\n'))}, sha-256`));
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
    const secondHeaders = as2Headers(metadata,
      { 'message-id': '<benefit-002@local.invalid>', 'receipt-delivery-option': metadata.receiptUrl });
    assert.equal((await (await postAs2(service, secondHeaders, base64)).json()).mdn, 'failed');
    assert.equal((await (await postAs2(service, secondHeaders, base64)).json()).mdn, 'failed');
    let receptions = await (await fetch(`${service.url}/as2/receptions`)).json();
    assert.equal(receptions.length, 2);
    const second = receptions.find(reception => reception.messageId === '<benefit-002@local.invalid>');
    assert.equal(second.status, 'mdn-failed');
    assert.equal(second.attempts.length, 2);
    assert.ok(second.attempts.every(attempt => attempt.outcome === 'failed' && attempt.detail === 'receipt_status_503'));
    assert.equal((await (await fetch(`${service.url}/records`)).json()).length, 2);
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 0 }) });
    assert.equal((await (await postAs2(service, secondHeaders, base64)).json()).mdn, 'sent');
    receptions = await (await fetch(`${service.url}/as2/receptions`)).json();
    const recovered = receptions.find(reception => reception.messageId === '<benefit-002@local.invalid>');
    assert.equal(recovered.status, 'mdn-sent');
    assert.equal(recovered.attempts.length, 3);
    assert.equal((await (await fetch(`${service.url}/records`)).json()).length, 2);
    callbacks = await (await fetch(`${provider.url}/_callbacks`)).json();
    const lastMdn = Buffer.from(callbacks.at(-1).body, 'base64').toString();
    assert.ok(lastMdn.includes(`Received-content-MIC: ${micOf(Buffer.from('ISA*LOCAL-SYNTHETIC~'))}, sha-256`));
  } finally { await close(); }
});

test('同一消息号异内容判为冲突而非重投', async () => {
  const { provider, service, close } = await setup();
  try {
    const metadata = await (await fetch(`${provider.url}/delivery`)).json();
    const headers = as2Headers(metadata, { 'receipt-delivery-option': metadata.receiptUrl });
    assert.equal((await postAs2(service, headers, await entityBytes(provider, '/primary'))).status, 200);
    const conflicting = await entityBytes(provider, '/conflicting');
    const response = await postAs2(service, headers, conflicting);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'message_content_conflict');
    const receptions = await (await fetch(`${service.url}/as2/receptions`)).json();
    assert.equal(receptions.length, 1);
    assert.equal(receptions[0].conflicts.length, 1);
    assert.equal(receptions[0].conflicts[0].digest, createHash('sha256').update(conflicting).digest('hex'));
    assert.equal((await (await fetch(`${service.url}/records`)).json()).length, 1);
    assert.equal((await (await fetch(`${provider.url}/_callbacks`)).json()).length, 1);
  } finally { await close(); }
});

test('约定范围外的收件被拒绝且不产生登记', async () => {
  const { provider, service, close } = await setup();
  try {
    const metadata = await (await fetch(`${provider.url}/delivery`)).json();
    const entity = await entityBytes(provider, '/primary');
    const base = as2Headers(metadata);
    const cases = [
      [{ ...base, 'message-id': 'not-an-id' }, 'message_id_invalid'],
      [{ ...base, 'as2-to': 'someone-else' }, 'as2_to_mismatch'],
      [{ ...base, 'as2-from': 'stranger' }, 'as2_from_mismatch'],
      [{ ...base, 'receipt-delivery-option': 'https://example.invalid/receipts' }, 'outside_source'],
      [{ ...base, 'disposition-notification-options': 'signed-receipt-micalg=optional, md5' }, 'unsupported_mic_algorithm'],
      [{ ...base, 'content-type': 'text/plain' }, 'content_type_mismatch'],
    ];
    for (const [headers, error] of cases) {
      const response = await postAs2(service, headers, entity);
      assert.equal(response.status, 422, error);
      assert.equal((await response.json()).error, error);
    }
    for (const dropped of ['message-id', 'disposition-notification-to']) {
      const headers = { ...base }; delete headers[dropped];
      assert.equal((await postAs2(service, headers, entity)).status, 422, dropped);
    }
    const quotedPrintable = Buffer.from('Content-Type: application/edi-x12\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nISA*X~\r\n');
    assert.equal((await (await postAs2(service, base, quotedPrintable)).json()).error, 'unsupported_transfer_encoding');
    const badBase64 = Buffer.from('Content-Type: application/edi-x12\r\nContent-Transfer-Encoding: base64\r\n\r\n!!!\r\n');
    assert.equal((await (await postAs2(service, base, badBase64)).json()).error, 'invalid_base64');
    const plain = Buffer.from('Content-Type: text/plain\r\nContent-Transfer-Encoding: binary\r\n\r\nhello\r\n');
    const plainHeaders = { ...base, 'content-type': 'text/plain' };
    assert.equal((await (await postAs2(service, plainHeaders, plain)).json()).error, 'unsupported_content_type');
    assert.equal((await (await postAs2(service, base, Buffer.from('not mime'))).json()).error, 'mime_header_separator');
    assert.equal((await (await fetch(`${service.url}/records`)).json()).length, 0);
    assert.equal((await (await fetch(`${service.url}/as2/receptions`)).json()).length, 0);
  } finally { await close(); }
});

test('收件状态持久保存，重开后对应关系仍可查询', async () => {
  const { provider, service, directory, close } = await setup();
  try {
    const metadata = await (await fetch(`${provider.url}/delivery`)).json();
    await postAs2(service, as2Headers(metadata), await entityBytes(provider, '/primary'));
    const reopened = await new Store(directory).initialize();
    const receptions = await reopened.listReceptions();
    assert.equal(receptions.length, 1);
    assert.equal(receptions[0].recordId, (await reopened.list())[0].id);
    const detail = await fetch(`${service.url}/as2/receptions/${receptions[0].id}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).messageId, metadata.messageId);
    assert.equal((await fetch(`${service.url}/as2/receptions/nope`)).status, 404);
  } finally { await close(); }
});
