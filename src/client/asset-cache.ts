import { STORAGE_PREFIX } from '../game/page.ts';

/** 资源缓存代次；改变它会让图片和声音使用新的 URL，而不触碰游戏设置。 */
export const ASSET_CACHE_KEY = `${STORAGE_PREFIX}.assetVersion`;

export function assetCacheVersion(): string {
  try {
    return localStorage.getItem(ASSET_CACHE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 给资源 URL 附加当前缓存代次；空代次保持原来的地址。 */
export function assetCacheSuffix(): string {
  const version = assetCacheVersion();
  return version ? `?v=${encodeURIComponent(version)}` : '';
}

/** 像第一次运行一样重新获取图片和声音；保存、设置和回放不受影响。 */
export function resetAssetCache(): void {
  try {
    localStorage.setItem(ASSET_CACHE_KEY, String(Date.now()));
  } catch {
    // 存储可能被阻止，仍然刷新页面。
  }
  const reload = () => window.location.reload();
  if (typeof caches === 'undefined') {
    reload();
    return;
  }
  void caches.keys()
    .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
    .catch(() => {})
    .finally(reload);
}
