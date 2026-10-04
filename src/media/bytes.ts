/** Bounds-safe binary readers for header parsing. Out-of-range reads return 0 / '' instead of throwing. */

export function u8(b: Uint8Array, at: number): number {
  return at >= 0 && at < b.length ? b[at] : 0;
}

export function u16le(b: Uint8Array, at: number): number {
  return u8(b, at) | (u8(b, at + 1) << 8);
}

export function u16be(b: Uint8Array, at: number): number {
  return (u8(b, at) << 8) | u8(b, at + 1);
}

export function u24le(b: Uint8Array, at: number): number {
  return u8(b, at) | (u8(b, at + 1) << 8) | (u8(b, at + 2) << 16);
}

export function u32le(b: Uint8Array, at: number): number {
  return (u8(b, at) | (u8(b, at + 1) << 8) | (u8(b, at + 2) << 16) | (u8(b, at + 3) << 24)) >>> 0;
}

export function u32be(b: Uint8Array, at: number): number {
  return ((u8(b, at) << 24) | (u8(b, at + 1) << 16) | (u8(b, at + 2) << 8) | u8(b, at + 3)) >>> 0;
}

export function i32le(b: Uint8Array, at: number): number {
  return u32le(b, at) | 0;
}

/** Latin-1 decode of `length` bytes (header tags, box types, brands). */
export function ascii(b: Uint8Array, at: number, length: number): string {
  if (at < 0 || at + length > b.length) return '';
  let s = '';
  for (let i = at; i < at + length; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function startsWith(b: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (at + signature.length > b.length) return false;
  for (let i = 0; i < signature.length; i++) if (b[at + i] !== signature[i]) return false;
  return true;
}

/** Index of the first occurrence of an ASCII tag in b[from, to), or -1. */
export function indexOfAscii(b: Uint8Array, tag: string, from = 0, to = b.length): number {
  const end = Math.min(to, b.length) - tag.length;
  const first = tag.charCodeAt(0);
  outer: for (let i = Math.max(0, from); i <= end; i++) {
    if (b[i] !== first) continue;
    for (let j = 1; j < tag.length; j++) if (b[i + j] !== tag.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
