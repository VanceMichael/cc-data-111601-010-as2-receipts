import { buildMdn, newMdnMessageId } from './as2.mjs';

// 异步 MDN 投递：独立 POST 到消息声明的 Receipt-Delivery-Option。
// 同一份原件只登记一次；每次 HTTP 尝试单独留痕，失败按退避重试，
// 服务重启后对未送达记录恢复投递，操作员可手动 redrive。
// 冲突消息的失败 MDN 走同一投递通道，留痕的 outcome 为 failed。
export class ReceiptDelivery {
  constructor({ store, allowedOrigins, baseDelayMs = 50, maxDelayMs = 1000, maxAttempts = 8,
    deliver = defaultDeliver, now = () => Date.now() } = {}) {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) throw new Error('allowed_origins_required');
    this.store = store;
    this.allowedOrigins = allowedOrigins;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxAttempts = maxAttempts;
    this.deliver = deliver;
    this.now = now;
    this.outcomes = new Map();
    this.timers = new Set();
    this.closed = false;
  }

  assertAllowed(receiptUrl) {
    let target;
    try { target = new URL(receiptUrl); } catch { throw new Error('invalid_receipt_delivery_option'); }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('receipt_origin_not_allowed');
    if (!this.allowedOrigins.includes(target.origin)) throw new Error('receipt_origin_not_allowed');
  }

  delayFor(attempt) {
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
  }

  enqueue(record, outcome = 'processed') {
    if (this.closed || record.mode !== 'async') return;
    this.outcomes.set(record.id, outcome);
    this.schedule(record.id, this.baseDelayMs);
  }

  schedule(id, delay) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.run(id);
    }, delay);
    timer.unref?.();
    this.timers.add(timer);
  }

  async run(id) {
    if (this.closed) return;
    const record = await this.store.get(id);
    if (!record) return;
    this.assertAllowed(record.receiptUrl);
    const outcome = this.outcomes.get(id) ?? record.mdnOutcome ?? 'processed';
    const epoch = record.runEpoch ?? 0;
    const cycleAttempts = record.receiptAttempts.filter(entry => entry.epoch === epoch).length;
    const attempt = cycleAttempts + 1;
    const startedAt = new Date(this.now()).toISOString();
    const mdn = buildMdn({ record, outcome });
    let result;
    try {
      result = await this.deliver(record.receiptUrl, mdn, record, newMdnMessageId());
    } catch (error) {
      result = { ok: false, status: 0, error: error.message };
    }
    const entry = {
      epoch,
      attempt,
      maxAttempts: this.maxAttempts,
      at: startedAt,
      url: record.receiptUrl,
      status: result.ok ? 'delivered' : 'failed',
      httpStatus: result.status,
      error: result.error ?? null,
    };
    const updated = await this.store.recordAttempt(id, entry, outcome);
    if (updated.status === 'receipt-delivered') {
      this.outcomes.delete(id);
      return;
    }
    if (attempt >= this.maxAttempts) {
      // 本轮投递额度耗尽：搁置但不改变可重试语义，等待 redrive 或重启恢复。
      this.outcomes.delete(id);
      return;
    }
    this.schedule(id, this.delayFor(attempt));
  }

  // 服务重启后恢复所有未送达的异步消息，已留下的历史尝试次数继续沿用。
  async recover() {
    const pending = await this.store.findPending();
    for (const record of pending) {
      try { this.assertAllowed(record.receiptUrl); } catch { continue; }
      this.outcomes.set(record.id, record.mdnOutcome ?? 'processed');
      const epoch = record.runEpoch ?? 0;
      const cycleAttempts = record.receiptAttempts.filter(entry => (entry.epoch ?? 0) === epoch).length;
      if (cycleAttempts >= this.maxAttempts) continue; // 本轮已耗尽，等待 redrive 开启新周期
      this.schedule(record.id, cycleAttempts > 0 ? this.delayFor(cycleAttempts) : this.baseDelayMs);
    }
    return pending.length;
  }

  async redrive(id) {
    const record = await this.store.redrive(id);
    this.outcomes.set(id, record.mdnOutcome ?? 'processed');
    this.schedule(id, this.baseDelayMs);
    return record;
  }

  async close() {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.outcomes.clear();
  }
}

async function defaultDeliver(url, mdn, record, mdnMessageId) {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: {
      'Content-Type': 'multipart/report; report-type=disposition-notification',
      'AS2-Version': '1.1',
      'AS2-From': record.as2To,
      'AS2-To': record.as2From,
      'Message-ID': mdnMessageId,
      'Original-Message-ID': record.messageId,
    },
    body: mdn,
  });
  if (response.ok) return { ok: true, status: response.status };
  return { ok: false, status: response.status, error: `receipt_status_${response.status}` };
}
