import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, mimeHeaders } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('MIME 原件摘要和正文跨度可复查',()=>{
  const result=inspect(primary);assert.equal(result.bodyBytes,primary.length-result.bodyOffset);
  assert.equal(result.rawDigest.length,64);assert.equal(mimeHeaders(primary).body.toString(),'ISA*LOCAL-SYNTHETIC~\r\n');
});
test('传输编码原声明与异文消息分开保留',async()=>{
  const encoded=inspect(await resource('/base64'));assert.equal(encoded.headers['content-transfer-encoding'][0],'base64');
  assert.notEqual(inspect(await resource('/conflicting')).rawDigest,inspect(primary).rawDigest);
});
test('缺 MIME 分隔和缺类型拒绝',()=>{
  assert.throws(()=>mimeHeaders(Buffer.from('Content-Type: text/plain')));
  assert.throws(()=>inspect(Buffer.from('X-A: b\r\n\r\nbody')));
});
