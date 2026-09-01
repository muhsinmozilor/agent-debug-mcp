import { z } from 'zod';

export const CursorSchema = z.object({
  doc: z.string(),
  kind: z.enum(['tree', 'queries', 'mutations', 'commits', 'routes', 'search']),
  gen: z.number().int().nonnegative(),
  pos: z.union([z.number(), z.string()]),
});
export type Cursor = z.infer<typeof CursorSchema>;

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeCursor(c: Cursor): string {
  return toBase64Url(JSON.stringify(c));
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(fromBase64Url(s)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
  truncated: boolean;
}
