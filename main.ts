// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers (exact, trailing whitespace, both-side whitespace), and
// writes every change or none. Node 22, the standard library alone; run it
// as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  file(p: string): FileState | null {
    const t = this.get(p);
    return t === null ? null : splitFile(t);
  }
  setFile(p: string, f: FileState): void {
    this.now.set(p, joinFile(f));
  }
}

type Edit = (tree: Tree, strict: boolean) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** Section 5: one line compared at one tier. */
function lineKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at this tier (overlap allowed). */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const pos: number[] = [];
  if (O.length === 0) return pos;
  const keys = O.map((l) => lineKey(l, tier));
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (lineKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs at least once, with every position there. */
function findTier(lines: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, O, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * Build N as it is written: a context line is the file's own matched line,
 * never the patch's; at tier 2 every other line is re-indented from O's
 * first line's leading whitespace to the file's first matched line's.
 * nCtx[k] is the index into O of N[k] when N[k] is a context line, else -1.
 */
function buildNew(N: string[], nCtx: number[], fileLines: string[], at: number, O: string[], tier: number): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2 && O.length > 0) {
    p = leadingWs(O[0]!);
    f = leadingWs(fileLines[at] ?? '');
  }
  for (let k = 0; k < N.length; k++) {
    const c = nCtx[k]!;
    if (c >= 0) {
      out.push(fileLines[at + c]!);
      continue;
    }
    let line = N[k]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
    out.push(line);
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  backslash: boolean;
}

/** Split body items into old lines O, new lines N, and N's context map. */
function splitBody(items: BodyItem[]): { O: string[]; N: string[]; nCtx: number[]; lastNBackslash: boolean } {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: number[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      nCtx.push(O.length);
      O.push(it.text);
      N.push(it.text);
    } else if (it.kind === 'old') {
      O.push(it.text);
    } else {
      nCtx.push(-1);
      N.push(it.text);
    }
  }
  let lastNBackslash = false;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.kind === 'ctx' || items[k]!.kind === 'new') {
      lastNBackslash = items[k]!.backslash;
      break;
    }
  }
  return { O, N, nCtx, lastNBackslash };
}

/** Section 6: unified diffs. */

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface UniSection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  create: boolean;
  del: boolean;
  inHeader: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed, a/ or b/ removed, /dev/null is no file. */
function headerPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk body: lines after the header starting with space, -, + or \, or empty. */
function parseBody(lines: string[], i: number): { items: BodyItem[]; next: number } {
  const items: BodyItem[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '', backslash: false });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      items.push({ kind: 'ctx', text: l.slice(1), backslash: false });
      j++;
      continue;
    }
    if (c === '-') {
      items.push({ kind: 'old', text: l.slice(1), backslash: false });
      j++;
      continue;
    }
    if (c === '+') {
      items.push({ kind: 'new', text: l.slice(1), backslash: false });
      j++;
      continue;
    }
    if (c === '\\') {
      if (items.length > 0) items[items.length - 1]!.backslash = true;
      j++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  return { items, next: j };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let curHasDash = false;
  const startSection = (oldP: string | null | undefined, newP: string | null | undefined): void => {
    cur = {
      diffOld: undefined,
      diffNew: undefined,
      dashOld: undefined,
      dashNew: undefined,
      renameOld: undefined,
      renameNew: undefined,
      create: false,
      del: false,
      inHeader: true,
      hunks: [],
    };
    if (oldP !== undefined) {
      cur.diffOld = oldP ?? undefined;
      cur.diffNew = newP ?? undefined;
    }
    sections.push(cur);
    curHasDash = false;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1], m[2]);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null) {
        startSection(undefined, undefined);
        cur!.dashOld = headerPath(l);
        cur!.dashNew = headerPath(lines[i + 1]!);
        curHasDash = true;
        i += 2;
        continue;
      }
      if (cur.inHeader && !curHasDash) {
        cur.dashOld = headerPath(l);
        cur.dashNew = headerPath(lines[i + 1]!);
        curHasDash = true;
        i += 2;
        continue;
      }
      startSection(undefined, undefined);
      cur!.dashOld = headerPath(l);
      cur!.dashNew = headerPath(lines[i + 1]!);
      curHasDash = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (cur.inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('@@')) {
        const m = HUNK_HEAD.exec(l);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        const body = parseBody(lines, i + 1);
        cur.hunks.push({ a: parseInt(m[1]!, 10), items: body.items });
        cur.inHeader = false;
        i = body.next;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const body = parseBody(lines, i + 1);
      cur.hunks.push({ a: parseInt(m[1]!, 10), items: body.items });
      i = body.next;
      continue;
    }
    i++;
  }
  return sections.map((sec) => {
    const oldPath = sec.dashOld !== undefined ? sec.dashOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld ?? null;
    const newPath = sec.dashNew !== undefined ? sec.dashNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew ?? null;
    const isCreate = sec.create || oldPath === null;
    const isDelete = !isCreate && (sec.del || newPath === null);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;
    return (tree: Tree, strict: boolean): void => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && newPath !== oldPath && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (isCreate) {
        const p = newPath!;
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let noNl = false;
        for (const h of sec.hunks) {
          for (const it of h.items) {
            if (it.kind === 'new') {
              plus.push(it.text);
              noNl = it.backslash;
            }
          }
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
        return;
      }
      if (isDelete) {
        const p = oldPath!;
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const src = tree.get(oldPath!);
      if (src === null) throw new Fail('missing', oldPath!);
      if (isMove && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
      const file = splitFile(src);
      let d = 0;
      for (const h of sec.hunks) {
        const { O, N, nCtx, lastNBackslash } = splitBody(h.items);
        if (O.length === 0) {
          const at = Math.min(Math.max(h.a + d, 0), file.lines.length);
          const touchesEnd = at === file.lines.length;
          const built = buildNew(N, nCtx, file.lines, at, O, 0);
          file.lines.splice(at, 0, ...built);
          if (touchesEnd) file.finalBreak = !lastNBackslash;
          d += N.length;
          continue;
        }
        const found = findTier(file.lines, O, strict);
        if (!found) throw new Fail('no-match', oldPath!);
        const target = h.a - 1 + d;
        let at = found.pos[0]!;
        let best = Math.abs(at - target);
        for (const p of found.pos) {
          const dist = Math.abs(p - target);
          if (dist < best) {
            best = dist;
            at = p;
          }
        }
        const touchesEnd = at + O.length === file.lines.length;
        const built = buildNew(N, nCtx, file.lines, at, O, found.tier);
        file.lines.splice(at, O.length, ...built);
        if (touchesEnd) file.finalBreak = !lastNBackslash;
        d += N.length - O.length;
      }
      if (isMove) {
        tree.now.set(oldPath!, null);
        tree.now.set(newPath!, joinFile(file));
        tree.moves.push({ old: oldPath!, nw: newPath! });
      } else {
        tree.setFile(oldPath!, file);
      }
    };
  });
}

/** Section 7: SEARCH/REPLACE blocks. */

function makeSREdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree: Tree, strict: boolean): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const file = splitFile(cur);
    const found = findTier(file.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const built = buildNew(newLines, newLines.map(() => -1), file.lines, found.pos[0]!, oldLines, found.tier);
    file.lines.splice(found.pos[0]!, oldLines.length, ...built);
    tree.setFile(path, file);
  };
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= searchFrom; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(makeSREdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep)));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** Section 8: V4A patches. */

interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

/** First line at or after `from` equal to the anchor at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineKey(lines[i]!, t) === lineKey(anchor, t)) return i;
    }
  }
  return -1;
}

/** First occurrence of O at or after `from` at the first tier with one; an end-of-file chunk only takes one ending at the last line. */
function findFrom(lines: string[], O: string[], from: number, strict: boolean, eof: boolean): { at: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, O, t).filter((p) => p >= from && (!eof || p + O.length === lines.length));
    if (pos.length > 0) return { at: pos[0]!, tier: t };
  }
  return null;
}

function parseV4A(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headLine = i + 1;
    // The section's lines run to the next section header or End Patch; blank lines at its end are not part of it.
    let j = i + 1;
    while (j < last) {
      const t = lines[j]!;
      if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) break;
      j++;
    }
    const raw: { text: string; no: number }[] = [];
    for (let k = i + 1; k < j; k++) raw.push({ text: lines[k]!, no: k + 1 });
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') addLines.push('');
        else if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      const p = path;
      const ls = addLines;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      const p = path;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; idx < raw.length; idx++) {
        const r = raw[idx]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          cur = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), items: [], eof: false };
          chunks.push(cur);
        } else if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.no}`);
          cur.eof = true;
          cur = null;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
          }
          const k = t === '' ? 'ctx' : t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new';
          cur.items.push({ kind: k, text: t === '' ? '' : t.slice(1), backslash: false });
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
      const p = path;
      const mv = moveTo;
      const chs = chunks;
      edits.push((tree: Tree, strict: boolean): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const curText = tree.get(p);
        if (curText === null) throw new Fail('missing', p);
        if (mv !== null) {
          if (!safe(mv)) throw new Fail('unsafe', mv);
          if (tree.get(mv) !== null) throw new Fail('exists', mv);
        }
        const file = splitFile(curText);
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null) {
            const at = findAnchor(file.lines, ch.anchor, cursor, strict);
            if (at < 0) throw new Fail('no-match', p);
            cursor = at + 1;
          }
          const { O, N, nCtx } = splitBody(ch.items);
          if (O.length === 0) {
            const at = ch.eof ? file.lines.length : cursor;
            const built = buildNew(N, nCtx, file.lines, at, O, 0);
            file.lines.splice(at, 0, ...built);
            cursor = at + built.length;
          } else {
            const found = findFrom(file.lines, O, cursor, strict, ch.eof);
            if (!found) throw new Fail('no-match', p);
            const built = buildNew(N, nCtx, file.lines, found.at, O, found.tier);
            file.lines.splice(found.at, O.length, ...built);
            cursor = found.at + built.length;
          }
        }
        if (mv !== null) {
          tree.now.set(p, null);
          tree.now.set(mv, joinFile(file));
          tree.moves.push({ old: p, nw: mv });
        } else {
          tree.setFile(p, file);
        }
      });
    }
    i = j;
  }
  return edits;
}

/** Section 9: JSON edits. */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.setFile(p, f);
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Sections 1, 2 and 10: the command line, output and exit codes, order and atomicity. */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4A(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: a move that succeeded prints one R line (sorting by its new
  // path) instead of the pair's D and A lines; the rest print A, D or M.
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      consumed.add(m.old);
      consumed.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
