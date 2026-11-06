// Worker 的绑定，以及每个请求都会访问的同一个大厅。
import type { Lobby } from './lobby';
import type { Room } from './room';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  LOBBY: DurableObjectNamespace<Lobby>;
  /** 允许使用房间的逗号分隔源；任意 localhost 端口也可以。 */
  ALLOWED_ORIGINS?: string;
  /** 大厅每个 UTC 日最多开放的房间数。 */
  ROOMS_PER_DAY?: string;
}

export function lobbyOf(env: Env): DurableObjectStub<Lobby> {
  return env.LOBBY.get(env.LOBBY.idFromName('lobby'));
}
