// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// A model writes an edit in one of four shapes — a unified diff (often with
// wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, or JSON
// tool calls — and mend reads whichever shape shows up, finds the lines the
// edit names at the first of three matching tiers (exact, trailing
// whitespace, both-side whitespace), and changes every file or none.
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
//
// The one rule that shapes the whole file: section 10 of the spec says every
// path an edit names is checked for safety before anything else about it.
// So each edit closure opens by proving all of its paths safe, and only
// then asks whether files exist, match, or collide.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;

/** An exit-2 outcome: the single line to print. */
class FatalLine extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class EditFailure extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** Patch text split into lines: at \n, one trailing \r removed, no empty piece after a final \n. */
function patchRows(text: string): string[] {
  if (text === '') return [];
  const rows = text.split('\n');
  if (text.endsWith('\n')) rows.pop();
  return rows.map((r) => (r.endsWith('\r') ? r.slice(0, -1) : r));
}

/** Section 3: a path is safe when it is not empty, not absolute, holds no backslash, and no segment is empty, `.` or `..`. */
function pathIsSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Throw the edit's `unsafe` failure for a path that is not safe. */
function requireSafe(p: string): void {
  if (!pathIsSafe(p)) throw new EditFailure('unsafe', p);
}

/** A file as lines: its line break, and whether it ends with one. */
interface TextDoc {
  rows: string[];
  sep: '\n' | '\r\n';
  endsWithBreak: boolean;
}

