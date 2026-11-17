import { createHash, randomUUID } from 'node:crypto';
import { inspect } from './reader.mjs';

// 联调约定子集见 docs/upstream.md：未签名、未加密，MIC 算法 sha-256。
export const AGREED_CONTENT_TYPE = 'application/edi-x12';
export const AGREED_MIC_ALGORITHM = 'sha-256';

export function messageIdentity(headers) {
  const from = headers['as2-from'];
  const to = headers['as2-to'];
  const messageId = headers['message-id'];
  if (typeof from !== 'string' || from.trim() === '') throw new Error('as2_from_required');
  if (typeof to !== 'string' || to.trim() === '') throw new Error('as2_to_required');
  if (typeof messageId !== 'string' || !/^<[^<>\r\n]+>$/.test(messageId.trim())) {
    throw new Error('message_id_invalid');
  }
  const notify = headers['disposition-notification-to'];
  if (typeof notify !== 'string' || notify.trim() === '') throw new Error('notification_to_required');
  return { from: from.trim(), to: to.trim(), messageId: messageId.trim() };
}

export function micAlgorithm(headers) {
  const options = headers['disposition-notification-options'];
  if (options === undefined) return AGREED_MIC_ALGORITHM;
  const match = /signed-receipt-micalg\s*=\s*(?:optional|required)\s*,([^;]+)/i.exec(options);
  const offered = match ? match[1].split(',').map(token => token.trim().toLowerCase()) : [];
  if (offered.some(token => token.replace('-', '') === 'sha256')) return AGREED_MIC_ALGORITHM;
  throw new Error('unsupported_mic_algorithm');
}

export function examine(entity, outerContentType) {
  const parsed = inspect(entity);
  const entityType = parsed.headers['content-type'][0].split(';')[0].trim().toLowerCase();
  if (entityType !== AGREED_CONTENT_TYPE) throw new Error('unsupported_content_type');
  if (typeof outerContentType !== 'string' || outerContentType.trim() === '') {
    throw new Error('content_type_required');
  }
  if (outerContentType.split(';')[0].trim().toLowerCase() !== entityType) {
    throw new Error('content_type_mismatch');
  }
  const declared = parsed.headers['content-transfer-encoding'];
  if (!declared) throw new Error('transfer_encoding_required');
  const encoding = declared[0].trim().toLowerCase();
  const body = entity.subarray(parsed.bodyOffset);
  let content;
  if (encoding === 'binary') {
    content = body;
  } else if (encoding === 'base64') {
    const text = body.toString('ascii').replace(/\s+/g, '');
    if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('invalid_base64');
    content = Buffer.from(text, 'base64');
  } else {
    throw new Error('unsupported_transfer_encoding');
  }
  // RFC 4130 §7.3.1：未签名消息的 MIC 对传输解码后的内容计算，不含 MIME 头；
  // 二进制内容不做换行正规化，直接取实际接收的字节，不重新序列化。
  return { parsed, content, mic: createHash('sha256').update(content).digest('base64'),
    micAlgorithm: AGREED_MIC_ALGORITHM };
}

export function buildMdn({ messageId, recipient, mic, micAlgorithm }) {
  const boundary = `as2-mdn-${randomUUID()}`;
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=us-ascii',
    '',
    `The message ${messageId} addressed to ${recipient} was received and stored.`,
    'Unsigned exchange: the MIC verifies content integrity only and does not authenticate the sender.',
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    '',
    'Reporting-UA: as2-receipts',
    `Original-Message-ID: ${messageId}`,
    `Final-Recipient: rfc822; ${recipient}`,
    'Disposition: automatic-action/MDN-sent-automatically; processed',
    `Received-content-MIC: ${mic}, ${micAlgorithm}`,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { contentType: `multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
    body: Buffer.from(body, 'ascii') };
}
