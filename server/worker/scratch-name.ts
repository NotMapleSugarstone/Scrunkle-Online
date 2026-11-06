// 在线名称是 Scratch 用户名。只有当 Scratch 账号确实拥有某名称时，房间才允许该名称，
// 并且绝不允许 Scratch 团队成员的用户名。编造的名称（`player` 加数字）会跳过检查。
import { isGeneratedName } from '../../src/net/protocol';

const USERS = 'https://api.scratch.mit.edu/users/';
const TIMEOUT_MS = 4000;

export type NameCheck = { ok: true; name: string; unchecked?: string } | { ok: false; reason: string; why: string };

/** 检查协议读取器已接受的名称。账号自身的大小写会替换输入名称的大小写。 */
export async function checkName(name: string): Promise<NameCheck> {
  if (isGeneratedName(name)) return { ok: true, name };
  let res: Response;
  try {
    res = await fetch(USERS + encodeURIComponent(name), {
      headers: { accept: 'application/json', 'user-agent': 'scrunkle-rooms' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // 无法访问账号服务时，在线游玩仍会继续。
    return { ok: true, name, unchecked: String(e) };
  }
  if (res.status === 404) {
    return { ok: false, why: 'no-account', reason: `There is no Scratch account named ${name}. Use your Scratch username, or a name like player1234.` };
  }
  if (!res.ok) return { ok: true, name, unchecked: `status ${res.status}` };
  const user = (await res.json().catch(() => null)) as { username?: unknown; scratchteam?: unknown } | null;
  if (user?.scratchteam === true) return { ok: false, why: 'scratch-team', reason: 'The names of Scratch Team members cannot be used.' };
  const own = typeof user?.username === 'string' && user.username.toLowerCase() === name.toLowerCase() ? user.username : name;
  return { ok: true, name: own };
}
