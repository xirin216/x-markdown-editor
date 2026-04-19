import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import Vditor from "vditor";
import "vditor/dist/index.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { confirm, message, open } from "@tauri-apps/plugin-dialog";
import {
  WATCH_EVENT_NAME,
  classifyDropPaths,
  openFileCommand,
  openWorkspaceCommand,
  saveFileCommand,
  searchWorkspaceCommand,
  watchPathsCommand,
} from "./commands";
import {
  extractHeadings,
  getFileName,
  isInsideWorkspace,
  normalizePathForKey,
  searchInDocument,
  toRelativePath,
} from "./markdown";
import type {
  DocumentTab,
  DragState,
  HeadingItem,
  SearchHit,
  SidebarState,
  WatchEventPayload,
  WorkspaceInfo,
} from "./types";
import "./App.css";

type LineJump = {
  path: string;
  line: number;
  column: number;
  needle?: string;
};

const EDITOR_WIDTH_STORAGE_KEY = "x-markdown-editor.editor-width";
const EDITOR_WIDTH_MODE_STORAGE_KEY = "x-markdown-editor.editor-width-mode";
const MIN_EDITOR_WIDTH = 900;
const MAX_EDITOR_WIDTH = 1800;
const DEFAULT_EDITOR_WIDTH = 1240;

type EditorWidthMode = "bounded" | "full";

const defaultSidebarState: SidebarState = {
  open: true,
  activePanel: "search",
};

const defaultDragState: DragState = {
  active: false,
  acceptedKind: null,
};

