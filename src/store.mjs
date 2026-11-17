import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    for (const name of ['index', 'as2']) {
      try { await this.load(name); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await this.save(name, []);
      }
    }
    return this;
  }
  async save(name, value) {
    const temporary = join(this.directory, `${name}-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, join(this.directory, `${name}.json`));
  }
  async load(name) {
    return JSON.parse(await readFile(join(this.directory, `${name}.json`), 'utf8'));
  }
  serialized(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  async saveIndex(records) { return this.save('index', records); }
  async list() { return this.load('index'); }
  async listReceptions() { return this.load('as2'); }
  async saveReceptions(receptions) { return this.save('as2', receptions); }
  async reception(id) {
    const found = (await this.listReceptions()).find(reception => reception.id === id);
    if (!found) throw new Error('reception_not_found');
    return found;
  }
  async persistObject(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const records = await this.list();
    const existing = records.find(record => record.digest === digest && record.source === source);
    if (existing) return existing;
    await writeFile(join(this.directory, 'objects', digest), bytes);
    const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
    records.push(record);
    await this.saveIndex(records);
    return record;
  }
  async accept(bytes, source, parsed) {
    return this.serialized(() => this.persistObject(bytes, source, parsed));
  }
  async acceptReception({ identity, digest, mic, micAlgorithm, bytes, parsed }) {
    return this.serialized(async () => {
      const receptions = await this.listReceptions();
      const existing = receptions.find(reception => reception.messageId === identity.messageId
        && reception.from === identity.from && reception.to === identity.to);
      if (existing) {
        if (existing.digest !== digest) {
          existing.conflicts.push({ at: new Date().toISOString(), digest });
          await this.saveReceptions(receptions);
          return { outcome: 'conflict', reception: existing };
        }
        return { outcome: 'duplicate', reception: existing };
      }
      const record = await this.persistObject(bytes, `as2:${identity.from}`, parsed);
      const reception = { id: randomUUID(), messageId: identity.messageId, from: identity.from,
        to: identity.to, digest, mic, micAlgorithm, recordId: record.id,
        receivedAt: new Date().toISOString(), status: 'received', attempts: [], conflicts: [] };
      receptions.push(reception);
      await this.saveReceptions(receptions);
      return { outcome: 'accepted', reception };
    });
  }
  async recordAttempt(receptionId, attempt) {
    return this.serialized(async () => {
      const receptions = await this.listReceptions();
      const reception = receptions.find(candidate => candidate.id === receptionId);
      if (!reception) throw new Error('reception_not_found');
      reception.attempts.push({ at: new Date().toISOString(), ...attempt });
      reception.status = reception.attempts.some(entry => entry.outcome === 'sent') ? 'mdn-sent' : 'mdn-failed';
      await this.saveReceptions(receptions);
      return reception;
    });
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
}
