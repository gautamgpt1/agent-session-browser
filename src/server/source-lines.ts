import fs from "node:fs";

export interface SourceLine {
  line: string;
  lineNo: number;
  originalBytes: number;
  truncated: boolean;
}

export interface SourceLineOffset {
  offset: number;
  length: number;
}

export async function* iterateSourceLines(sourcePath: string, maxBytes?: number): AsyncGenerator<SourceLine> {
  const stream = fs.createReadStream(sourcePath, { highWaterMark: 1024 * 1024 });
  let prefixChunks: Buffer[] = [];
  let prefixBytes = 0;
  let originalBytes = 0;
  let truncated = false;
  let lineNo = 0;

  for await (const value of stream) {
    const chunk = value as Buffer;
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(cursor, end);
      originalBytes += part.length;
      if (!truncated) {
        const remaining = maxBytes == null ? part.length : Math.max(0, maxBytes - prefixBytes);
        const retained = part.subarray(0, remaining);
        if (retained.length) {
          prefixChunks.push(Buffer.from(retained));
          prefixBytes += retained.length;
        }
        if (part.length > remaining) truncated = true;
      }

      if (newline === -1) break;
      lineNo += 1;
      yield makeSourceLine(prefixChunks, prefixBytes, lineNo, originalBytes, truncated);
      prefixChunks = [];
      prefixBytes = 0;
      originalBytes = 0;
      truncated = false;
      cursor = newline + 1;
    }
  }

  if (originalBytes > 0 || prefixBytes > 0 || truncated) {
    lineNo += 1;
    yield makeSourceLine(prefixChunks, prefixBytes, lineNo, originalBytes, truncated);
  }
}

export async function buildSourceLineIndex(sourcePath: string): Promise<SourceLineOffset[]> {
  const offsets: SourceLineOffset[] = [];
  const stream = fs.createReadStream(sourcePath, { highWaterMark: 1024 * 1024 });
  let absoluteOffset = 0;
  let lineStart = 0;
  for await (const value of stream) {
    const chunk = value as Buffer;
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      if (newline === -1) break;
      const lineEnd = absoluteOffset + newline;
      offsets.push({ offset: lineStart, length: lineEnd - lineStart });
      lineStart = lineEnd + 1;
      cursor = newline + 1;
    }
    absoluteOffset += chunk.length;
  }
  if (lineStart < absoluteOffset) offsets.push({ offset: lineStart, length: absoluteOffset - lineStart });
  return offsets;
}

export async function readSourceLineAt(sourcePath: string, line: SourceLineOffset): Promise<string> {
  const file = await fs.promises.open(sourcePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(line.length);
    let read = 0;
    while (read < buffer.length) {
      const result = await file.read(buffer, read, buffer.length - read, line.offset + read);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    return decodeLine([buffer.subarray(0, read)], read);
  } finally {
    await file.close();
  }
}

function makeSourceLine(prefixChunks: Buffer[], prefixBytes: number, lineNo: number, originalBytes: number, truncated: boolean): SourceLine {
  return { line: decodeLine(prefixChunks, prefixBytes), lineNo, originalBytes, truncated };
}

function decodeLine(chunks: Buffer[], bytes: number): string {
  const value = Buffer.concat(chunks, bytes);
  const content = value.length && value[value.length - 1] === 0x0d ? value.subarray(0, -1) : value;
  return content.toString("utf8");
}
