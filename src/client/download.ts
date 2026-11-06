// 将页面生成的文件（如回放或其视频）保存到玩家的下载目录。

/** 根据回放名称生成各系统都接受的文件名。 */
export function fileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return safe || 'replay';
}

export function downloadFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
