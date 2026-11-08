/**
 * 读应用日志（`<dev 数据目录>/logs/kabegame.<UTC 日期>.log`），不需要 vite。格式见 `cocs/debug/APP_LOGGING.md`：
 * 文件名按 UTC 日期滚动，行首时间是本地时间，每条 `<日期> <时间>.<毫秒> <级别> <target>: <消息>`，多行消息的续行不带行首。
 *
 * `mark` 记下当前文件与字节偏移；`since` 从标记处读到最新，跨日期时依次读完后面的文件。只按换行切：UTF-8 多字节字符
 * 里不会出现 0x0A，按换行截断不会切坏字符。最后一个文件末尾没写完的半行留到下一次。
 */
import { Buffer } from "node:buffer";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

export const LOG_FILE_RE = /^kabegame\.(\d{4}-\d{2}-\d{2})\.log$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s/;

export const LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

export interface LogMark {
  /** UTC 日期（文件名里的那个）。 */
  date: string;
  /** 文件里的字节偏移。 */
  offset: number;
}

export interface LogFilter {
  /** 正则（不分大小写），对整条日志（含续行）匹配。 */
  grep?: string;
  /** 最低级别；续行跟着所在条目走。 */
  level?: LogLevel;
  /** 最多回多少条（取最后的），缺省 300。 */
  maxEntries?: number;
}

export interface LogRead {
  /** 筛过、截过的日志条目（多行条目原样带换行）。 */
  entries: string[];
  /** 读到的条目数。 */
  total: number;
  /** 筛选后的条目数。 */
  matched: number;
  /** 因为 `maxEntries` 丢掉的（最前面的）条目数。 */
  dropped: number;
}

export interface LogSince extends LogRead {
  /** 下一次 `since` 用这个。 */
  next: LogMark;
  /** 读了哪些文件、各自的字节区间。 */
  files: Array<{ date: string; from: number; to: number; reset?: boolean }>;
}

export const utcDate = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

export const logFileFor = (logDir: string, date: string): string => path.join(logDir, `kabegame.${date}.log`);

export function assertDate(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`日期要写成 YYYY-MM-DD（UTC），收到 ${JSON.stringify(date)}`);
  return date;
}

/** 目录里现有日志的日期，升序。 */
export function listLogDates(logDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(logDir);
  } catch {
    return [];
  }
  return names
    .map((name) => LOG_FILE_RE.exec(name)?.[1])
    .filter((date): date is string => !!date)
    .sort();
}

export const formatMark = (mark: LogMark): string => `${mark.date}@${mark.offset}`;

export function parseMark(text: string): LogMark {
  const match = /^(\d{4}-\d{2}-\d{2})@(\d+)$/.exec(text.trim());
  if (!match)
    throw new Error(`标记要写成 <UTC 日期>@<字节偏移>（app_log mark 的返回值），收到 ${JSON.stringify(text)}`);
  return { date: match[1], offset: Number(match[2]) };
}

const sizeOf = (file: string): number => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/** 当前的标记：今天（UTC）的文件与它现在的大小；文件还没有就是偏移 0。 */
export function markNow(logDir: string, now: Date = new Date()): LogMark & { file: string } {
  const date = utcDate(now);
  const file = logFileFor(logDir, date);
  return { date, offset: sizeOf(file), file };
}

