export interface TuiFrameLayout {
  height: number;
  bodyRows: number;
  showShortcuts: boolean;
  showStatus: boolean;
}

export interface TuiWidthLayout {
  width: number;
  twoPane: boolean;
}

export type TuiPane = "sessions" | "transcript";
export type TuiView = "both" | TuiPane;

const ANSI_RESET = "\x1b[0m";

export function tuiFrameLayout(terminalRows: number | undefined): TuiFrameLayout {
  const height = Math.max(1, terminalRows || 32);
  const lineBudget = height >= 4 ? height - 1 : height;
  const showStatus = lineBudget >= 3;
  const showShortcuts = lineBudget >= 7;
  const reserved = 2 + Number(showShortcuts) + Number(showStatus);
  return { height, bodyRows: Math.max(0, lineBudget - reserved), showShortcuts, showStatus };
}

export function tuiWidthLayout(terminalColumns: number | undefined): TuiWidthLayout {
  const width = Math.max(1, (terminalColumns || 120) - 1);
  return { width, twoPane: width >= 72 };
}

export function availableTuiBodyRows(terminalRows: number | undefined, fixedRows: number): number {
  const height = Math.max(1, terminalRows || 32);
  const lineBudget = height >= 4 ? height - 1 : height;
  return Math.max(0, lineBudget - fixedRows);
}

export function visibleTuiView(view: TuiView, twoPane: boolean, activePane: TuiPane): TuiView {
  return view === "both" && !twoPane ? activePane : view;
}

export function tuiPageStep(bodyRows: number, pane: TuiPane): number {
  return Math.max(1, pane === "sessions" ? bodyRows : bodyRows - 4);
}

export function sanitizeTuiText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function wrapTuiSourceText(value: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const paragraph of sanitizeTuiText(value).split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    for (let index = 0; index < paragraph.length; index += width) lines.push(paragraph.slice(index, index + width));
  }
  return lines;
}

export function wrapTuiText(value: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let line = "";
  let visible = 0;
  let activeStyle = "";

  const finishLine = () => {
    lines.push(activeStyle ? `${line}${ANSI_RESET}` : line);
    line = activeStyle;
    visible = 0;
  };

  for (let index = 0; index < value.length;) {
    if (value[index] === "\x1b") {
      const sequence = value.slice(index).match(/^\x1b\[[0-9;]*m/)?.[0];
      if (sequence) {
        line += sequence;
        activeStyle = sequence === ANSI_RESET ? "" : `${activeStyle}${sequence}`;
        index += sequence.length;
        continue;
      }
    }
    const character = String.fromCodePoint(value.codePointAt(index)!);
    index += character.length;
    if (character === "\n") {
      finishLine();
      continue;
    }
    if (visible === width) finishLine();
    line += character;
    visible += 1;
  }
  if (line || !lines.length) lines.push(activeStyle ? `${line}${ANSI_RESET}` : line);
  return lines;
}

export function wrapTuiSegments(segments: string[], width: number, separator = "   "): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let current = "";
  const visibleLength = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "").length;

  for (const segment of segments) {
    if (!current) {
      if (visibleLength(segment) <= width) current = segment;
      else lines.push(...wrapTuiText(segment, width));
      continue;
    }
    if (visibleLength(current) + separator.length + visibleLength(segment) <= width) {
      current += `${separator}${segment}`;
    } else {
      lines.push(current);
      current = "";
      if (visibleLength(segment) <= width) current = segment;
      else lines.push(...wrapTuiText(segment, width));
    }
  }
  if (current) lines.push(current);
  return lines;
}
