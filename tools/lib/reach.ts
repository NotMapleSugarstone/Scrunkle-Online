// 判断 Scratch 项目中哪些脚本可能运行。
import type { Target } from './sb3-patch.ts';

type Block = Target['blocks'][string];
const isBlock = (b: unknown): b is Block => !!b && !Array.isArray(b) && typeof b === 'object';
export const HATS = new Set(['event_whenflagclicked', 'event_whenkeypressed', 'event_whenthisspriteclicked', 'event_whenstageclicked',
  'event_whenbackdropswitchesto', 'event_whengreaterthan', 'event_whenbroadcastreceived', 'control_start_as_clone', 'procedures_definition',
  'event_whentouchingobject']);

/**
 * 项目可发送的每条消息的小写名称。运行时计算的广播可发送项目持有的任意文本，
 * 因此只要存在这种广播，每个列表项、变量值和文本字面量都算已发送。
 */
export function sentMessages(targets: Target[]): Set<string> {
  const sent = new Set<string>();
  let computed = false;
  for (const t of targets) {
    for (const b of Object.values(t.blocks)) {
      if (!isBlock(b) || !b.opcode.startsWith('event_broadcast')) continue;
      const v = b.inputs.BROADCAST_INPUT;
      if (v?.[0] === 1 && Array.isArray(v[1])) sent.add(String(v[1][1]).toLowerCase());
      else computed = true;
    }
  }
  if (computed) {
    for (const t of targets) {
      for (const [, items] of Object.values(t.lists)) for (const v of items) sent.add(String(v).toLowerCase());
      for (const [, v] of Object.values(t.variables)) sent.add(String(v).toLowerCase());
      for (const b of Object.values(t.blocks)) {
        if (!isBlock(b)) continue;
        for (const v of Object.values(b.inputs)) if (Array.isArray(v[1]) && v[1][0] === 10) sent.add(String(v[1][1]).toLowerCase());
      }
    }
  }
  return sent;
}

export interface DeadScript { top: string; kind: 'no hat' | 'message never sent' | 'procedure never called'; what: string }

/** 目标中永远无法运行的顶层脚本：没有帽子的堆栈、无人发送消息的接收器，以及没有活动脚本调用的过程。 */
export function deadScripts(t: Target, sent: Set<string>): DeadScript[] {
  const dead: DeadScript[] = [];
  const definitions = new Map<string, string>();
  const live: string[] = [];
  for (const [id, b] of Object.entries(t.blocks)) {
    if (!isBlock(b)) { if (Array.isArray(b)) dead.push({ top: id, kind: 'no hat', what: String(b[1]) }); continue; }
    if (!b.topLevel) continue;
    if (!HATS.has(b.opcode)) dead.push({ top: id, kind: 'no hat', what: b.opcode });
    else if (b.opcode === 'procedures_definition') definitions.set(String((t.blocks[b.inputs.custom_block[1] as string] as Block).mutation!.proccode), id);
    else if (b.opcode === 'event_whenbroadcastreceived' && !sent.has(String(b.fields.BROADCAST_OPTION[0]).toLowerCase())) dead.push({ top: id, kind: 'message never sent', what: String(b.fields.BROADCAST_OPTION[0]) });
    else live.push(id);
  }
  // 过程在活动脚本调用时变为活动，因此跟随调用直到不再出现新过程。
  const reached = new Set<string>();
  const calls = (top: string): string[] => {
    const out: string[] = [];
    const visit = (id: string | null, chain: boolean) => {
      for (; id; id = chain ? (t.blocks[id] as Block).next : null) {
        const b = t.blocks[id] as Block;
        if (b.opcode === 'procedures_call') out.push(String(b.mutation!.proccode));
        for (const [name, v] of Object.entries(b.inputs)) {
          if (typeof v[1] === 'string' && isBlock(t.blocks[v[1]])) visit(v[1], name.startsWith('SUBSTACK'));
        }
      }
    };
    visit(top, true);
    return out;
  };
  const work = [...live];
  while (work.length) {
    for (const proc of calls(work.pop()!)) {
      if (reached.has(proc) || !definitions.has(proc)) continue;
      reached.add(proc);
      work.push(definitions.get(proc)!);
    }
  }
  for (const [proc, id] of definitions) if (!reached.has(proc)) dead.push({ top: id, kind: 'procedure never called', what: proc });
  return dead;
}
