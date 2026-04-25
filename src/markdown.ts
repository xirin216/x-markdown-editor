import type { HeadingItem, SearchHit } from "./types";

const markdownPattern = /\.(md|markdown)$/i;
const tagNamePattern = "[A-Za-z][A-Za-z0-9:-]*";
const pairedHtmlLinePattern = new RegExp(
  `^<(${tagNamePattern})(?:\\s[^<>]*)?>[\\s\\S]*<\\/\\1>$`,
);
const openingHtmlLinePattern = new RegExp(
  `^<${tagNamePattern}(?:\\s[^<>]*)?>$`,
);
const closingHtmlLinePattern = new RegExp(`^<\\/${tagNamePattern}\\s*>$`);
const selfClosingHtmlLinePattern = new RegExp(
  `^<${tagNamePattern}(?:\\s[^<>]*)?\\s*\\/>$`,
);
const voidHtmlLinePattern =
  /^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)(?:\s[^<>]*)?>$/i;
const htmlCommentLinePattern = /^<!--[\s\S]*-->$/;
const htmlDeclarationLinePattern = /^<![A-Za-z][^<>]*>$/;
const fenceLinePattern = /^ {0,3}(`{3,}|~{3,})/;
const htmlHardBreakPattern = /<br\s*\/?>/i;
const htmlHardBreakGlobalPattern = /[ \t]*<br\s*\/?>[ \t]*/gi;

export function normalizePathForKey(path: string) {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function getFileName(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() ?? path;
}

export function isInsideWorkspace(path: string, workspaceRoot: string | null) {
  if (!workspaceRoot) {
    return false;
  }

  const root = normalizePathForKey(workspaceRoot).replace(/\/+$/, "");
  const candidate = normalizePathForKey(path);

  return candidate === root || candidate.startsWith(`${root}/`);
}

export function toRelativePath(path: string, workspaceRoot: string | null) {
  if (!workspaceRoot) {
    return getFileName(path);
  }

  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  const rootKey = normalizePathForKey(normalizedRoot);
  const pathKey = normalizePathForKey(normalizedPath);

  if (pathKey.startsWith(`${rootKey}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return getFileName(path);
}

export function extractHeadings(content: string) {
  const headings: HeadingItem[] = [];

  content.split(/\r?\n/).forEach((line, index) => {
    const match = /^ {0,3}(#{1,6})\s+(.*\S.*)\s*$/.exec(line);
    if (!match) {
      return;
    }

    headings.push({
      level: match[1].length,
      text: match[2].trim(),
      line: index + 1,
    });
  });

  return headings;
}

export function searchInDocument(path: string, content: string, query: string) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [] as SearchHit[];
  }

  const queryLower = trimmedQuery.toLowerCase();
  const hits: SearchHit[] = [];

  content.split(/\r?\n/).forEach((line, index) => {
    const lineLower = line.toLowerCase();
    const columnIndex = lineLower.indexOf(queryLower);
    if (columnIndex === -1) {
      return;
    }

    hits.push({
      path,
      line: index + 1,
      column: columnIndex + 1,
      preview: compactPreview(line),
    });
  });

  return hits.slice(0, 250);
}

export function isMarkdownPath(path: string) {
  return markdownPattern.test(path);
}

export function normalizeEscapedHtmlMarkdown(markdown: string) {
  if (!markdown.includes("\\<") && !htmlHardBreakPattern.test(markdown)) {
    return markdown;
  }

  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;

  return markdown
    .split(/(\r\n|\n|\r)/)
    .map((segment, index) => {
      if (index % 2 === 1) {
        return segment;
      }

      const fenceMatch = fenceLinePattern.exec(segment);
      const shouldNormalize = !inFence && !fenceMatch;
      const nextSegment = shouldNormalize ? normalizeMarkdownLine(segment) : segment;

      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!inFence) {
          inFence = true;
          fenceChar = marker[0];
          fenceLength = marker.length;
        } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
          inFence = false;
          fenceChar = "";
          fenceLength = 0;
        }
      }

      return nextSegment;
    })
    .join("");
}

function compactPreview(line: string) {
  const preview = line.trim().replace(/\s+/g, " ");
  if (!preview) {
    return "(blank line)";
  }

  if (preview.length > 140) {
    return `${preview.slice(0, 137)}...`;
  }

  return preview;
}

function normalizeEscapedHtmlLine(line: string) {
  if (!line.includes("\\<") || /^(?: {4,}|\t)/.test(line)) {
    return line;
  }

  const leadingWhitespace = /^\s*/.exec(line)?.[0] ?? "";
  const trailingWhitespace = /\s*$/.exec(line)?.[0] ?? "";
  const body = line.slice(
    leadingWhitespace.length,
    line.length - trailingWhitespace.length,
  );
  const unescapedBody = body.replace(/\\</g, "<").replace(/\\>/g, ">");

  if (unescapedBody === body || !looksLikeHtmlLine(unescapedBody)) {
    return line;
  }

  return `${leadingWhitespace}${unescapedBody}${trailingWhitespace}`;
}

function normalizeMarkdownLine(line: string) {
  return normalizeHtmlHardBreakLine(normalizeEscapedHtmlLine(line));
}

function normalizeHtmlHardBreakLine(line: string) {
  if (
    !htmlHardBreakPattern.test(line) ||
    /^(?: {4,}|\t)/.test(line) ||
    looksLikeHtmlLine(line.trim())
  ) {
    return line;
  }

  return line.replace(htmlHardBreakGlobalPattern, (match, offset) =>
    offset + match.length >= line.length ? "\\" : "\\\n",
  );
}

function looksLikeHtmlLine(value: string) {
  return (
    pairedHtmlLinePattern.test(value) ||
    openingHtmlLinePattern.test(value) ||
    closingHtmlLinePattern.test(value) ||
    selfClosingHtmlLinePattern.test(value) ||
    voidHtmlLinePattern.test(value) ||
    htmlCommentLinePattern.test(value) ||
    htmlDeclarationLinePattern.test(value)
  );
}