function App() {
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [sidebarState, setSidebarState] = useState<SidebarState>(defaultSidebarState);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchNotice, setSearchNotice] = useState(
    "Open a folder to search across files, or search the active document.",
  );
  const [outline, setOutline] = useState<HeadingItem[]>([]);
  const [dragState, setDragState] = useState<DragState>(defaultDragState);
  const [statusMessage, setStatusMessage] = useState(
    "Open a markdown file or drop one onto the window.",
  );
  const [pendingJump, setPendingJump] = useState<LineJump | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [editorWidthMode, setEditorWidthMode] = useState<EditorWidthMode>(
    readStoredEditorWidthMode,
  );
  const [editorWidth, setEditorWidth] = useState(readStoredEditorWidth);

  const editorHostRef = useRef<HTMLDivElement>(null);
  const vditorRef = useRef<Vditor | null>(null);
  const tabsRef = useRef(tabs);
  const workspaceRef = useRef(workspace);
  const activePathRef = useRef(activePath);
  const editorPathRef = useRef<string | null>(null);
  const editorValueRef = useRef("");
  const ignoreWatchUntilRef = useRef<Record<string, number>>({});
  const suppressInputRef = useRef(false);

  tabsRef.current = tabs;
  workspaceRef.current = workspace;
  activePathRef.current = activePath;

  const activeTab =
    tabs.find(
      (tab) => normalizePathForKey(tab.path) === normalizePathForKey(activePath ?? ""),
    ) ?? null;
  const deferredSearchQuery = useDeferredValue(searchQuery.trim());
  const deferredActiveContent = useDeferredValue(activeTab?.content ?? "");
  const tabPathKey = tabs
    .map((tab) => normalizePathForKey(tab.path))
    .sort()
    .join("|");
  const watchPaths = [
    ...(workspace ? [workspace.rootPath] : []),
    ...tabs
      .filter((tab) => !isInsideWorkspace(tab.path, workspace?.rootPath ?? null))
      .map((tab) => tab.path),
  ];
  const activeLocationLabel = activeTab
    ? normalizeDisplayPath(activeTab.path)
    : workspace
      ? normalizeDisplayPath(workspace.rootPath)
      : "No file open";
  const activeWidthLabel =
    editorWidthMode === "full" ? "Fit window" : `${editorWidth}px`;
  const editorPaneStyle = {
    "--editor-content-width":
      editorWidthMode === "full"
        ? "calc(100% - 24px)"
        : `${clampEditorWidth(editorWidth)}px`,
    "--editor-content-padding": editorWidthMode === "full" ? "18px" : "44px",
  } as CSSProperties;

  useEffect(() => {
    document.title = `${activeTab?.title ?? "untitled.md"} - x markdown editor`;
  }, [activeTab?.title]);

  useEffect(() => {
    window.localStorage.setItem(
      EDITOR_WIDTH_STORAGE_KEY,
      String(clampEditorWidth(editorWidth)),
    );
  }, [editorWidth]);

  useEffect(() => {
    window.localStorage.setItem(EDITOR_WIDTH_MODE_STORAGE_KEY, editorWidthMode);
  }, [editorWidthMode]);

  useEffect(() => {
    if (!editorHostRef.current || vditorRef.current) {
      return;
    }

    let disposed = false;

    const instance = new Vditor(editorHostRef.current, {
      height: "100%",
      mode: "wysiwyg",
      theme: "classic",
      icon: "material",
      lang: "ko_KR",
      cdn: "/vditor",
      cache: {
        enable: false,
      },
      toolbarConfig: {
        pin: true,
        hide: false,
      },
      toolbar: [
        "emoji",
        "headings",
        "bold",
        "italic",
        "strike",
        "link",
        "|",
        "list",
        "ordered-list",
        "check",
        "outdent",
        "indent",
        "|",
        "quote",
        "line",
        "code",
        "inline-code",
        "insert-before",
        "insert-after",
        "|",
        "table",
        "|",
        "undo",
        "redo",
        "|",
        "edit-mode",
        "content-theme",
      ],
      placeholder: "Open a markdown file and start writing.",
      preview: {
        theme: {
          current: "light",
        },
        markdown: {
          toc: true,
        },
      },
      outline: {
        enable: false,
        position: "right",
      },
      hint: {
        parse: true,
        delay: 0,
      },
      input: (value: string) => {
        editorValueRef.current = value;
        if (suppressInputRef.current) {
          return;
        }

        const currentPath = activePathRef.current;
        if (!currentPath) {
          return;
        }

        setTabs((currentTabs) =>
          currentTabs.map((tab) =>
            normalizePathForKey(tab.path) === normalizePathForKey(currentPath)
              ? {
                  ...tab,
                  content: value,
                  dirty: value !== tab.savedContent,
                  syncState: tab.syncState === "deleted" ? "deleted" : tab.syncState,
                }
              : tab,
          ),
        );
      },
      after: () => {
        if (disposed) {
          return;
        }

        vditorRef.current = instance;
        setEditorReady(true);
        syncEditorWithActiveTab(activeTab, true);
      },
    });

    return () => {
      disposed = true;
      setEditorReady(false);
      vditorRef.current = null;
      instance.destroy();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopWatchEvents: (() => void) | undefined;
    let stopDragEvents: (() => void) | undefined;

    const setupListeners = async () => {
      stopWatchEvents = await listen<WatchEventPayload>(
        WATCH_EVENT_NAME,
        ({ payload }) => {
          if (!payload) {
            return;
          }

          const normalized = normalizePathForKey(payload.path);
          const ignoreUntil = ignoreWatchUntilRef.current[normalized] ?? 0;
          if (payload.kind === "changed" && ignoreUntil > Date.now()) {
            return;
          }

          const matchingTab = tabsRef.current.find(
            (tab) => normalizePathForKey(tab.path) === normalized,
          );
          if (!matchingTab) {
            return;
          }

          if (payload.kind === "deleted") {
            setTabs((currentTabs) =>
              currentTabs.map((tab) =>
                normalizePathForKey(tab.path) === normalized
                  ? {
                      ...tab,
                      syncState: "deleted",
                    }
                  : tab,
              ),
            );
            setStatusMessage(`${matchingTab.title} was deleted outside the app.`);
            return;
          }

          if (matchingTab.dirty) {
            setTabs((currentTabs) =>
              currentTabs.map((tab) =>
                normalizePathForKey(tab.path) === normalized
                  ? {
                      ...tab,
                      syncState: "conflict",
                    }
                  : tab,
              ),
            );
            setStatusMessage(
              `${matchingTab.title} changed outside the app while you had unsaved edits.`,
            );
            return;
          }

          void loadMarkdownFile(matchingTab.path, {
            reload: true,
            silent: true,
          })
            .then(() => {
              setStatusMessage(`Reloaded ${matchingTab.title} after an external change.`);
            })
            .catch((error) => {
              setStatusMessage(asErrorMessage(error));
            });
        },
      );

      stopDragEvents = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "enter") {
          setDragState({
            active: true,
            acceptedKind: null,
          });
          void previewDrop(event.payload.paths);
        } else if (event.payload.type === "leave") {
          setDragState(defaultDragState);
        } else if (event.payload.type === "drop") {
          setDragState(defaultDragState);
          void handleDroppedPaths(event.payload.paths);
        }
      });

      if (disposed) {
        stopWatchEvents?.();
        stopDragEvents?.();
      }
    };

    void setupListeners();

    return () => {
      disposed = true;
      stopWatchEvents?.();
      stopDragEvents?.();
    };
  }, []);

  useEffect(() => {
    void watchPathsCommand(watchPaths).catch((error) => {
      console.error(error);
      setStatusMessage(`Watcher error: ${asErrorMessage(error)}`);
    });
  }, [workspace?.rootPath, tabPathKey]);

  useEffect(() => {
    startTransition(() => {
      setOutline(extractHeadings(deferredActiveContent));
    });
  }, [deferredActiveContent]);

  useEffect(() => {
    syncEditorWithActiveTab(activeTab, false);
  }, [activeTab?.path, activeTab?.content, activeTab?.syncState, editorReady]);

  useEffect(() => {
    let cancelled = false;

    const runSearch = async () => {
      if (!deferredSearchQuery) {
        startTransition(() => {
          setSearchResults([]);
          setSearchLoading(false);
          setSearchNotice(
            workspace
              ? "Search the current workspace."
              : activeTab
                ? "Search the active document."
                : "Open a folder to search across files, or search the active document.",
          );
        });
        return;
      }

      if (workspace) {
        setSearchLoading(true);
        try {
          const results = await searchWorkspaceCommand(
            workspace.rootPath,
            deferredSearchQuery,
          );
          if (cancelled) {
            return;
          }
          startTransition(() => {
            setSearchResults(results);
            setSearchLoading(false);
            setSearchNotice(
              results.length > 0
                ? `${results.length} match${results.length === 1 ? "" : "es"} in ${workspace.markdownFileCount} markdown file${workspace.markdownFileCount === 1 ? "" : "s"}.`
                : "No matches in the current workspace.",
            );
          });
        } catch (error) {
          if (cancelled) {
            return;
          }
          startTransition(() => {
            setSearchResults([]);
            setSearchLoading(false);
            setSearchNotice(asErrorMessage(error));
          });
        }
        return;
      }

      if (!activeTab) {
        startTransition(() => {
          setSearchResults([]);
          setSearchLoading(false);
          setSearchNotice("Open a markdown file before searching.");
        });
        return;
      }

      const results = searchInDocument(
        activeTab.path,
        activeTab.content,
        deferredSearchQuery,
      );

      if (cancelled) {
        return;
      }

      startTransition(() => {
        setSearchResults(results);
        setSearchLoading(false);
        setSearchNotice(
          results.length > 0
            ? `${results.length} match${results.length === 1 ? "" : "es"} in the active document.`
            : "No matches in the active document.",
        );
      });
    };

    void runSearch();

    return () => {
      cancelled = true;
    };
  }, [deferredSearchQuery, workspace, activeTab?.path, activeTab?.content]);

  useEffect(() => {
    if (!pendingJump || !activeTab || !editorReady) {
      return;
    }

    if (
      normalizePathForKey(pendingJump.path) !== normalizePathForKey(activeTab.path)
    ) {
      return;
    }

    let attempts = 0;
    let cancelled = false;
    const needle =
      pendingJump.needle?.trim() || resolveJumpNeedle(activeTab.content, pendingJump);

    const focusWhenReady = () => {
      if (cancelled) {
        return;
      }

      const found = needle ? focusEditorNeedle(needle) : scrollEditorToTop();
      attempts += 1;

      if (found || attempts >= 8) {
        setPendingJump(null);
        return;
      }

      window.setTimeout(focusWhenReady, 50);
    };

    window.setTimeout(focusWhenReady, 60);

    return () => {
      cancelled = true;
    };
  }, [pendingJump, activeTab?.path, activeTab?.content, editorReady]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const modifierPressed = event.ctrlKey || event.metaKey;
      if (!modifierPressed) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === "s") {
        event.preventDefault();
        void saveActiveDocument();
        return;
      }

      if (key === "o" && event.shiftKey) {
        event.preventDefault();
        void openFolderFromPicker();
        return;
      }

      if (key === "o") {
        event.preventDefault();
        void openFilesFromPicker();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, workspace, watchPaths.join("|")]);

  function syncEditorWithActiveTab(tab: DocumentTab | null, clearStack: boolean) {
    const editor = vditorRef.current;
    if (!editor) {
      return;
    }

    if (!tab) {
      if (editorPathRef.current !== null || editorValueRef.current !== "") {
        suppressInputRef.current = true;
        editor.setValue("", true);
        editorValueRef.current = "";
        editorPathRef.current = null;
        window.setTimeout(() => {
          suppressInputRef.current = false;
          editor.disabled();
        }, 0);
      } else {
        editor.disabled();
      }
      return;
    }

    editor.enable();

    const currentPathKey = normalizePathForKey(editorPathRef.current ?? "");
    const nextPathKey = normalizePathForKey(tab.path);
    const shouldSync =
      currentPathKey !== nextPathKey || editorValueRef.current !== tab.content;

    if (!shouldSync) {
      return;
    }

    suppressInputRef.current = true;
    editor.setValue(tab.content, clearStack);
    editorValueRef.current = tab.content;
    editorPathRef.current = tab.path;
    window.setTimeout(() => {
      suppressInputRef.current = false;
      editor.focus();
    }, 0);
  }

  async function loadMarkdownFile(
    path: string,
    options?: {
      jump?: LineJump;
      reload?: boolean;
      silent?: boolean;
    },
  ) {
    const normalizedPath = normalizePathForKey(path);
    const existingTab = tabsRef.current.find(
      (tab) => normalizePathForKey(tab.path) === normalizedPath,
    );

    if (existingTab && !options?.reload) {
      setActivePath(existingTab.path);
      if (options?.jump) {
        setPendingJump({
          ...options.jump,
          path: existingTab.path,
          needle:
            options.jump.needle || resolveJumpNeedle(existingTab.content, options.jump),
        });
      }
      return existingTab;
    }

    const file = await openFileCommand(path);
    const tab: DocumentTab = {
      path: file.path,
      title: getFileName(file.path),
      content: file.content,
      savedContent: file.content,
      dirty: false,
      inWorkspace: isInsideWorkspace(file.path, workspaceRef.current?.rootPath ?? null),
      lastSavedAt: file.modifiedAt,
      syncState: "clean",
    };

    setTabs((currentTabs) => {
      const index = currentTabs.findIndex(
        (candidate) =>
          normalizePathForKey(candidate.path) === normalizePathForKey(file.path),
      );
      if (index === -1) {
        return [...currentTabs, tab];
      }

      const nextTabs = [...currentTabs];
      nextTabs[index] = tab;
      return nextTabs;
    });
    setActivePath(file.path);
    if (options?.jump) {
      setPendingJump({
        ...options.jump,
        path: file.path,
        needle: options.jump.needle || resolveJumpNeedle(file.content, options.jump),
      });
    }
    if (!options?.silent) {
      setStatusMessage(`Opened ${getFileName(file.path)}.`);
    }

    return tab;
  }

  async function openFilesFromPicker() {
    const picked = await open({
      title: "Open Markdown Files",
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Markdown",
          extensions: ["md", "markdown"],
        },
      ],
    });

    if (!picked) {
      return;
    }

    const paths = Array.isArray(picked) ? picked : [picked];
    for (const path of paths) {
      await loadMarkdownFile(path);
    }

    if (paths.length > 1) {
      setStatusMessage(`Opened ${paths.length} markdown files.`);
    }
  }

  async function openWorkspaceFolder(rootPath: string) {
    const currentRoot = workspaceRef.current?.rootPath;
    if (
      currentRoot &&
      normalizePathForKey(currentRoot) !== normalizePathForKey(rootPath)
    ) {
      const shouldReplace = await confirm(
        "Replace the current workspace with this folder?",
        {
          title: "Replace workspace",
          kind: "warning",
          okLabel: "Replace",
          cancelLabel: "Keep current",
        },
      );

      if (!shouldReplace) {
        return;
      }
    }

    const nextWorkspace = await openWorkspaceCommand(rootPath);
    setWorkspace(nextWorkspace);
    setTabs((currentTabs) =>
      currentTabs.map((tab) => ({
        ...tab,
        inWorkspace: isInsideWorkspace(tab.path, nextWorkspace.rootPath),
      })),
    );
    setSidebarState({
      open: true,
      activePanel: "search",
    });
    setStatusMessage(`Workspace open: ${nextWorkspace.rootPath}`);
  }

  async function openFolderFromPicker() {
    const picked = await open({
      title: "Open Markdown Workspace",
      directory: true,
      multiple: false,
    });

    if (typeof picked !== "string") {
      return;
    }

    try {
      await openWorkspaceFolder(picked);
    } catch (error) {
      await message(asErrorMessage(error), {
        title: "Open workspace failed",
        kind: "error",
      });
    }
  }

  async function saveActiveDocument() {
    if (!activeTab) {
      return;
    }

    try {
      const content = vditorRef.current?.getValue() ?? activeTab.content;
      const result = await saveFileCommand(activeTab.path, content);
      const normalized = normalizePathForKey(result.path);
      ignoreWatchUntilRef.current[normalized] = Date.now() + 1500;
      void watchPathsCommand(watchPaths).catch((error) => {
        console.error(error);
      });
      setTabs((currentTabs) =>
        currentTabs.map((tab) =>
          normalizePathForKey(tab.path) === normalized
            ? {
                ...tab,
                content,
                savedContent: content,
                dirty: false,
                lastSavedAt: result.modifiedAt,
                syncState: "clean",
              }
            : tab,
        ),
      );
      setStatusMessage(`Saved ${activeTab.title}.`);
    } catch (error) {
      await message(asErrorMessage(error), {
        title: "Save failed",
        kind: "error",
      });
    }
  }

  async function previewDrop(paths: string[]) {
    try {
      const classification = await classifyDropPaths(paths);
      setDragState({
        active: true,
        acceptedKind:
          classification.kind === "invalid" ? "invalid" : classification.kind,
      });
    } catch {
      setDragState({
        active: true,
        acceptedKind: "invalid",
      });
    }
  }

  async function handleDroppedPaths(paths: string[]) {
    try {
      const classification = await classifyDropPaths(paths);

      if (classification.kind === "folder" && classification.folderPath) {
        await openWorkspaceFolder(classification.folderPath);
        return;
      }

      if (classification.kind === "invalid") {
        await message(
          classification.message ?? "Drop a markdown file or a single folder.",
          {
            title: "Unsupported drop",
            kind: "warning",
          },
        );
        return;
      }

      for (const path of classification.markdownPaths) {
        await loadMarkdownFile(path);
      }

      if (classification.rejectedPaths.length > 0) {
        setStatusMessage(
          `Opened ${classification.markdownPaths.length} markdown file${classification.markdownPaths.length === 1 ? "" : "s"} and ignored ${classification.rejectedPaths.length} unsupported item${classification.rejectedPaths.length === 1 ? "" : "s"}.`,
        );
      } else if (classification.markdownPaths.length > 1) {
        setStatusMessage(`Opened ${classification.markdownPaths.length} markdown files.`);
      }
    } catch (error) {
      await message(asErrorMessage(error), {
        title: "Drop failed",
        kind: "error",
      });
    }
  }

  async function closeTab(path: string) {
    const currentTabs = tabsRef.current;
    const tab = currentTabs.find(
      (candidate) => normalizePathForKey(candidate.path) === normalizePathForKey(path),
    );

    if (!tab) {
      return;
    }

    if (tab.dirty) {
      const shouldClose = await confirm(
        `Close ${tab.title} without saving your changes?`,
        {
          title: "Unsaved changes",
          kind: "warning",
          okLabel: "Close anyway",
          cancelLabel: "Keep editing",
        },
      );

      if (!shouldClose) {
        return;
      }
    }

    const currentIndex = currentTabs.findIndex(
      (candidate) => normalizePathForKey(candidate.path) === normalizePathForKey(path),
    );
    const fallbackTab =
      currentTabs[currentIndex + 1] ?? currentTabs[currentIndex - 1] ?? null;

    setTabs((nextTabs) =>
      nextTabs.filter(
        (candidate) => normalizePathForKey(candidate.path) !== normalizePathForKey(path),
      ),
    );

    if (
      normalizePathForKey(activePathRef.current ?? "") === normalizePathForKey(path)
    ) {
      setActivePath(fallbackTab?.path ?? null);
    }
  }

  async function handleSearchHit(hit: SearchHit) {
    try {
      await loadMarkdownFile(hit.path, {
        jump: {
          path: hit.path,
          line: hit.line,
          column: hit.column,
          needle: hit.preview !== "(blank line)" ? hit.preview : undefined,
        },
      });
      setSidebarState((currentSidebar) => ({
        ...currentSidebar,
        open: true,
        activePanel: "search",
      }));
    } catch (error) {
      await message(asErrorMessage(error), {
        title: "Open match failed",
        kind: "error",
      });
    }
  }

  function handleOutlineJump(item: HeadingItem) {
    if (!activeTab) {
      return;
    }

    setPendingJump({
      path: activeTab.path,
      line: item.line,
      column: 1,
      needle: item.text,
    });
  }

  function toggleSidebarPanel(panel: SidebarState["activePanel"]) {
    setSidebarState((currentSidebar) => ({
      open: currentSidebar.activePanel === panel ? !currentSidebar.open : true,
      activePanel: panel,
    }));
  }

  function dismissSyncState() {
    if (!activeTab) {
      return;
    }

    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        normalizePathForKey(tab.path) === normalizePathForKey(activeTab.path)
          ? {
              ...tab,
              syncState: "clean",
            }
          : tab,
      ),
    );
  }

  function renderSyncBanner() {
    if (!activeTab || activeTab.syncState === "clean") {
      return null;
    }

    if (activeTab.syncState === "deleted") {
      return (
        <div className="sync-banner sync-banner--warning">
          <div>
            <strong>{activeTab.title}</strong> was deleted outside the app. Save to
            recreate it or close the tab.
          </div>
          <div className="sync-banner__actions">
            <button type="button" onClick={() => void saveActiveDocument()}>
              Save file
            </button>
            <button type="button" onClick={() => void closeTab(activeTab.path)}>
              Close tab
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="sync-banner sync-banner--danger">
        <div>
          <strong>{activeTab.title}</strong> changed on disk while you had unsaved
          edits. Reload to accept the disk version or save to overwrite it.
        </div>
        <div className="sync-banner__actions">
          <button
            type="button"
            onClick={() =>
              void loadMarkdownFile(activeTab.path, {
                reload: true,
              })
            }
          >
            Reload
          </button>
          <button type="button" onClick={() => void saveActiveDocument()}>
            Save mine
          </button>
          <button type="button" onClick={dismissSyncState}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  function focusEditorNeedle(needle: string) {
    const container =
      editorHostRef.current?.querySelector<HTMLElement>(".vditor-wysiwyg");
    if (!container) {
      return false;
    }

    const normalizedNeedle = needle.trim().toLowerCase();
    if (!normalizedNeedle) {
      return false;
    }

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.textContent ?? "";
        return text.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    let current = walker.nextNode();
    while (current) {
      const text = current.textContent ?? "";
      const index = text.toLowerCase().indexOf(normalizedNeedle);
      if (index !== -1 && current.parentElement) {
        const targetNode = current as Text;
        const safeEnd = Math.min(index + needle.length, targetNode.length);
        const range = document.createRange();
        range.setStart(targetNode, index);
        range.setEnd(targetNode, safeEnd);

        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);

        const block =
          current.parentElement.closest("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, table, div") ??
          current.parentElement;
        block.scrollIntoView({
          block: "center",
          behavior: "auto",
        });
        vditorRef.current?.focus();
        return true;
      }
      current = walker.nextNode();
    }

    return false;
  }

  function scrollEditorToTop() {
    const container =
      editorHostRef.current?.querySelector<HTMLElement>(".vditor-wysiwyg");
    if (!container) {
      return false;
    }

    container.scrollTop = 0;
    return true;
  }

  function handleEditorWidthChange(event: ChangeEvent<HTMLInputElement>) {
    setEditorWidthMode("bounded");
    setEditorWidth(clampEditorWidth(Number(event.currentTarget.value)));
  }

  function resetEditorWidth() {
    setEditorWidthMode("bounded");
    setEditorWidth(DEFAULT_EDITOR_WIDTH);
  }

  const dragCopyText =
    dragState.acceptedKind === "folder"
      ? "Drop the folder to open it as a workspace."
      : dragState.acceptedKind === "files"
        ? "Drop markdown files to open them as tabs."
        : dragState.acceptedKind === "invalid"
          ? "Drop .md or .markdown files, or a single folder."
          : "Drop a markdown file or a single folder.";

  return (
    <div className="app-shell">
      <aside
        className={`sidebar ${sidebarState.open ? "sidebar--open" : "sidebar--closed"}`}
      >
        <div className="sidebar-rail">
          <button
            type="button"
            className={sidebarButtonClass(
              sidebarState.open && sidebarState.activePanel === "search",
            )}
            onClick={() => toggleSidebarPanel("search")}
          >
            Search
          </button>
          <button
            type="button"
            className={sidebarButtonClass(
              sidebarState.open && sidebarState.activePanel === "outline",
            )}
            onClick={() => toggleSidebarPanel("outline")}
          >
            Outline
          </button>
          <button
            type="button"
            className="sidebar-rail__button sidebar-rail__button--ghost"
            onClick={() =>
              setSidebarState((currentSidebar) => ({
                ...currentSidebar,
                open: !currentSidebar.open,
              }))
            }
          >
            {sidebarState.open ? "Hide" : "Show"}
          </button>
        </div>

        <div className="sidebar-panel">
          <div className="sidebar-panel__header">
            <div>
              <h1>
                {sidebarState.activePanel === "search" ? "Search" : "Outline"}
              </h1>
              <p>{activeLocationLabel}</p>
            </div>
            {workspace ? (
              <span className="meta-pill">
                {workspace.markdownFileCount} file
                {workspace.markdownFileCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>

          {sidebarState.activePanel === "search" ? (
            <div className="sidebar-panel__body">
              <label className="panel-field">
                <span>Find text</span>
                <input
                  type="text"
                  placeholder={
                    workspace ? "Search the workspace..." : "Search this file..."
                  }
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.currentTarget.value)}
                />
              </label>
              <p className="panel-note">{searchNotice}</p>
              <div className="search-results">
                {searchLoading ? (
                  <div className="empty-panel">Searching...</div>
                ) : searchResults.length === 0 ? (
                  <div className="empty-panel">No results to show.</div>
                ) : (
                  searchResults.map((result) => (
                    <button
                      key={`${result.path}:${result.line}:${result.column}`}
                      type="button"
                      className="search-hit"
                      onClick={() => void handleSearchHit(result)}
                    >
                      <span className="search-hit__path">
                        {toRelativePath(result.path, workspace?.rootPath ?? null)}
                      </span>
                      <span className="search-hit__preview">{result.preview}</span>
                      <span className="search-hit__meta">
                        Line {result.line}, Col {result.column}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="sidebar-panel__body">
              {outline.length === 0 ? (
                <div className="empty-panel">
                  {activeTab
                    ? "This file has no headings yet."
                    : "Open a markdown file to build an outline."}
                </div>
              ) : (
                <div className="outline-list">
                  {outline.map((item) => (
                    <button
                      key={`${item.line}:${item.text}`}
                      type="button"
                      className="outline-item"
                      style={{
                        paddingLeft: `${Math.max(14 + (item.level - 1) * 16, 14)}px`,
                      }}
                      onClick={() => handleOutlineJump(item)}
                    >
                      <span className="outline-item__level">H{item.level}</span>
                      <span>{item.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      <main className="workspace">
        <header className="app-header">
          <div className="app-brand">
            <strong className="app-title">x markdown editor</strong>
            <span className="app-subtitle">{activeLocationLabel}</span>
          </div>
          <div className="app-controls">
            <div className="width-controls">
              <label className="width-slider">
                <span>Page width</span>
                <input
                  type="range"
                  min={MIN_EDITOR_WIDTH}
                  max={MAX_EDITOR_WIDTH}
                  step={20}
                  value={editorWidth}
                  onChange={handleEditorWidthChange}
                  aria-label="Adjust editor page width"
                />
                <strong>{editorWidthMode === "full" ? "Window" : `${editorWidth}px`}</strong>
              </label>
              <div className="view-options" aria-label="Editor width mode">
                <button
                  type="button"
                  className={editorWidthMode === "bounded" ? "is-active" : undefined}
                  onClick={() => setEditorWidthMode("bounded")}
                >
                  Custom
                </button>
                <button
                  type="button"
                  className={editorWidthMode === "full" ? "is-active" : undefined}
                  onClick={() => setEditorWidthMode("full")}
                >
                  Fit window
                </button>
                <button type="button" onClick={resetEditorWidth}>
                  Reset
                </button>
              </div>
            </div>
            <div className="app-actions">
              <button type="button" onClick={() => void openFilesFromPicker()}>
                Open File
              </button>
              <button type="button" onClick={() => void openFolderFromPicker()}>
                Open Folder
              </button>
              <button
                type="button"
                className="app-actions__primary"
                onClick={() => void saveActiveDocument()}
                disabled={!activeTab || !editorReady}
              >
                Save
              </button>
            </div>
          </div>
        </header>

        {renderSyncBanner()}

        <div className="tabs">
          {tabs.length === 0 ? (
            <div className="tabs__empty">
              Drop a markdown file anywhere on the window, or open one from disk.
            </div>
          ) : (
            tabs.map((tab) => (
              <button
                key={tab.path}
                type="button"
                className={`tab ${activeTab?.path === tab.path ? "tab--active" : ""}`}
                title={tab.path}
                onClick={() => setActivePath(tab.path)}
              >
                <span className="tab__title">{tab.title}</span>
                {tab.dirty ? <span className="tab__dot" /> : null}
                <span className="tab__sync">{tab.syncState === "clean" ? "" : "!"}</span>
                <span
                  className="tab__close"
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTab(tab.path);
                  }}
                >
                  x
                </span>
              </button>
            ))
          )}
        </div>

        <div
          className="editor-pane"
          data-fit={editorWidthMode}
          style={editorPaneStyle}
        >
          <div className="editor-surface">
            <div className="editor-meta">
              <div className="editor-meta__text">
                <strong>{activeTab?.title ?? "No markdown file open"}</strong>
                <span>{activeTab ? normalizeDisplayPath(activeTab.path) : "Open a file to begin editing."}</span>
              </div>
              <div className="editor-meta__badges">
                {activeTab ? (
                  activeTab.inWorkspace ? (
                    <span className="meta-pill">Workspace file</span>
                  ) : (
                    <span className="meta-pill meta-pill--muted">Standalone file</span>
                  )
                ) : (
                  <span className="meta-pill meta-pill--muted">No active file</span>
                )}
                <span className="meta-pill meta-pill--muted">
                  {activeTab
                    ? activeTab.dirty
                      ? "Unsaved changes"
                      : "Saved"
                    : "WYSIWYG editor"}
                </span>
              </div>
            </div>
            <div className="editor-instance">
              {!activeTab ? (
                <div className="empty-state">
                  <div className="empty-state__copy">
                    <strong>No markdown file open</strong>
                    <p>
                      Open a markdown file, open a folder for workspace search, or
                      drop a file directly onto the window.
                    </p>
                    <div className="app-actions">
                      <button type="button" onClick={() => void openFilesFromPicker()}>
                        Open File
                      </button>
                      <button type="button" onClick={() => void openFolderFromPicker()}>
                        Open Folder
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
              <div ref={editorHostRef} className="vditor-host" />
            </div>
          </div>
        </div>

        <footer className="app-statusbar">
          <span>{statusMessage}</span>
          <span>Width: {activeWidthLabel}</span>
          <span>{sidebarState.activePanel === "search" ? "Search panel" : "Outline panel"}</span>
          <span>Ctrl+O Open</span>
          <span>Ctrl+Shift+O Folder</span>
          <span>Ctrl+S Save</span>
        </footer>
      </main>

      {dragState.active ? (
        <div
          className={`drag-overlay ${
            dragState.acceptedKind === "invalid"
              ? "drag-overlay--invalid"
              : "drag-overlay--valid"
          }`}
        >
          <div className="drag-overlay__card">
            <span className="drag-overlay__eyebrow">Drag and drop</span>
            <strong>{dragCopyText}</strong>
            <span>Files open as tabs. One folder becomes the active workspace.</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function sidebarButtonClass(active: boolean) {
  return `sidebar-rail__button ${active ? "sidebar-rail__button--active" : ""}`;
}

function normalizeDisplayPath(path: string) {
  return path.replace(/\\/g, "/");
}

function resolveJumpNeedle(content: string, jump: LineJump) {
  const lines = content.split(/\r?\n/);
  const line = lines[Math.max(jump.line - 1, 0)] ?? "";
  const trimmed = line.trim();
  if (trimmed) {
    return trimmed;
  }

  return lines.find((candidate) => candidate.trim())?.trim() ?? "";
}

function asErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function clampEditorWidth(value: number) {
  return Math.min(MAX_EDITOR_WIDTH, Math.max(MIN_EDITOR_WIDTH, value));
}

function readStoredEditorWidth() {
  if (typeof window === "undefined") {
    return DEFAULT_EDITOR_WIDTH;
  }

  const stored = Number(window.localStorage.getItem(EDITOR_WIDTH_STORAGE_KEY));
  if (Number.isNaN(stored)) {
    return DEFAULT_EDITOR_WIDTH;
  }

  return clampEditorWidth(stored);
}

function readStoredEditorWidthMode(): EditorWidthMode {
  if (typeof window === "undefined") {
    return "bounded";
  }

  return window.localStorage.getItem(EDITOR_WIDTH_MODE_STORAGE_KEY) === "full"
    ? "full"
    : "bounded";
}

export default App;
