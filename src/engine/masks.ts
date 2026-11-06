// 接触遮罩文件：每个带遮罩造型的 1 位 alpha 遮罩以游程编码保存，前面是 JSON 索引。
// 磁盘上的文件经过 gzip 压缩。调用方负责解压，因为浏览器和工具的解压方式不同。

/** 造型遮罩的存储形式：透明和实心像素交替的 varint 游程长度，从透明开始。 */
export interface PackedMask {
  w: number;
  h: number;
  runs: Uint8Array;
}

/** 一个造型在渲染器 1x mip 上的 alpha 遮罩，用于接触测试。 */
export interface Silhouette {
  w: number;
  h: number;
  /** 每像素一位，逐行从最低位开始，在 alpha > 0 处置位。 */
  bits: Uint8Array;
}

/** 角色名称对应的各造型遮罩，按造型顺序排列。 */
export type MaskSet = Record<string, PackedMask[]>;

function pushVarint(out: number[], n: number): void {
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

/** 对以打包位表示的遮罩进行游程编码。 */
export function packMask(w: number, h: number, bits: Uint8Array): PackedMask {
  const out: number[] = [];
  let on = false;
  let run = 0;
  for (let i = 0; i < w * h; i++) {
    const v = ((bits[i >> 3] >> (i & 7)) & 1) === 1;
    if (v !== on) {
      pushVarint(out, run);
      on = v;
      run = 0;
    }
    run++;
  }
  pushVarint(out, run);
  return { w, h, runs: Uint8Array.from(out) };
}

export function unpackMask(p: PackedMask): Silhouette {
  const bits = new Uint8Array(Math.ceil((p.w * p.h) / 8));
  let i = 0;
  let pos = 0;
  let on = false;
  while (pos < p.runs.length) {
    let run = 0;
    let shift = 1;
    for (;;) {
      const b = p.runs[pos++];
      run += (b & 0x7f) * shift;
      if (b < 0x80) break;
      shift *= 0x80;
    }
    if (on) for (let k = i; k < i + run; k++) bits[k >> 3] |= 1 << (k & 7);
    i += run;
    on = !on;
  }
  return { w: p.w, h: p.h, bits };
}

/** 写入未压缩文件：小端序索引长度、JSON 索引，然后每个遮罩的游程。 */
export function encodeMaskSet(set: MaskSet): Uint8Array {
  const index: Record<string, [number, number, number, number][]> = {};
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const [name, masks] of Object.entries(set)) {
    index[name] = masks.map((m) => {
      chunks.push(m.runs);
      const entry: [number, number, number, number] = [m.w, m.h, offset, m.runs.length];
      offset += m.runs.length;
      return entry;
    });
  }
  const head = new TextEncoder().encode(JSON.stringify(index));
  const out = new Uint8Array(4 + head.length + offset);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  let at = 4 + head.length;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function decodeMaskSet(file: Uint8Array): MaskSet {
  const headLen = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(file.subarray(4, 4 + headLen))) as Record<string, [number, number, number, number][]>;
  const body = file.subarray(4 + headLen);
  const set: MaskSet = {};
  for (const [name, entries] of Object.entries(index)) {
    set[name] = entries.map(([w, h, off, len]) => ({ w, h, runs: body.subarray(off, off + len) }));
  }
  return set;
}
