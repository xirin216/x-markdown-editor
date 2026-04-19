import type { HeadingItem, SearchHit } from "./types";

const markdownPattern = /\.(md|markdown)$/i;

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