function decodeDoc(text: string): TextDoc {
  if (text === '') return { rows: [], sep: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const sep: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(sep);
  const endsWithBreak = text.endsWith(sep);
  if (endsWithBreak) parts.pop();
  return { rows: parts, sep, endsWithBreak };
}

function encodeDoc(d: TextDoc): string {
  if (d.rows.length === 0) return '';
  return d.rows.join(d.sep) + (d.endsWithBreak ? d.sep : '');
}

/**
 * The tree as the edits leave it. `staged` holds every path an edit has
 * touched (null: deleted); anything else is read from disk on demand and
 * cached in `disk`. `relocations` records the moves that succeeded, so the
 * output can print one `R old -> new` line for each.
 */
class Workspace {
  private readonly disk = new Map<string, string | null>();
  readonly staged = new Map<string, string | null>();
  readonly relocations: Array<{ from: string; to: string }> = [];

  onDisk(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  current(p: string): string | null {
    return this.staged.has(p) ? this.staged.get(p)! : this.onDisk(p);
  }

  doc(p: string): TextDoc | null {
    const t = this.current(p);
    return t === null ? null : decodeDoc(t);
  }

  store(p: string, d: TextDoc): void {
    this.staged.set(p, encodeDoc(d));
  }

  storeText(p: string, text: string): void {
    this.staged.set(p, text);
  }

  remove(p: string): void {
    this.staged.set(p, null);
  }
}

type PlannedEdit = (ws: Workspace, strict: boolean) => void;

/** Section 4: which format a patch is, from its text. */
function detectFormat(rows: string[]): string | null {
  const first = rows.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (rows[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = rows[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (rows.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (rows.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (rows[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** Section 5: one line compared at one tier. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where `needle` occurs in `rows` at this tier; occurrences may overlap. */
function scanPositions(rows: string[], needle: string[], tier: number): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  const keys = needle.map((l) => tierKey(l, tier));
  for (let i = 0; i + needle.length <= rows.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (tierKey(rows[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `needle` occurs at least once, with every position there. */
function firstTier(rows: string[], needle: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = scanPositions(rows, needle, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** One body line of a unified hunk or a V4A chunk. */
interface ChunkLine {
  role: 'same' | 'drop' | 'add';
  text: string;
  /** A `\` line followed this one (it has no line break of its own). */
  noBreak: boolean;
}

/**
 * Split body lines into the old rows O, the new rows N, and N's context map
 * (for each row of N, its index into O when it is a context line, else -1),
 * plus whether a `\` line follows the last context or `+` line.
 */
function splitChunk(items: ChunkLine[]): { oldRows: string[]; newRows: string[]; ctxOfNew: number[]; lastNoBreak: boolean } {
  const oldRows: string[] = [];
  const newRows: string[] = [];
  const ctxOfNew: number[] = [];
  for (const it of items) {
    if (it.role === 'same') {
      ctxOfNew.push(oldRows.length);
      oldRows.push(it.text);
      newRows.push(it.text);
    } else if (it.role === 'drop') {
      oldRows.push(it.text);
    } else {
      ctxOfNew.push(-1);
      newRows.push(it.text);
    }
  }
  let lastNoBreak = false;
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.role === 'same' || it.role === 'add') {
      lastNoBreak = it.noBreak;
      break;
    }
  }
  return { oldRows, newRows, ctxOfNew, lastNoBreak };
}

/**
 * Build N as it is written: a context line is the file's own matched line,
 * never the patch's; at tier 2 every other line is re-indented from O's
 * first line's leading whitespace to the file's first matched line's.
 */
function renderNew(newRows: string[], ctxOfNew: number[], fileRows: string[], at: number, oldRows: string[], tier: number): string[] {
  let fromWs = '';
  let toWs = '';
  if (tier === 2 && oldRows.length > 0) {
    fromWs = leadingWs(oldRows[0]!);
    toWs = leadingWs(fileRows[at] ?? '');
  }
  const out: string[] = [];
  for (let k = 0; k < newRows.length; k++) {
    const c = ctxOfNew[k]!;
    if (c >= 0) {
      out.push(fileRows[at + c]!);
      continue;
    }
    let line = newRows[k]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(fromWs)) line = toWs + line.slice(fromWs.length);
    out.push(line);
  }
  return out;
}

/** Section 6: unified diffs. */

interface UniHunk {
  oldStart: number;
  items: ChunkLine[];
}

interface UniSection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  created: boolean;
  deleted: boolean;
  inHeader: boolean;
  hunks: UniHunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed, a leading a/ or b/ removed, /dev/null is no file. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.+?) b\/(.+)$/;

/** A hunk body: the lines after the header that start with space, -, + or \, or are empty. */
function readHunkBody(rows: string[], start: number): { items: ChunkLine[]; next: number } {
  const items: ChunkLine[] = [];
  let j = start;
  while (j < rows.length) {
    const l = rows[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (rows[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ role: 'same', text: '', noBreak: false });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      items.push({ role: 'same', text: l.slice(1), noBreak: false });
      j++;
      continue;
    }
    if (c === '-') {
      items.push({ role: 'drop', text: l.slice(1), noBreak: false });
      j++;
      continue;
    }
    if (c === '+') {
      items.push({ role: 'add', text: l.slice(1), noBreak: false });
      j++;
      continue;
    }
    if (c === '\\') {
      if (items.length > 0) items[items.length - 1]!.noBreak = true;
      j++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.role === 'same' && last.text === '') items.pop();
    else break;
  }
  return { items, next: j };
}

function freshSection(diffOld: string | undefined, diffNew: string | undefined): UniSection {
  return {
    diffOld,
    diffNew,
    dashOld: undefined,
    dashNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    created: false,
    deleted: false,
    inHeader: true,
    hunks: [],
  };
}

function parseUnifiedPatch(rows: string[]): PlannedEdit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hasDash = false;
  let i = 0;
  while (i < rows.length) {
    const l = rows[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (!m) throw new FatalLine(`error: parse ${i + 1}`);
      cur = freshSection(m[1], m[2]);
      sections.push(cur);
      hasDash = false;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (rows[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !cur.inHeader || hasDash) {
        cur = freshSection(undefined, undefined);
        sections.push(cur);
      }
      cur.dashOld = headerPath(l);
      cur.dashNew = headerPath(rows[i + 1]!);
      hasDash = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new FatalLine(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (cur.inHeader) {
      if (l.startsWith('--- ')) throw new FatalLine(`error: parse ${i + 2}`);
      if (l.startsWith('@@')) {
        const m = HUNK_HEAD.exec(l);
        if (!m) throw new FatalLine(`error: parse ${i + 1}`);
        const body = readHunkBody(rows, i + 1);
        cur.hunks.push({ oldStart: Number(m[1]), items: body.items });
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
        cur.created = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deleted = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (!m) throw new FatalLine(`error: parse ${i + 1}`);
      const body = readHunkBody(rows, i + 1);
      cur.hunks.push({ oldStart: Number(m[1]), items: body.items });
      i = body.next;
      continue;
    }
    i++;
  }
  return sections.map((sec) => {
    const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld ?? null;
    const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew ?? null;
    const isCreate = sec.created || oldP === null;
    const isDelete = !isCreate && (sec.deleted || newP === null);
    const isMove = !isCreate && !isDelete && oldP !== newP;
    return (ws: Workspace, strict: boolean): void => {
      // Section 10: both paths are proven safe before anything else about them.
      if (oldP !== null) requireSafe(oldP);
      if (newP !== null && newP !== oldP) requireSafe(newP);
      if (isCreate) {
        // A creation whose new path is /dev/null names no file at all: the
        // edit cannot be applied, so it fails instead of crashing on a null
        // path. An absent path is not a safe path (section 3: a safe path
        // is not empty).
        if (newP === null) throw new EditFailure('unsafe', '');
        const p = newP;
        if (ws.current(p) !== null) throw new EditFailure('exists', p);
        const plus: string[] = [];
        let noNl = false;
        for (const h of sec.hunks) {
          for (const it of h.items) {
            if (it.role === 'add') {
              plus.push(it.text);
              noNl = it.noBreak;
            }
          }
        }
        ws.storeText(p, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
        return;
      }
      if (isDelete) {
        const p = oldP as string;
        if (ws.current(p) === null) throw new EditFailure('missing', p);
        ws.remove(p);
        return;
      }
      const src = ws.current(oldP as string);
      if (src === null) throw new EditFailure('missing', oldP as string);
      if (isMove && ws.current(newP as string) !== null) throw new EditFailure('exists', newP as string);
      const doc = decodeDoc(src);
      let d = 0;
      for (const h of sec.hunks) {
        const { oldRows, newRows, ctxOfNew, lastNoBreak } = splitChunk(h.items);
        if (oldRows.length === 0) {
          const at = Math.min(Math.max(h.oldStart + d, 0), doc.rows.length);
          const atEnd = at === doc.rows.length;
          const built = renderNew(newRows, ctxOfNew, doc.rows, at, oldRows, 0);
          doc.rows.splice(at, 0, ...built);
          if (atEnd) doc.endsWithBreak = !lastNoBreak;
          d += newRows.length;
          continue;
        }
        const found = firstTier(doc.rows, oldRows, strict);
        if (!found) throw new EditFailure('no-match', oldP as string);
        const target = h.oldStart - 1 + d;
        let at = found.at[0]!;
        let best = Math.abs(at - target);
        for (const p of found.at) {
          const dist = Math.abs(p - target);
          if (dist < best) {
            best = dist;
            at = p;
          }
        }
        const atEnd = at + oldRows.length === doc.rows.length;
        const built = renderNew(newRows, ctxOfNew, doc.rows, at, oldRows, found.tier);
        doc.rows.splice(at, oldRows.length, ...built);
        if (atEnd) doc.endsWithBreak = !lastNoBreak;
        d += newRows.length - oldRows.length;
      }
      if (isMove) {
        ws.remove(oldP as string);
        ws.storeText(newP as string, encodeDoc(doc));
        ws.relocations.push({ from: oldP as string, to: newP as string });
      } else {
        ws.store(oldP as string, doc);
      }
    };
  });
}

/** Section 7: SEARCH/REPLACE blocks. */

function srEdit(path: string, oldRows: string[], newRows: string[]): PlannedEdit {
  return (ws: Workspace, strict: boolean): void => {
    requireSafe(path);
    if (oldRows.length === 0) {
      if (ws.current(path) !== null) throw new EditFailure('exists', path);
      ws.storeText(path, newRows.length === 0 ? '' : newRows.join('\n') + '\n');
      return;
    }
    const cur = ws.current(path);
    if (cur === null) throw new EditFailure('missing', path);
    const doc = decodeDoc(cur);
    const found = firstTier(doc.rows, oldRows, strict);
    if (!found) throw new EditFailure('no-match', path);
    if (found.at.length > 1) throw new EditFailure('ambiguous', path);
    const built = renderNew(newRows, newRows.map(() => -1), doc.rows, found.at[0]!, oldRows, found.tier);
    doc.rows.splice(found.at[0]!, oldRows.length, ...built);
    ws.store(path, doc);
  };
}

function parseSearchReplacePatch(rows: string[]): PlannedEdit[] {
  const edits: PlannedEdit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= searchFrom; k--) {
      const t = rows[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new FatalLine(`error: parse ${searchNo}`);
    let eq = -1;
    for (let k = i + 1; k < rows.length; k++) {
      if (rows[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
      if (rows[k]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new FatalLine(`error: parse ${searchNo}`);
    let rep = -1;
    for (let k = eq + 1; k < rows.length; k++) {
      if (rows[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new FatalLine(`error: parse ${searchNo}`);
    edits.push(srEdit(path, rows.slice(i + 1, eq), rows.slice(eq + 1, rep)));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** Section 8: V4A patches. */

interface V4aChunk {
  anchor: string | null;
  items: ChunkLine[];
  eof: boolean;
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findAnchor(rows: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < rows.length; i++) {
      if (tierKey(rows[i]!, t) === tierKey(anchor, t)) return i;
    }
  }
  return -1;
}

/** The first occurrence of O at or after `from`, at the first tier with one; an end-of-file chunk only takes one ending at the last line. */
function findFrom(rows: string[], needle: string[], from: number, strict: boolean, eof: boolean): { at: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = scanPositions(rows, needle, t).filter((p) => p >= from && (!eof || p + needle.length === rows.length));
    if (at.length > 0) return { at: at[0]!, tier: t };
  }
  return null;
}

function applyV4aChunks(chunks: V4aChunk[], doc: TextDoc, strict: boolean, path: string): void {
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const at = findAnchor(doc.rows, ch.anchor, cursor, strict);
      if (at < 0) throw new EditFailure('no-match', path);
      cursor = at + 1;
    }
    const { oldRows, newRows, ctxOfNew } = splitChunk(ch.items);
    if (oldRows.length === 0) {
      const at = ch.eof ? doc.rows.length : cursor;
      const built = renderNew(newRows, ctxOfNew, doc.rows, at, oldRows, 0);
      doc.rows.splice(at, 0, ...built);
      cursor = at + built.length;
    } else {
      const found = findFrom(doc.rows, oldRows, cursor, strict, ch.eof);
      if (!found) throw new EditFailure('no-match', path);
      const built = renderNew(newRows, ctxOfNew, doc.rows, found.at, oldRows, found.tier);
      doc.rows.splice(found.at, oldRows.length, ...built);
      cursor = found.at + built.length;
    }
  }
}

function parseV4aPatch(rows: string[]): PlannedEdit[] {
  const first = rows.findIndex((l) => !isBlank(l));
  if (first < 0) throw new FatalLine('error: parse 1');
  if (rows[first]!.trim() !== '*** Begin Patch') throw new FatalLine(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = rows.length - 1; k >= 0; k--) {
    if (!isBlank(rows[k]!)) {
      last = k;
      break;
    }
  }
  if (rows[last]!.trim() !== '*** End Patch') throw new FatalLine(`error: parse ${rows.length + 1}`);
  const edits: PlannedEdit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = rows[i]!;
    if (isBlank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
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
      throw new FatalLine(`error: parse ${i + 1}`);
    }
    const headNo = i + 1;
    // The section's lines run to the next section header or End Patch; blank lines at its end are not part of it.
    let j = i + 1;
    while (j < last) {
      const t = rows[j]!;
      if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) break;
      j++;
    }
    const raw: Array<{ text: string; no: number }> = [];
    for (let k = i + 1; k < j; k++) raw.push({ text: rows[k]!, no: k + 1 });
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const addRows: string[] = [];
      for (const r of raw) {
        if (r.text === '') addRows.push('');
        else if (r.text.startsWith('+')) addRows.push(r.text.slice(1));
        else throw new FatalLine(`error: parse ${r.no}`);
      }
      edits.push((ws: Workspace): void => {
        requireSafe(path);
        if (ws.current(path) !== null) throw new EditFailure('exists', path);
        ws.storeText(path, addRows.length === 0 ? '' : addRows.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new FatalLine(`error: parse ${raw[0]!.no}`);
      edits.push((ws: Workspace): void => {
        requireSafe(path);
        if (ws.current(path) === null) throw new EditFailure('missing', path);
        ws.remove(path);
      });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (; idx < raw.length; idx++) {
        const r = raw[idx]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          cur = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), items: [], eof: false };
          chunks.push(cur);
        } else if (t === '*** End of File') {
          if (cur === null) throw new FatalLine(`error: parse ${r.no}`);
          cur.eof = true;
          cur = null;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new FatalLine(`error: parse ${r.no}`);
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
          }
          const role: ChunkLine['role'] = t === '' ? 'same' : t[0] === ' ' ? 'same' : t[0] === '-' ? 'drop' : 'add';
          cur.items.push({ role, text: t === '' ? '' : t.slice(1), noBreak: false });
        } else {
          throw new FatalLine(`error: parse ${r.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new FatalLine(`error: parse ${headNo}`);
      edits.push((ws: Workspace, strict: boolean): void => {
        // Section 10, the fix: the move-to path is proven safe BEFORE the
        // source is looked up at all — a missing source must never hide an
        // unsafe destination.
        requireSafe(path);
        if (moveTo !== null) requireSafe(moveTo);
        const curText = ws.current(path);
        if (curText === null) throw new EditFailure('missing', path);
        if (moveTo !== null && ws.current(moveTo) !== null) throw new EditFailure('exists', moveTo);
        const doc = decodeDoc(curText);
        applyV4aChunks(chunks, doc, strict, path);
        if (moveTo !== null) {
          ws.remove(path);
          ws.storeText(moveTo, encodeDoc(doc));
          ws.relocations.push({ from: path, to: moveTo });
        } else {
          ws.store(path, doc);
        }
      });
    }
    i = j;
  }
  return edits;
}

/** Section 9: JSON edits. */

function jsonEdit(v: unknown): PlannedEdit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (ws: Workspace): void => {
      requireSafe(p);
      if (ws.current(p) !== null) throw new EditFailure('exists', p);
      ws.storeText(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (ws: Workspace): void => {
      requireSafe(p);
      const before = ws.current(p);
      if (before === null) throw new EditFailure('missing', p);
      const crlf = decodeDoc(before).sep === '\r\n';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = flat(before);
      const old = flat(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
      ws.storeText(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = patchRows(o.new_str);
    return (ws: Workspace): void => {
      requireSafe(p);
      const before = ws.current(p);
      if (before === null) throw new EditFailure('missing', p);
      const doc = decodeDoc(before);
      if (lineNo < 0 || lineNo > doc.rows.length) throw new EditFailure('no-match', p);
      doc.rows.splice(lineNo, 0, ...add);
      ws.store(p, doc);
    };
  }
  return null;
}

function parseJsonPatch(text: string, rows: string[]): PlannedEdit[] {
  const first = rows.findIndex((l) => !isBlank(l));
  if (first < 0) throw new FatalLine('error: parse 1');
  const edits: PlannedEdit[] = [];
  if (rows[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new FatalLine(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new FatalLine(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new FatalLine(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  rows.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: PlannedEdit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new FatalLine(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Sections 1, 2 and 10: the command line, output and exit codes, order and atomicity. */

function parseArgs(argv: string[]): { format: string; check: boolean; strict: boolean; patch: string | null } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const a of argv) {
    if (!afterDashDash && a === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !(KNOWN_FORMATS as readonly string[]).includes(v)) throw new FatalLine('error: usage');
        format = v;
      } else if (a === '--check') {
        if (check) throw new FatalLine('error: usage');
        check = true;
      } else if (a === '--strict') {
        if (strict) throw new FatalLine('error: usage');
        strict = true;
      } else {
        throw new FatalLine('error: usage');
      }
      continue;
    }
    positional.push(a);
  }
  if (positional.length > 1) throw new FatalLine('error: usage');
  return { format: format ?? 'auto', check, strict, patch: positional.length === 0 || positional[0] === '-' ? null : positional[0]! };
}

function execute(argv: string[]): { code: number; lines: string[] } {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof FatalLine) return { code: 2, lines: [e.line] };
    throw e;
  }
  let text = '';
  try {
    text = readFileSync(opts.patch ?? 0, 'utf8');
  } catch {
    if (opts.patch !== null) return { code: 2, lines: ['error: no-patch'] };
  }
  const rows = patchRows(text);
  const kind = opts.format === 'auto' ? detectFormat(rows) : opts.format;
  if (kind === null) return { code: 2, lines: ['error: format'] };
  let edits: PlannedEdit[];
  try {
    edits =
      kind === 'json'
        ? parseJsonPatch(text, rows)
        : kind === 'unified'
          ? parseUnifiedPatch(rows)
          : kind === 'search-replace'
            ? parseSearchReplacePatch(rows)
            : parseV4aPatch(rows);
    if (edits.length === 0) throw new FatalLine('error: parse 1');
  } catch (e) {
    if (e instanceof FatalLine) return { code: 2, lines: [e.line] };
    throw e;
  }
  const ws = new Workspace();
  const failures: EditFailure[] = [];
  for (const edit of edits) {
    const stagedBefore = new Map(ws.staged);
    const relocBefore = ws.relocations.length;
    try {
      edit(ws, opts.strict);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      // A failed edit changes nothing.
      ws.staged.clear();
      for (const [k, v] of stagedBefore) ws.staged.set(k, v);
      ws.relocations.length = relocBefore;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return { code: 1, lines: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`] };
  }
  // Output rows: a move that succeeded prints one R line (sorting by its new
  // path) instead of the pair's D and A lines; the rest print A, D or M.
  const outRows: Array<{ key: string; text: string }> = [];
  const swallowed = new Set<string>();
  for (const m of ws.relocations) {
    if (ws.onDisk(m.from) !== null && ws.current(m.from) === null && ws.onDisk(m.to) === null && ws.current(m.to) !== null) {
      outRows.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
      swallowed.add(m.from);
      swallowed.add(m.to);
    }
  }
  const keys = [...ws.staged.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  for (const p of keys) {
    if (swallowed.has(p)) continue;
    const before = ws.onDisk(p);
    const after = ws.staged.get(p)!;
    if (before === after) continue;
    outRows.push({ key: p, text: `${before === null ? 'A' : after === null ? 'D' : 'M'} ${p}` });
  }
  outRows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!opts.check) {
    for (const p of [...ws.staged.keys()]) {
      const before = ws.onDisk(p);
      const after = ws.staged.get(p)!;
      if (before === after) continue;
      if (after === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, after);
      }
    }
  }
  const lines = outRows.map((r) => r.text);
  return { code: 0, lines: [...lines, `ok: ${lines.length} ${lines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = execute(process.argv.slice(2));
  writeSync(1, r.lines.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
