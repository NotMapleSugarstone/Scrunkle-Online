import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** 决定模拟行为的每个文件的哈希，使结果可能不同的两个构建永远不会共用一个房间。 */
function buildFingerprint(): string {
  const hash = createHash('sha256');
  const walk = (dir: string, files = /\.(ts|json)$/) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p, files);
      else if (files.test(p)) hash.update(p.replace(/\\/g, '/')).update(readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
    }
  };
  for (const dir of ['src/engine', 'src/game', 'src/net']) walk(dir);
  return hash.digest('hex').slice(0, 12);
}

/** 在页面中为预览图地址加上其哈希，因为聊天应用会按地址缓存链接预览图。 */
function versionPreview(): Plugin {
  return {
    name: 'version-preview',
    transformIndexHtml(html) {
      if (!existsSync('public/preview.png')) return html;
      const v = createHash('sha256').update(readFileSync('public/preview.png')).digest('hex').slice(0, 8);
      return html.replace(/\/preview\.png"/g, `/preview.png?v=${v}"`);
    },
  };
}

export default defineConfig({
  plugins: [versionPreview()],
  // 相对资源路径让同一构建可从任意文件夹运行，包括静态主机上的仓库子目录。
  base: './',
  define: {
    __BUILD__: JSON.stringify(buildFingerprint()),
    __RELAY_URL__: JSON.stringify(process.env.RELAY_URL || ''),
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    watch: { ignored: ['**/out/**', '**/Notes/**', '**/work/**', '**/sb3/**', '**/public/assets/**', '**/server/**'] },
    // 开发时房间服务器与页面一起运行（npm run worker:dev）。
    proxy: {
      '/api': { target: process.env.WORKER_URL ?? 'http://127.0.0.1:8788', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 12000,
  },
});
