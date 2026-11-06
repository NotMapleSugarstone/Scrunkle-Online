// 大厅：整个部署共用的一个对象，负责分配房间名和加入码。
// 它限制同时有效的加入码总数和按地址数量，也限制每日开放的房间数。
import { DurableObject } from 'cloudflare:workers';
import type { QueueReply } from '../../src/net/protocol';
import type { Env } from './env';

interface CodeEntry {
  room: string;
  build: string;
  expiresAt: number;
  by: string;
}
interface Day {
  date: string;
  rooms: number;
}

/** 加入码只需维持到所有人都加入。 */
const CODE_MS = 30 * 60 * 1000;
const MAX_CODES = 2000;
const CODES_PER_ADDRESS = 3;
const ROOMS_PER_DAY = 300;
/** 不含元音，也不含易混淆字符，使口头读出的加入码能按原样输入。 */
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function makeCode(): string {
  let out = '';
  for (const b of crypto.getRandomValues(new Uint8Array(6))) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export class Lobby extends DurableObject<Env> {
  private codes: Record<string, CodeEntry> = {};
  private day: Day = { date: '', rooms: 0 };
  private loaded = false;

  private async load(): Promise<void> {
    if (!this.loaded) {
      this.codes = (await this.ctx.storage.get<Record<string, CodeEntry>>('codes')) ?? {};
      this.day = (await this.ctx.storage.get<Day>('day')) ?? { date: '', rooms: 0 };
      this.loaded = true;
    }
    const now = Date.now();
    for (const [c, e] of Object.entries(this.codes)) if (e.expiresAt < now) delete this.codes[c];
  }

  async host(build: string, by: string): Promise<QueueReply> {
    await this.load();
    const live = Object.values(this.codes);
    if (live.length >= MAX_CODES) return { ok: false, reason: 'Too many rooms are open right now. Try again in a minute.' };
    if (live.filter((e) => e.by === by).length >= CODES_PER_ADDRESS) return { ok: false, reason: 'This address has three rooms open already. Use one, or wait for one to lapse.' };
    const today = new Date().toISOString().slice(0, 10);
    if (this.day.date !== today) this.day = { date: today, rooms: 0 };
    if (this.day.rooms >= (Number(this.env.ROOMS_PER_DAY) || ROOMS_PER_DAY)) return { ok: false, reason: 'The rooms are full for today. They open again at midnight UTC.' };
    this.day.rooms++;
    let code = makeCode();
    while (own(this.codes, code)) code = makeCode();
    const room = `room-${crypto.randomUUID()}`;
    this.codes[code] = { room, build, expiresAt: Date.now() + CODE_MS, by };
    await this.ctx.storage.put({ codes: this.codes, day: this.day });
    return { ok: true, room, code };
  }

  async join(code: string, build: string): Promise<QueueReply> {
    await this.load();
    const e = own(this.codes, code) ? this.codes[code] : null;
    if (!e) return { ok: false, reason: 'No room has that code. A code lasts 30 minutes.' };
    if (e.build !== build) return { ok: false, reason: 'That room runs a different version of the game. Everyone should reload the page.' };
    return { ok: true, room: e.room, code };
  }

  async cancel(code: string): Promise<void> {
    await this.load();
    if (own(this.codes, code)) {
      delete this.codes[code];
      await this.ctx.storage.put({ codes: this.codes });
    }
  }
}