function readRange(file: string, from: number, to: number): Buffer {
  const length = Math.max(0, to - from);
  const buffer = Buffer.alloc(length);
  if (!length) return buffer;
  const fd = openSync(file, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** 把行拼成条目：带行首的一行开一条，续行接在前一条后面。 */
export function toEntries(lines: string[]): string[] {
  const entries: string[] = [];
  for (const line of lines) {
    if (ENTRY_RE.test(line) || !entries.length) entries.push(line);
    else entries[entries.length - 1] += `\n${line}`;
  }
  return entries;
}

export function filterEntries(entries: string[], filter: LogFilter = {}): LogRead {
  let pattern: RegExp | null = null;
  if (filter.grep) {
    try {
      pattern = new RegExp(filter.grep, "i");
    } catch (error) {
      throw new Error(`grep 不是合法的正则：${(error as Error).message}`);
    }
  }
  const min = filter.level ? LEVELS.indexOf(filter.level) : -1;
  const matched = entries.filter((entry) => {
    if (min >= 0) {
      const level = ENTRY_RE.exec(entry)?.[1]?.toLowerCase() as LogLevel | undefined;
      if (!level || LEVELS.indexOf(level) < min) return false;
    }
    return pattern ? pattern.test(entry) : true;
  });
  const max = filter.maxEntries ?? 300;
  const kept = matched.length > max ? matched.slice(matched.length - max) : matched;
  return { entries: kept, total: entries.length, matched: matched.length, dropped: matched.length - kept.length };
}

const splitLines = (buffer: Buffer): string[] => {
  const text = buffer.toString("utf8").replace(/\r/g, "");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/**
 * 从标记读到最新：标记那天的文件从偏移读起，之后每天的文件整份读。最后一个文件只读到最后一个换行。
 * 标记偏移超过文件大小（文件被换过）时那份从头读，`files[].reset` 为 true。
 */
export function readSince(logDir: string, mark: LogMark, filter: LogFilter = {}): LogSince {
  assertDate(mark.date);
  const dates = listLogDates(logDir).filter((date) => date >= mark.date);
  const lines: string[] = [];
  const files: LogSince["files"] = [];
  let next: LogMark = { ...mark };
  dates.forEach((date, index) => {
    const file = logFileFor(logDir, date);
    const size = sizeOf(file);
    let from = date === mark.date ? mark.offset : 0;
    const reset = from > size;
    if (reset) from = 0;
    let chunk = readRange(file, from, size);
    if (index === dates.length - 1) {
      const lastNewline = chunk.lastIndexOf(0x0a);
      chunk = chunk.subarray(0, lastNewline + 1);
    }
    lines.push(...splitLines(chunk));
    const to = from + chunk.length;
    files.push({ date, from, to, ...(reset ? { reset } : {}) });
    next = { date, offset: to };
  });
  return { ...filterEntries(toEntries(lines), filter), next, files };
}

/** 文件最后 `count` 行（从尾部按块往前读，不整份读进来）。 */
export function readTailLines(file: string, count: number): string[] {
  if (!existsSync(file) || count <= 0) return [];
  const size = sizeOf(file);
  const CHUNK = 256 * 1024;
  const chunks: Buffer[] = [];
  let start = size;
  let newlines = 0;
  while (start > 0 && newlines <= count) {
    const from = Math.max(0, start - CHUNK);
    const chunk = readRange(file, from, start);
    for (const byte of chunk) if (byte === 0x0a) newlines++;
    chunks.unshift(chunk);
    start = from;
  }
  const lines = splitLines(Buffer.concat(chunks));
  // 没读到文件头时，第一段是某一行的后半截
  if (start > 0) lines.shift();
  return lines.slice(Math.max(0, lines.length - count));
}

/**
 * 某天（缺省今天 UTC）的最后若干条。不带筛选时只读最后 `lines` 行；带 `grep` / `level` 时整份读进来筛，再取最后的条目。
 */
export function readTail(
  logDir: string,
  options: { date?: string; lines?: number } & LogFilter = {},
): LogRead & { date: string; file: string } {
  const date = assertDate(options.date ?? utcDate());
  const file = logFileFor(logDir, date);
  if (!existsSync(file)) throw new Error(`没有这天的日志：${file}`);
  const lines = options.lines ?? 200;
  if (!options.grep && !options.level) {
    const entries = toEntries(readTailLines(file, lines));
    return { ...filterEntries(entries, { maxEntries: Number.MAX_SAFE_INTEGER }), date, file };
  }
  const entries = toEntries(splitLines(readRange(file, 0, sizeOf(file))));
  return { ...filterEntries(entries, { ...options, maxEntries: options.maxEntries ?? lines }), date, file };
}
