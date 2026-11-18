import { createHash, randomUUID } from 'node:crypto';

// 约定范围（docs/upstream.md）：未签名、未加密的单实体 AS2 消息，
// Content-Transfer-Encoding 仅 binary/7bit/8bit/base64，MIC 算法固定 sha-256。
// 本模块只解析真实收到的 MIME 字节，不重新序列化实体；原件按收到的字节持久化。

export const MIC_ALGORITHM = 'sha256';

export function parseMimeEntity(bytes) {
  const separator = bytes.indexOf(Buffer.from('\r\n\r\n'));
  if (separator < 0) throw new Error('mime_header_separator');
  const headerText = bytes.subarray(0, separator).toString('ascii');
  const headers = {};
  for (const line of headerText.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error('mime_header_line');
    const key = line.slice(0, colon).toLowerCase();
    (headers[key] ??= []).push(line.slice(colon + 1).trim());
  }
  if (!headers['content-type']) throw new Error('mime_content_type');
  return { headers, rawBody: bytes.subarray(separator + 4), headerLength: separator };
}

export function decodeContent(headers, rawBody) {
  const declared = (headers['content-transfer-encoding']?.[0] ?? 'binary').toLowerCase();
  if (declared === 'binary' || declared === '7bit' || declared === '8bit') {
    return { content: Buffer.from(rawBody), encoding: declared };
  }
  if (declared === 'base64') {
    const compact = rawBody.toString('ascii').replace(/\s+/g, '');
    if (compact.length === 0 || /[^A-Za-z0-9+/=]/.test(compact)) throw new Error('invalid_base64');
    return { content: Buffer.from(compact, 'base64'), encoding: 'base64' };
  }
  throw new Error('unsupported_transfer_encoding');
}

// RFC 4130 §7.3.1：未签名且未加密时，MIC 对传输解码后的消息内容计算，
// 不包含 MIME/RFC2822 头，也不做正文换行正规化。
export function computeMic(content, algorithm = MIC_ALGORITHM) {
  if (algorithm !== MIC_ALGORITHM) throw new Error('unsupported_mic_algorithm');
  return createHash('sha256').update(content).digest('base64');
}

function singleHeader(value, errorCode) {
  if (Array.isArray(value)) throw new Error(errorCode);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function describeAs2Message(rawEntity, httpHeaders) {
  const header = name => httpHeaders[String(name).toLowerCase()];
  const as2From = singleHeader(header('as2-from'), 'duplicate_as2_identity');
  const as2To = singleHeader(header('as2-to'), 'duplicate_as2_identity');
  const messageId = singleHeader(header('message-id'), 'duplicate_as2_identity');
  if (!as2From || !as2To || !messageId) throw new Error('as2_identity_required');
  const parsed = parseMimeEntity(rawEntity);
  const { content, encoding } = decodeContent(parsed.headers, parsed.rawBody);
  const mic = computeMic(content, MIC_ALGORITHM);
  // 原件摘要针对真实收到的完整 MIME 实体字节，与解码后内容上的 MIC 是两层依据。
  const digest = createHash('sha256').update(rawEntity).digest('hex');
  const receiptOption = singleHeader(header('receipt-delivery-option'), 'duplicate_receipt_option');
  const mode = receiptOption ? 'async' : 'sync';
  let receiptUrl = null;
  if (mode === 'async') {
    try { receiptUrl = new URL(receiptOption).href; } catch { throw new Error('invalid_receipt_delivery_option'); }
  }
  return {
    as2From, as2To, messageId, mode, receiptUrl,
    mic, micAlgorithm: MIC_ALGORITHM, digest,
    contentType: parsed.headers['content-type'][0],
    transferEncoding: encoding,
    bytes: rawEntity.length,
    contentBytes: content.length,
  };
}

export function newMdnMessageId() {
  return `<${randomUUID()}@as2-receipts.local>`;
}

// 未签名 MDN：multipart/report + message/disposition-notification。
// 无签名模式只表达接收处理结果，不构成发送方身份认证。
export function buildMdn({ record, outcome, explanation }) {
  if (outcome !== 'processed' && outcome !== 'failed') throw new Error('invalid_mdn_outcome');
  const boundary = `----=_as2-receipts_${randomUUID().replace(/-/g, '')}`;
  const human = outcome === 'processed'
    ? `The AS2 message has been received and persisted. Original-Message-ID: ${record.messageId}`
    : `The AS2 message could not be accepted: ${explanation ?? 'content mismatch on redelivery'}`;
  const notification = [
    'Reporting-UA: as2-receipts',
    `Original-Recipient: rfc822; ${record.as2To}`,
    `Final-Recipient: rfc822; ${record.as2To}`,
    `Original-Message-ID: ${record.messageId}`,
    `Disposition: automatic-action/MDN-sent-automatically; ${
      outcome === 'processed' ? 'processed' : 'failed/Failure: content-mismatch-on-redelivery'}`,
  ];
  if (outcome === 'processed') notification.push(`Received-content-MIC: ${record.mic}, ${record.micAlgorithm === 'sha256' ? 'sha-256' : record.micAlgorithm}`);
  const body = [
    `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    human,
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    '',
    notification.join('\r\n'),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Buffer.from(body, 'utf8');
}

export function mdnContentType(mdnBytes) {
  const split = mdnBytes.indexOf(Buffer.from('\r\n\r\n'));
  return mdnBytes.subarray(0, split).toString('ascii').slice('Content-Type: '.length);
}

// 解析收到的 MDN（联调自查与测试用），返回 disposition-notification 字段。
export function parseMdn(mdnBytes) {
  const parsed = parseMimeEntity(mdnBytes);
  const boundaryMatch = /boundary="([^"]+)"/.exec(parsed.headers['content-type'][0]);
  if (!boundaryMatch || !/multipart\/report/.test(parsed.headers['content-type'][0])) {
    throw new Error('mdn_not_multipart_report');
  }
  const parts = parsed.rawBody.toString('utf8').split(`--${boundaryMatch[1]}`);
  const notificationPart = parts.find(part => part.includes('message/disposition-notification'));
  if (!notificationPart) throw new Error('mdn_notification_part_missing');
  const fields = {};
  for (const line of notificationPart.split('\r\n\r\n')[1].split('\r\n')) {
    if (!line || line.startsWith('--')) continue;
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    fields[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return fields;
}
