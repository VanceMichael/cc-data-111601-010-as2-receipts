// 联调客户端：按 docs/upstream.md 的约定，从来源 /delivery 元数据
// 与真实资源字节构造 AS2 HTTP 请求。不重新序列化 MIME 实体，
// 外层换行与 Content-Transfer-Encoding 均保持来源原样。
export async function buildDelivery(source, { fetchImpl = fetch, acquire } = {}) {
  if (!acquire) throw new Error('acquire_required');
  const metadataBytes = (await acquire(source, '/delivery')).bytes;
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  const entity = await acquire(source, metadata.entity);
  const headers = {
    'Content-Type': 'application/edi-x12',
    'AS2-Version': '1.1',
    'AS2-From': metadata.as2From,
    'AS2-To': metadata.as2To,
    'Message-ID': metadata.messageId,
  };
  if (metadata.receiptMode === 'async') {
    const receiptUrl = new URL(metadata.receiptUrl, source).href;
    headers['Disposition-Notification-To'] = metadata.as2From;
    headers['Receipt-Delivery-Option'] = receiptUrl;
    headers['Disposition-Notification-Options'] = `signed-receipt-protocol=not-required, optional; signed-receipt-micalg=not-required, ${metadata.micAlgorithm}`;
  }
  return { metadata, bytes: entity.bytes, headers, url: (path, base = source) => new URL(path, base).href };
}

export async function sendAs2(inboxUrl, delivery, { fetchImpl = fetch, override = {} } = {}) {
  return fetchImpl(inboxUrl, {
    method: 'POST',
    headers: { ...delivery.headers, ...override.headers },
    body: delivery.bytes,
  });
}
