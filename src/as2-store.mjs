import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// AS2 收件存储：原件先持久落盘（writeFile + rename 完成后才返回），调用方才允许回执；
// 身份键为 (as2From, as2To, messageId)。同一消息号内容变化属于冲突，
// 不会覆盖或重复登记；完全相同的原件重投复用同一记录。
export class As2Store {
  constructor(directory) {
    this.directory = directory;
    this.objectsDir = join(directory, 'as2-objects');
    this.indexPath = join(directory, 'as2-messages.json');
    this.pending = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.objectsDir, { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    return this;
  }

  async saveIndex(messages) {
    const temporary = join(this.directory, `as2-messages-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(messages));
    await rename(temporary, this.indexPath);
  }

  async list() {
    return JSON.parse(await readFile(this.indexPath, 'utf8'));
  }

  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.objectsDir, digest));
  }

  // descriptor 来自 as2.mjs 的 describeAs2Message；rawEntity 是真实收到的字节。
  // 返回 { record, result }，result 为 created / duplicate / conflict。
  accept(descriptor, rawEntity) {
    const operation = this.pending.then(async () => {
      const messages = await this.list();
      const sameIdentity = messages.find(message =>
        message.as2From === descriptor.as2From && message.as2To === descriptor.as2To
        && message.messageId === descriptor.messageId);
      if (sameIdentity) {
        if (sameIdentity.digest === descriptor.digest) {
          return { record: sameIdentity, result: 'duplicate' };
        }
        const conflict = {
          messageId: descriptor.messageId, at: new Date().toISOString(),
          receivedDigest: descriptor.digest, storedDigest: sameIdentity.digest,
          mic: descriptor.mic,
        };
        sameIdentity.conflicts ??= [];
        sameIdentity.conflicts.push(conflict);
        sameIdentity.updatedAt = conflict.at;
        await this.saveIndex(messages);
        return { record: sameIdentity, result: 'conflict', conflict };
      }
      // 先写原件（wx：同名对象必须已是同一字节内容），再更新索引，杜绝先回执后落盘。
      await writeFile(join(this.objectsDir, descriptor.digest), rawEntity, { flag: 'wx' })
        .catch(error => { if (error.code !== 'EEXIST') throw error; });
      const now = new Date().toISOString();
      const record = {
        id: randomUUID(),
        as2From: descriptor.as2From,
        as2To: descriptor.as2To,
        messageId: descriptor.messageId,
        digest: descriptor.digest,
        mic: descriptor.mic,
        micAlgorithm: descriptor.micAlgorithm,
        contentType: descriptor.contentType,
        transferEncoding: descriptor.transferEncoding,
        bytes: descriptor.bytes,
        contentBytes: descriptor.contentBytes,
        mode: descriptor.mode,
        receiptUrl: descriptor.receiptUrl,
        status: descriptor.mode === 'async' ? 'receipt-pending' : 'received',
        mdnOutcome: null,
        runEpoch: 0,
        receiptAttempts: [],
        conflicts: [],
        createdAt: now,
        updatedAt: now,
      };
      messages.push(record);
      await this.saveIndex(messages);
      return { record, result: 'created' };
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async get(id) {
    const messages = await this.list();
    return messages.find(message => message.id === id) ?? null;
  }

  async findPending() {
    const messages = await this.list();
    return messages.filter(message => message.mode === 'async' && message.status !== 'receipt-delivered');
  }

  // 登记一次异步回执尝试，并推进状态；attempt 由 receipt-delivery 构造。
  recordAttempt(id, attempt, outcome) {
    const operation = this.pending.then(async () => {
      const messages = await this.list();
      const record = messages.find(message => message.id === id);
      if (!record) throw new Error('message_not_found');
      record.receiptAttempts.push(attempt);
      if (attempt.status === 'delivered') {
        record.status = 'receipt-delivered';
        record.mdnOutcome = outcome;
      } else {
        // 未送达始终保持可重试状态；仅由重试调度上限决定是否暂时搁置，
        // 重启恢复或操作员 redrive 后仍可继续，原尝试链完整保留。
        record.status = 'receipt-retrying';
      }
      record.updatedAt = new Date().toISOString();
      await this.saveIndex(messages);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  // 同步 MDN 不经过独立 HTTP 投递，也在尝试链中留痕，便于操作员核对对应关系。
  noteSyncOutcome(id, outcome) {
    const operation = this.pending.then(async () => {
      const messages = await this.list();
      const record = messages.find(message => message.id === id);
      if (!record) throw new Error('message_not_found');
      record.receiptAttempts.push({
        attempt: record.receiptAttempts.length + 1,
        at: new Date().toISOString(),
        mode: 'sync',
        status: outcome === 'processed' ? 'delivered' : 'failed',
        httpStatus: 200,
        error: outcome === 'processed' ? null : 'content-mismatch-on-redelivery',
      });
      // 同步通道本身已送达（HTTP 响应内返回），outcome 描述处理结果。
      record.mdnOutcome = `synchronous:${outcome}`;
      record.updatedAt = new Date().toISOString();
      await this.saveIndex(messages);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  // 操作员手动重投：完整保留历史尝试链，开启新一轮投递周期并重置本轮计数。
  async redrive(id) {
    const messages = await this.list();
    const record = messages.find(message => message.id === id);
    if (!record) throw new Error('message_not_found');
    if (record.mode !== 'async') throw new Error('not_async_message');
    if (record.status === 'receipt-delivered') throw new Error('receipt_already_delivered');
    record.runEpoch = (record.runEpoch ?? 0) + 1;
    record.updatedAt = new Date().toISOString();
    await this.saveIndex(messages);
    return record;
  }
}
