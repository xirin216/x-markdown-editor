import { invoke } from "@tauri-apps/api/core";
import type {
  DropClassification,
  OpenFileResponse,
  SaveFileResponse,
  SearchHit,
  WorkspaceInfo,
} from "./types";

export const WATCH_EVENT_NAME = "fs-event";

type LocalFontAccessFontData = {
  family: string;
};

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontAccessFontData[]>;
  }
}

export function openFileCommand(path: string) {
  return invoke<OpenFileResponse>("open_file", {
    path,
  });
}

export function saveFileCommand(path: string, content: string) {
  return invoke<SaveFileResponse>("save_file", {
    path,
    content,
  });
}

export function openWorkspaceCommand(rootPath: string) {
  return invoke<WorkspaceInfo>("open_workspace", {
    rootPath,
  });
}

export function searchWorkspaceCommand(rootPath: string, query: string) {
  return invoke<SearchHit[]>("search_workspace", {
    rootPath,
    query,
  });
}

export function watchPathsCommand(paths: string[]) {
  return invoke<void>("watch_paths", {
    paths,
  });
}

export function classifyDropPaths(paths: string[]) {
  return invoke<DropClassification>("classify_drop_paths", {
    paths,
  });
}

export async function listSystemFontsCommand() {
  let tauriError: unknown = null;

  try {
    const fonts = await invoke<string[]>("list_system_fonts");
    if (fonts.length > 0) {
      return fonts;
    }
  } catch (error) {
    tauriError = error;
  }

  const browserFonts = await listBrowserLocalFonts();
  if (browserFonts.length > 0) {
    return browserFonts;
  }

  if (tauriError) {
    throw tauriError;
  }

  return [];
}

async function listBrowserLocalFonts() {
  if (typeof window === "undefined" || !window.queryLocalFonts) {
    return [] as string[];
  }

  try {
    const fonts = await window.queryLocalFonts();
    const families = fonts
      .map((font) => font.family.trim())
      .filter(Boolean)
      .sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: "base" }),
      );

    return Array.from(new Set(families));
  } catch {
    return [] as string[];
  }
}
