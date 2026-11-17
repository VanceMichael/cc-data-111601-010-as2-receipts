import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory,
  as2: { id: 'benefit-inbox', partner: 'benefit-source' } });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  const response = await fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  if (response.status !== 201) throw new Error(await response.text());
  console.log('接收结果', await response.json());
  const metadata = await (await fetch(`${provider.url}/delivery`)).json();
  const entity = Buffer.from(await (await fetch(`${provider.url}${metadata.entity}`)).arrayBuffer());
  const as2 = await fetch(`${service.url}/as2`, { method: 'POST', body: entity, headers: {
    'content-type': 'application/edi-x12',
    'as2-from': metadata.as2From,
    'as2-to': metadata.as2To,
    'message-id': metadata.messageId,
    'disposition-notification-to': metadata.as2From,
    'disposition-notification-options': 'signed-receipt-micalg=optional, sha-256',
    'receipt-delivery-option': metadata.receiptUrl,
  } });
  if (as2.status !== 200) throw new Error(await as2.text());
  console.log('AS2 异步收件', await as2.json());
  console.log('收件对应关系', await (await fetch(`${service.url}/as2/receptions`)).json());
  console.log('来源收到的回执数', (await (await fetch(`${provider.url}/_callbacks`)).json()).length);
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
