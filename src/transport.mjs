export function resolveSameOrigin(base, path) {
  const origin = new URL(base);
  const target = new URL(path, origin);
  if (target.origin !== origin.origin) throw new Error('outside_source');
  return target;
}

export async function acquire(base, path, headers = {}) {
  const target = resolveSameOrigin(base, path);
  const response = await fetch(target, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`source_status_${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('source_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return { bytes: Buffer.concat(chunks), headers: Object.fromEntries(response.headers), status: response.status };
}

export async function deliver(base, path, { contentType, body }) {
  const target = resolveSameOrigin(base, path);
  const response = await fetch(target, { method: 'POST',
    headers: { 'content-type': contentType }, body,
    redirect: 'error', signal: AbortSignal.timeout(5000) });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`receipt_status_${response.status}`);
  return { status: response.status };
}
