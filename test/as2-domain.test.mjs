import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  parseMimeEntity, decodeContent, computeMic, describeAs2Message,
  buildMdn, parseMdn, MIC_ALGORITHM,
} from '../src/as2.mjs';

const primary = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
const base64Entity = await readFile(new URL('../fixtures/resource-03.bin', import.meta.url));
const conflictEntity = await readFile(new URL('../fixtures/resource-02.bin', import.meta.url));
const httpHeaders = {
  'as2-from': 'benefit-source', 'as2-to': 'benefit-inbox',
  'message-id': '<benefit-001@local.invalid>', 'as2-version': '1.1',
};

test('按真实 MIME 实体解析，保留原始字节与外层 CRLF，不重新序列化', () => {
  const parsed = parseMimeEntity(primary);
  assert.equal(parsed.headers['content-type'][0], 'application/edi-x12');
  assert.equal(parsed.headers['content-transfer-encoding'][0], 'binary');
  assert.deepEqual(parsed.rawBody, Buffer.from('ISA*LOCAL-SYNTHETIC~\r\n'));
  assert.equal(primary.length, parsed.headerLength + 4 + parsed.rawBody.length);
});

test('MIC 只覆盖传输解码后的消息内容，与原件摘要是两层依据', () => {
  const parsed = parseMimeEntity(primary);
  const { content } = decodeContent(parsed.headers, parsed.rawBody);
  const mic = computeMic(content);
  const expected = createHash('sha256').update(Buffer.from('ISA*LOCAL-SYNTHETIC~\r\n')).digest('base64');
  assert.equal(mic, expected);
  const descriptor = describeAs2Message(primary, httpHeaders);
  assert.equal(descriptor.mic, expected);
  assert.equal(descriptor.micAlgorithm, MIC_ALGORITHM);
  assert.equal(descriptor.digest, createHash('sha256').update(primary).digest('hex'));
  assert.notEqual(descriptor.mic, descriptor.digest);
});

test('base64 传输编码经解码计算 MIC，实体本身保持原样', () => {
  const descriptor = describeAs2Message(base64Entity, httpHeaders);
  assert.equal(descriptor.transferEncoding, 'base64');
  const decodedMic = createHash('sha256')
    .update(Buffer.from('SVNBKkxPQ0FMLVNZTlRIRVRJQ34=', 'base64')).digest('base64');
  assert.equal(descriptor.mic, decodedMic);
  assert.equal(descriptor.digest, createHash('sha256').update(base64Entity).digest('hex'));
  // 同内容不同传输编码：MIC 相同，原件摘要不同。
  const binaryDescriptor = describeAs2Message(primary, httpHeaders);
  assert.notEqual(binaryDescriptor.digest, descriptor.digest);
  const decodedBinary = createHash('sha256')
    .update(Buffer.from('ISA*LOCAL-SYNTHETIC~\r\n')).digest('base64');
  assert.notEqual(decodedBinary, decodedMic);
});

test('同消息号不同内容可在描述层区分：MIC 与摘要均不一致', () => {
  const first = describeAs2Message(primary, httpHeaders);
  const second = describeAs2Message(conflictEntity, httpHeaders);
  assert.equal(first.messageId, second.messageId);
  assert.notEqual(first.digest, second.digest);
  assert.notEqual(first.mic, second.mic);
});

test('异步声明由 Receipt-Delivery-Option 识别，非法来源头与重复身份头被拒绝', () => {
  const asyncHeaders = {
    ...httpHeaders,
    'disposition-notification-to': 'benefit-source',
    'receipt-delivery-option': 'http://127.0.0.1:9/r' + 'eceipts',
  };
  const descriptor = describeAs2Message(primary, asyncHeaders);
  assert.equal(descriptor.mode, 'async');
  assert.equal(descriptor.receiptUrl, 'http://127.0.0.1:9/receipts');
  assert.equal(describeAs2Message(primary, httpHeaders).mode, 'sync');
  assert.throws(() => describeAs2Message(primary, { ...httpHeaders, 'as2-from': ['a', 'b'] }),
    /duplicate_as2_identity/);
  assert.throws(() => describeAs2Message(primary, { 'as2-to': 'x' }), /as2_identity_required/);
  assert.throws(() => describeAs2Message(primary, {
    ...httpHeaders, 'receipt-delivery-option': 'not a url',
  }), /invalid_receipt_delivery_option/);
});

test('未签名 MDN 携带消息身份与处理结果，失败 MDN 不声称 MIC', () => {
  const descriptor = describeAs2Message(primary, httpHeaders);
  const record = { ...descriptor, id: 'rec-1' };
  const processed = buildMdn({ record, outcome: 'processed' });
  const fields = parseMdn(processed);
  assert.equal(fields['original-message-id'], record.messageId);
  assert.match(fields.disposition, /processed$/);
  assert.equal(fields['received-content-mic'], `${record.mic}, sha-256`);
  const failed = parseMdn(buildMdn({ record, outcome: 'failed' }));
  assert.match(failed.disposition, /failed\/Failure: content-mismatch-on-redelivery/);
  assert.equal(failed['received-content-mic'], undefined);
});

test('畸形实体与不支持的传输编码被拒绝', () => {
  assert.throws(() => parseMimeEntity(Buffer.from('Content-Type: text/plain')), /mime_header_separator/);
  assert.throws(() => describeAs2Message(Buffer.from('X-A: b\r\n\r\nbody'), httpHeaders),
    /mime_content_type/);
  const quoted = Buffer.from('Content-Type: application/edi-x12\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nx=20');
  assert.throws(() => describeAs2Message(quoted, httpHeaders), /unsupported_transfer_encoding/);
  const badBase64 = Buffer.from('Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n@@@\r\n');
  assert.throws(() => describeAs2Message(badBase64, httpHeaders), /invalid_base64/);
});
