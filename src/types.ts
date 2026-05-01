export type SidebarPanel = "tree" | "outline";
export type WorkspaceTreeNodeKind = "folder" | "file";
export type DragKind = "files" | "folder" | "invalid" | null;
export type TabSyncState = "clean" | "deleted" | "conflict";

export interface DocumentTab {
  path: string;
  title: string;
  content: string;
  savedContent: string;
  dirty: boolean;
  untitled: boolean;
  inWorkspace: boolean;
  lastSavedAt: number | null;
  syncState: TabSyncState;
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface HeadingItem {
  level: number;
  text: string;
  line: number;
}

export interface SidebarState {
  open: boolean;
  activePanel: SidebarPanel;
}

export interface DragState {
  active: boolean;
  acceptedKind: DragKind;
}

export interface OpenFileResponse {
  path: string;
  content: string;
  modifiedAt: number | null;
}

export interface SaveFileResponse {
  path: string;
  modifiedAt: number | null;
}

export interface WorkspaceInfo {
  rootPath: string;
  markdownFileCount: number;
}

export interface WorkspaceTreeNode {
  path: string;
  name: string;
  kind: WorkspaceTreeNodeKind;
  children: WorkspaceTreeNode[];
}

export interface DropClassification {
  kind: "files" | "folder" | "invalid";
  markdownPaths: string[];
  folderPath: string | null;
  rejectedPaths: string[];
  message: string | null;
}

export interface WatchEventPayload {
  path: string;
  kind: "changed" | "deleted";
}
