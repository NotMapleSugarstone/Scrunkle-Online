import type { CostumeDef, SkinDef, SoundDef } from '../engine/defs.ts';
import data from './assets-data.json' with { type: 'json' };

const table = data as unknown as { skins: SkinDef[]; costumes: CostumeDef[][]; sounds: SoundDef[][] };

export const skins: SkinDef[] = table.skins;

export function costumes(targetIndex: number): CostumeDef[] {
  return table.costumes[targetIndex];
}

export const allCostumes: readonly CostumeDef[][] = table.costumes;

/** 任意角色中第一个使用此名称的造型的皮肤，或 -1。 */
export function skinOf(costume: string): number {
  for (const list of table.costumes) for (const c of list) if (c.name === costume) return c.skin;
  return -1;
}

export function sounds(targetIndex: number): SoundDef[] {
  return table.sounds[targetIndex];
}
