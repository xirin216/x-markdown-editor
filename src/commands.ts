import { invoke } from "@tauri-apps/api/core";
import type {
  DropClassification,
  OpenFileResponse,
  SaveFileResponse,
  SearchHit,
  WorkspaceInfo,
} from "./types";

export const WATCH_EVENT_NAME = "fs-event";

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
