import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { acquire } from '../src/transport.mjs';
import { buildDelivery, sendAs2 } from '../src/as2-client.mjs';
import { parseMdn } from '../src/as2.mjs';

const waitFor = async (callback, tries = 100, gap = 30) => {
  for (let i = 0; i < tries; i += 1) {
    const value = await callback();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, gap));
  }
  throw new Error('condition_not_met');
};

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
// 前两次回执投递返回 503，第三次走真实 /receipts，演示退避重试不重复登记。
let receiptCalls = 0;
const service = await startService({
  source: provider.url, directory,
  retry: {
    baseDelayMs: 30, maxDelayMs: 120, maxAttempts: 6,
    deliver: async (url, mdn) => {
      receiptCalls += 1;
      if (receiptCalls <= 2) return { ok: false, status: 503, error: 'receipt_status_503' };
      const response = await fetch(url, { method: 'POST', body: mdn });
      return response.ok ? { ok: true, status: response.status }
        : { ok: false, status: response.status, error: `receipt_status_${response.status}` };
    },
  },
});
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());

  // 同步 AS2：MDN 在同一 HTTP 响应返回，原件已先落盘。
  const syncDelivery = await buildDelivery(provider.url, { acquire });
  const syncHeaders = Object.fromEntries(Object.entries(syncDelivery.headers)
    .filter(([key]) => !key.toLowerCase().startsWith('receipt-')
      && key !== 'Disposition-Notification-To' && key !== 'Disposition-Notification-Options'));
  syncHeaders['Message-ID'] = '<benefit-sync-demo@local.invalid>';
  const syncResponse = await sendAs2(`${service.url}/as2/inbox`,
    { ...syncDelivery, headers: syncHeaders });
  if (syncResponse.status !== 200) throw new Error(await syncResponse.text());
  console.log('同步 MDN', parseMdn(Buffer.from(await syncResponse.arrayBuffer())));

  // 异步 AS2：前两次回执投递返回 503，验证退避重试与单次登记。
  const asyncDelivery = await buildDelivery(provider.url, { acquire });
  asyncDelivery.headers['Message-ID'] = '<benefit-async-demo@local.invalid>';
  const accepted = await (await sendAs2(`${service.url}/as2/inbox`, asyncDelivery)).json();
  console.log('异步收件响应', accepted);
  const record = await waitFor(async () => {
    const current = await (await fetch(`${service.url}/as2/messages/${accepted.id}`)).json();
    return current.status === 'receipt-delivered' ? current : null;
  });
  console.log('收件状态与回执尝试', {
    id: record.id, messageId: record.messageId, status: record.status,
    mic: record.mic, digest: record.digest,
    attempts: record.receiptAttempts.map(attempt => ({
      attempt: attempt.attempt, httpStatus: attempt.httpStatus, status: attempt.status,
    })),
  });
  console.log('来源侧收到的 MDN 次数', (await (await fetch(`${provider.url}/_callbacks`)).json()).length);
  console.log('操作员总览', (await (await fetch(`${service.url}/as2/messages`)).json())
    .map(({ messageId, mode, status, mdnOutcome }) => ({ messageId, mode, status, mdnOutcome })));
} finally {
  await service.close();
  await provider.close();
  await rm(directory, { recursive: true, force: true });
}
