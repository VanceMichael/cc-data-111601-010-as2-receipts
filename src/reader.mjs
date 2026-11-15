import { createHash } from 'node:crypto';
export function mimeHeaders(bytes) {
  const split = bytes.indexOf('\r\n\r\n');
  if (split < 0) throw new Error('mime_header_separator');
  const text = bytes.subarray(0, split).toString('ascii');
  const headers = {};
  for (const line of text.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error('mime_header_line');
    const key = line.slice(0, colon).toLowerCase();
    (headers[key] ??= []).push(line.slice(colon + 1).trim());
  }
  return { headers, body: bytes.subarray(split + 4), bodyOffset: split + 4 };
}
export function inspect(bytes) {
  const parsed = mimeHeaders(bytes);
  if (!parsed.headers['content-type']) throw new Error('mime_content_type');
  return { kind: 'mime-document', headers: parsed.headers, bodyOffset: parsed.bodyOffset,
    bodyBytes: parsed.body.length, rawDigest: createHash('sha256').update(bytes).digest('hex') };
}
