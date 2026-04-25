import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { confirm, message, open } from "@tauri-apps/plugin-dialog";
import {
  WATCH_EVENT_NAME,
  classifyDropPaths,
  listSystemFontsCommand,
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
import MilkdownEditor from "./MilkdownEditor";
import "./App.css";

type LineJump = {
  path: string;
  line: number;
  column: number;
  needle?: string;
};

const EDITOR_WIDTH_STORAGE_KEY = "x-markdown-editor.editor-width";
const EDITOR_WIDTH_MODE_STORAGE_KEY = "x-markdown-editor.editor-width-mode";
const EDITOR_FONT_SIZE_STORAGE_KEY = "x-markdown-editor.editor-font-size";
const EDITOR_FONT_FAMILY_STORAGE_KEY = "x-markdown-editor.editor-font-family";
const MIN_EDITOR_WIDTH = 900;
const MAX_EDITOR_WIDTH = 1800;
const DEFAULT_EDITOR_WIDTH = 1240;
const MIN_EDITOR_FONT_SIZE = 13;
const MAX_EDITOR_FONT_SIZE = 22;
const DEFAULT_EDITOR_FONT_SIZE = 16;
const DEFAULT_EDITOR_FONT_FAMILY = "Sitka Text";
const FONT_PAGE_SIZE = 8;

type EditorWidthMode = "bounded" | "full";

const fallbackEditorFonts = [
  "Sitka Text",
  "Georgia",
  "Segoe UI",
  "Malgun Gothic",
  "Cascadia Code",
];

const legacyEditorFontFamilies: Record<string, string> = {
  sitka: "Sitka Text",
  georgia: "Georgia",
  segoe: "Segoe UI",
  malgun: "Malgun Gothic",
  cascadia: "Cascadia Code",
};

const defaultSidebarState: SidebarState = {
  open: false,
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editorWidthMode, setEditorWidthMode] = useState<EditorWidthMode>(
    readStoredEditorWidthMode,
  );
  const [editorWidth, setEditorWidth] = useState(readStoredEditorWidth);
  const [editorFontSize, setEditorFontSize] = useState(readStoredEditorFontSize);
  const [editorFontFamily, setEditorFontFamily] = useState(
    readStoredEditorFontFamily,
  );
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [systemFontsLoaded, setSystemFontsLoaded] = useState(false);
  const [fontLoading, setFontLoading] = useState(false);
  const [fontNotice, setFontNotice] = useState("");
  const [fontQuery, setFontQuery] = useState("");
  const [fontPage, setFontPage] = useState(0);

  const tabsRef = useRef(tabs);
  const workspaceRef = useRef(workspace);
  const activePathRef = useRef(activePath);
  const ignoreWatchUntilRef = useRef<Record<string, number>>({});

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
  const activeFileScopeLabel = activeTab
    ? activeTab.inWorkspace
      ? "Workspace file"
      : "Standalone file"
    : "No active file";
  const activeSaveStateLabel = activeTab
    ? activeTab.dirty
      ? "Unsaved changes"
      : "Saved"
    : "Hybrid markdown editor";
  const topbarLocationLabel = activeTab
    ? normalizeDisplayPath(activeTab.path)
    : workspace
      ? `Workspace: ${normalizeDisplayPath(workspace.rootPath)}`
      : "Open a file to begin editing.";
  const activeWidthLabel =
    editorWidthMode === "full" ? "Fit window" : `${editorWidth}px`;
  const activeTextSizeLabel = `${editorFontSize}px`;
  const activeFontLabel = editorFontFamily;
  const fontChoices = useMemo(
    () => buildFontChoices(systemFonts, editorFontFamily),
    [editorFontFamily, systemFonts],
  );
  const filteredFontChoices = useMemo(
    () => filterFontChoices(fontChoices, fontQuery),
    [fontChoices, fontQuery],
  );
  const fontPageCount = Math.max(
    1,
    Math.ceil(filteredFontChoices.length / FONT_PAGE_SIZE),
  );
  const currentFontPage = Math.min(fontPage, fontPageCount - 1);
  const pagedFontChoices = filteredFontChoices.slice(
    currentFontPage * FONT_PAGE_SIZE,
    currentFontPage * FONT_PAGE_SIZE + FONT_PAGE_SIZE,
  );
  const editorPaneStyle = {
    "--editor-content-width":
      editorWidthMode === "full"
        ? "calc(100% - 24px)"
        : `${clampEditorWidth(editorWidth)}px`,
    "--editor-content-padding": editorWidthMode === "full" ? "18px" : "44px",
    "--editor-font-size": `${clampEditorFontSize(editorFontSize)}px`,
    "--editor-font-family": toCssFontFamily(editorFontFamily),
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
    window.localStorage.setItem(
      EDITOR_FONT_SIZE_STORAGE_KEY,
      String(clampEditorFontSize(editorFontSize)),
    );
  }, [editorFontSize]);

  useEffect(() => {
    window.localStorage.setItem(
      EDITOR_FONT_FAMILY_STORAGE_KEY,
      editorFontFamily,
    );
  }, [editorFontFamily]);

  async function loadSystemFonts() {
    if (systemFontsLoaded || fontLoading) {
      return;
    }

    setFontLoading(true);
    setFontNotice("Loading system fonts...");

    try {
      const fonts = await listSystemFontsCommand();
      setSystemFonts(fonts);
      setSystemFontsLoaded(true);
      setFontNotice(
        fonts.length === 0
          ? "No system fonts found. Showing fallback fonts."
          : `${fonts.length} system fonts loaded.`,
      );
    } catch (error) {
      setSystemFontsLoaded(true);
      setFontNotice(`Could not load system fonts. ${asErrorMessage(error)}`);
    } finally {
      setFontLoading(false);
    }
  }

  function toggleSettingsPanel() {
    const nextSettingsOpen = !settingsOpen;
    setSettingsOpen(nextSettingsOpen);

    if (nextSettingsOpen) {
      void loadSystemFonts();
    }
  }

  useEffect(() => {
    setFontPage((currentPage) => Math.min(currentPage, fontPageCount - 1));
  }, [fontPageCount]);

  useEffect(() => {
    if (!activeTab) {
      setEditorReady(false);
    }
  }, [activeTab]);

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

  function handleEditorChange(nextContent: string) {
    const currentPath = activePathRef.current;
    if (!currentPath) {
      return;
    }

    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        normalizePathForKey(tab.path) === normalizePathForKey(currentPath)
          ? {
              ...tab,
              content: nextContent,
              dirty: nextContent !== tab.savedContent,
              syncState: tab.syncState === "deleted" ? "deleted" : tab.syncState,
            }
          : tab,
      ),
    );
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
      const content = activeTab.content;
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

  function handleEditorWidthChange(event: ChangeEvent<HTMLInputElement>) {
    setEditorWidthMode("bounded");
    setEditorWidth(clampEditorWidth(Number(event.currentTarget.value)));
  }

  function resetEditorWidth() {
    setEditorWidthMode("bounded");
    setEditorWidth(DEFAULT_EDITOR_WIDTH);
  }

  function handleEditorFontSizeChange(event: ChangeEvent<HTMLInputElement>) {
    setEditorFontSize(clampEditorFontSize(Number(event.currentTarget.value)));
  }

  function handleFontSearchChange(event: ChangeEvent<HTMLInputElement>) {
    setFontQuery(event.currentTarget.value);
    setFontPage(0);
  }

  function selectEditorFontFamily(fontFamily: string) {
    setEditorFontFamily(coerceEditorFontFamily(fontFamily));
  }

  function resetEditorFontSize() {
    setEditorFontSize(DEFAULT_EDITOR_FONT_SIZE);
  }

  function resetEditorFontFamily() {
    setEditorFontFamily(DEFAULT_EDITOR_FONT_FAMILY);
  }

  const dragCopyText =
    dragState.acceptedKind === "folder"
      ? "Drop the folder to open it as a workspace."
      : dragState.acceptedKind === "files"
        ? "Drop markdown files to open them as tabs."
        : dragState.acceptedKind === "invalid"
          ? "Drop .md or .markdown files, or a single folder."
          : "Drop a markdown file or a single folder.";
  const activeJumpTarget =
    pendingJump &&
    activeTab &&
    normalizePathForKey(pendingJump.path) === normalizePathForKey(activeTab.path)
      ? pendingJump
      : null;
  const activeJumpNeedle = activeJumpTarget && activeTab
    ? activeJumpTarget.needle?.trim() ||
      resolveJumpNeedle(activeTab.content, activeJumpTarget)
    : undefined;
  const activeJumpKey = activeJumpTarget
    ? `${normalizePathForKey(activeJumpTarget.path)}:${activeJumpTarget.line}:${activeJumpTarget.column}:${activeJumpNeedle ?? ""}`
    : undefined;

  return (
    <div className="app-shell">
      <aside
        className={`sidebar ${sidebarState.open ? "sidebar--open" : "sidebar--closed"}`}
      >
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
        <div className="tabs">
          <div className="tabs__main">
            <div className="tabs__panel-switcher" aria-label="Sidebar panels">
              <button
                type="button"
                className={topbarPanelButtonClass(
                  sidebarState.open && sidebarState.activePanel === "search",
                )}
                aria-pressed={sidebarState.open && sidebarState.activePanel === "search"}
                onClick={() => toggleSidebarPanel("search")}
              >
                Search
              </button>
              <button
                type="button"
                className={topbarPanelButtonClass(
                  sidebarState.open && sidebarState.activePanel === "outline",
                )}
                aria-pressed={sidebarState.open && sidebarState.activePanel === "outline"}
                onClick={() => toggleSidebarPanel("outline")}
              >
                Outline
              </button>
            </div>
            <div className="tabs__list">
              {tabs.length === 0 ? (
                <div className="tabs__empty">
                  Drop a markdown file, or open one from disk.
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
              className="tabs__document-path"
              title={activeTab?.path ?? workspace?.rootPath ?? topbarLocationLabel}
            >
              {topbarLocationLabel}
            </div>
          </div>
          <div className="tabs__actions">
            <div className="tabs__badges" aria-label="Active document status">
              <span className={activeTab?.inWorkspace ? "meta-pill" : "meta-pill meta-pill--muted"}>
                {activeFileScopeLabel}
              </span>
              <span className="meta-pill meta-pill--muted">{activeSaveStateLabel}</span>
            </div>
            <button
              type="button"
              className={`tabs__settings-button ${settingsOpen ? "is-active" : ""}`}
              aria-expanded={settingsOpen}
              aria-label="Toggle editor settings"
              onClick={toggleSettingsPanel}
            >
              {settingsOpen ? "Hide settings" : "Settings"}
            </button>
          </div>
        </div>

        {settingsOpen ? (
          <header className="app-header app-header--panel">
            <div className="app-brand">
              <strong className="app-title">Editor settings</strong>
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
                <label className="font-slider">
                  <span>Text size</span>
                  <input
                    type="range"
                    min={MIN_EDITOR_FONT_SIZE}
                    max={MAX_EDITOR_FONT_SIZE}
                    step={1}
                    value={editorFontSize}
                    onChange={handleEditorFontSizeChange}
                    aria-label="Adjust editor text size"
                  />
                  <strong>{activeTextSizeLabel}</strong>
                </label>
                <div className="font-browser">
                  <div className="font-browser__header">
                    <label className="font-search">
                      <span>Font</span>
                      <input
                        type="search"
                        placeholder="Search system fonts..."
                        value={fontQuery}
                        onChange={handleFontSearchChange}
                      />
                    </label>
                    <span className="font-browser__count">
                      {fontLoading
                        ? "Loading..."
                        : `${filteredFontChoices.length} font${
                            filteredFontChoices.length === 1 ? "" : "s"
                          }`}
                    </span>
                  </div>
                  <div className="font-browser__list">
                    {pagedFontChoices.length === 0 ? (
                      <div className="font-browser__empty">No fonts match.</div>
                    ) : (
                      pagedFontChoices.map((fontFamily) => (
                        <button
                          key={fontFamily}
                          type="button"
                          className={`font-choice ${
                            fontFamily === editorFontFamily ? "is-active" : ""
                          }`}
                          style={{ fontFamily: toCssFontFamily(fontFamily) }}
                          onClick={() => selectEditorFontFamily(fontFamily)}
                        >
                          <span>{fontFamily}</span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="font-browser__footer">
                    <span>{fontNotice}</span>
                    <div className="font-browser__pager">
                      <button
                        type="button"
                        onClick={() => setFontPage((page) => Math.max(0, page - 1))}
                        disabled={currentFontPage === 0}
                      >
                        Prev
                      </button>
                      <strong>
                        {currentFontPage + 1} / {fontPageCount}
                      </strong>
                      <button
                        type="button"
                        onClick={() =>
                          setFontPage((page) =>
                            Math.min(fontPageCount - 1, page + 1),
                          )
                        }
                        disabled={currentFontPage >= fontPageCount - 1}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </div>
                <div className="view-options" aria-label="Editor controls">
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
                    Width reset
                  </button>
                  <button type="button" onClick={resetEditorFontSize}>
                    Text reset
                  </button>
                  <button type="button" onClick={resetEditorFontFamily}>
                    Font reset
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
        ) : null}

        {renderSyncBanner()}

        <div
          className="editor-pane"
          data-fit={editorWidthMode}
          style={editorPaneStyle}
        >
          <div className="editor-surface">
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
              {activeTab ? (
                <MilkdownEditor
                  key={activeTab.path}
                  value={activeTab.content}
                  onChange={handleEditorChange}
                  autofocus={!settingsOpen}
                  jumpNeedle={activeJumpNeedle}
                  jumpKey={activeJumpKey}
                  onJumpHandled={() => setPendingJump(null)}
                  onReadyChange={setEditorReady}
                  style={editorPaneStyle}
                />
              ) : null}
            </div>
          </div>
        </div>

        <footer className="app-statusbar">
          <span>{statusMessage}</span>
          <span>Width: {activeWidthLabel}</span>
          <span>Text: {activeTextSizeLabel}</span>
          <span>Font: {activeFontLabel}</span>
          <span>
            {sidebarState.open
              ? sidebarState.activePanel === "search"
                ? "Search panel"
                : "Outline panel"
              : "Panel hidden"}
          </span>
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

function topbarPanelButtonClass(active: boolean) {
  return `tabs__panel-button ${active ? "is-active" : ""}`;
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

function clampEditorFontSize(value: number) {
  return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, value));
}

function coerceEditorFontFamily(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_EDITOR_FONT_FAMILY;
  }

  return legacyEditorFontFamilies[trimmed.toLowerCase()] ?? trimmed;
}

function buildFontChoices(systemFonts: string[], selectedFontFamily: string) {
  const fontMap = new Map<string, string>();

  for (const fontFamily of [
    selectedFontFamily,
    ...(systemFonts.length > 0 ? systemFonts : fallbackEditorFonts),
  ]) {
    const normalized = fontFamily.trim();
    if (!normalized) {
      continue;
    }

    fontMap.set(normalized.toLowerCase(), normalized);
  }

  return Array.from(fontMap.values()).sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

function filterFontChoices(fontChoices: string[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return fontChoices;
  }

  return fontChoices.filter((fontFamily) =>
    fontFamily.toLowerCase().includes(normalizedQuery),
  );
}

function toCssFontFamily(fontFamily: string) {
  const escapedFamily = fontFamily.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escapedFamily}", "Malgun Gothic", "Segoe UI", sans-serif`;
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

function readStoredEditorFontSize() {
  if (typeof window === "undefined") {
    return DEFAULT_EDITOR_FONT_SIZE;
  }

  const stored = Number(window.localStorage.getItem(EDITOR_FONT_SIZE_STORAGE_KEY));
  if (Number.isNaN(stored)) {
    return DEFAULT_EDITOR_FONT_SIZE;
  }

  return clampEditorFontSize(stored);
}

function readStoredEditorFontFamily() {
  if (typeof window === "undefined") {
    return DEFAULT_EDITOR_FONT_FAMILY;
  }

  return coerceEditorFontFamily(
    window.localStorage.getItem(EDITOR_FONT_FAMILY_STORAGE_KEY) ??
      DEFAULT_EDITOR_FONT_FAMILY,
  );
}

export default App;
