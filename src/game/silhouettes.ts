import type { Runtime } from '../engine/runtime.ts';
import type { MaskSet } from '../engine/masks.ts';

/** 为每个带遮罩造型的皮肤提供打包遮罩。 */
export function installSilhouettes(rt: Runtime, set: MaskSet): void {
  for (const sprite of rt.sprites) {
    const list = set[sprite.name];
    if (!list) continue;
    sprite.costumes.forEach((c, i) => {
      if (list[i]) rt.render.packed[c.skin] = list[i];
    });
  }
}
