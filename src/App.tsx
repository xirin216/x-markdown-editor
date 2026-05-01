import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { confirm, message, open, save } from "@tauri-apps/plugin-dialog";
import {
  WATCH_EVENT_NAME,
  classifyDropPaths,
  createWorkspaceMarkdownFileCommand,
  deleteWorkspaceMarkdownFileCommand,
  listWorkspaceTreeCommand,
  listSystemFontsCommand,
  moveWorkspaceMarkdownFileCommand,
  openFileCommand,
  openWorkspaceCommand,
  saveFileCommand,
  searchWorkspaceCommand,
  startupFilePathsCommand,
  watchPathsCommand,
} from "./commands";
import {
  extractHeadings,
  getFileName,
  isInsideWorkspace,
  normalizeObsidianMarkdown,
  normalizePathForKey,
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
  WorkspaceTreeNode,
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
const EDITOR_LINE_HEIGHT_STORAGE_KEY = "x-markdown-editor.editor-line-height";
const EDITOR_FONT_FAMILY_STORAGE_KEY = "x-markdown-editor.editor-font-family";
const EDITOR_TOOLBAR_VISIBLE_STORAGE_KEY = "x-markdown-editor.toolbar-visible";
const HEADER_THEME_MODE_STORAGE_KEY = "x-markdown-editor.header-theme-mode";
const HEADER_MANUAL_COLORS_STORAGE_KEY =
  "x-markdown-editor.header-manual-colors";
const UNTITLED_PATH_PREFIX = "untitled:";
const MIN_EDITOR_WIDTH = 900;
const MAX_EDITOR_WIDTH = 1800;
const DEFAULT_EDITOR_WIDTH = 1240;
const DEFAULT_EDITOR_FONT_SIZE = 16;
const MIN_EDITOR_FONT_SIZE = DEFAULT_EDITOR_FONT_SIZE - 10;
const MAX_EDITOR_FONT_SIZE = DEFAULT_EDITOR_FONT_SIZE + 10;
const DEFAULT_EDITOR_LINE_HEIGHT = 1.6;
const MIN_EDITOR_LINE_HEIGHT = 1.0;
const MAX_EDITOR_LINE_HEIGHT = 2.4;
const DEFAULT_EDITOR_FONT_FAMILY = "Sitka Text";
const FONT_PAGE_SIZE = 8;

type EditorWidthMode = "bounded" | "full";
type HeaderThemeMode = "none" | "level" | "fade" | "manual";
type TreeSearchMode = "files" | "content";

const HEADER_LEVELS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
type HeaderLevel = (typeof HEADER_LEVELS)[number];
type HeaderColorMap = Record<HeaderLevel, string>;

const HEADER_THEME_MODES: HeaderThemeMode[] = [
  "none",
  "level",
  "fade",
  "manual",
];

const HEADER_THEME_LABELS: Record<HeaderThemeMode, string> = {
  none: "None",
  level: "Level colors",
  fade: "Soft fade",
  manual: "Manual",
};

const TRANSPARENT_HEADER_COLORS: HeaderColorMap = {
  h1: "transparent",
  h2: "transparent",
  h3: "transparent",
  h4: "transparent",
  h5: "transparent",
  h6: "transparent",
};

const LEVEL_HEADER_COLORS: HeaderColorMap = {
  h1: "#fee2e2",
  h2: "#ffedd5",
  h3: "#fef9c3",
  h4: "#dcfce7",
  h5: "#dbeafe",
  h6: "#ede9fe",
};

const FADE_HEADER_COLORS: HeaderColorMap = {
  h1: "#bfdbfe",
  h2: "#dbeafe",
  h3: "#e0f2fe",
  h4: "#ecfeff",
  h5: "#f0f9ff",
  h6: "#f8fbff",
};

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
  activePanel: "tree",
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
  const [workspaceTree, setWorkspaceTree] = useState<WorkspaceTreeNode[]>([]);
  const [expandedTreePaths, setExpandedTreePaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeNotice, setTreeNotice] = useState("");
  const [treeSearchMode, setTreeSearchMode] = useState<TreeSearchMode>("files");
  const [treeSearchQuery, setTreeSearchQuery] = useState("");
  const [contentSearchResults, setContentSearchResults] = useState<SearchHit[]>([]);
  const [contentSearchLoading, setContentSearchLoading] = useState(false);
  const [contentSearchError, setContentSearchError] = useState("");
  const [contentSearchSubmittedQuery, setContentSearchSubmittedQuery] =
    useState("");
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);
  const [draggingTreeFilePath, setDraggingTreeFilePath] = useState<string | null>(
    null,
  );
  const [treeDropTargetPath, setTreeDropTargetPath] = useState<string | null>(
    null,
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
  const [editorLineHeight, setEditorLineHeight] = useState(
    readStoredEditorLineHeight,
  );
  const [editorFontFamily, setEditorFontFamily] = useState(
    readStoredEditorFontFamily,
  );
  const [toolbarVisible, setToolbarVisible] = useState(readStoredToolbarVisible);
  const [headerThemeMode, setHeaderThemeMode] = useState<HeaderThemeMode>(
    readStoredHeaderThemeMode,
  );
  const [manualHeaderColors, setManualHeaderColors] = useState(
    readStoredManualHeaderColors,
  );
  const [manualHeaderColorInputs, setManualHeaderColorInputs] =
    useState<HeaderColorMap>(() => manualHeaderColors);
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
  const contentSearchRequestRef = useRef(0);

  tabsRef.current = tabs;
  workspaceRef.current = workspace;
  activePathRef.current = activePath;

  const activeTab =
    tabs.find(
      (tab) => normalizePathForKey(tab.path) === normalizePathForKey(activePath ?? ""),
    ) ?? null;
  const deferredActiveContent = useDeferredValue(activeTab?.content ?? "");
  const tabPathKey = tabs
    .filter((tab) => !tab.untitled)
    .map((tab) => normalizePathForKey(tab.path))
    .sort()
    .join("|");
  const watchPaths = [
    ...(workspace ? [workspace.rootPath] : []),
    ...tabs
      .filter(
        (tab) =>
          !tab.untitled && !isInsideWorkspace(tab.path, workspace?.rootPath ?? null),
      )
      .map((tab) => tab.path),
  ];
  const activeLocationLabel = activeTab
    ? activeTab.untitled
      ? activeTab.title
      : normalizeDisplayPath(activeTab.path)
    : workspace
      ? normalizeDisplayPath(workspace.rootPath)
      : "No file open";
  const activeSaveStateLabel = activeTab
    ? activeTab.dirty
      ? "Unsaved changes"
      : "Saved"
    : "Hybrid markdown editor";
  const topbarLocationLabel = activeTab
    ? activeTab.untitled
      ? activeTab.title
      : normalizeDisplayPath(activeTab.path)
    : workspace
      ? `Workspace: ${normalizeDisplayPath(workspace.rootPath)}`
      : "Open a file to begin editing.";
  const activeWidthLabel =
    editorWidthMode === "full" ? "Fit window" : `${editorWidth}px`;
  const activeTextSizeLabel = formatEditorTextScale(editorFontSize);
  const activeLineHeightLabel = formatEditorLineHeight(editorLineHeight);
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
  const trimmedTreeSearchQuery = treeSearchQuery.trim();
  const treeFileSearchActive =
    treeSearchMode === "files" && trimmedTreeSearchQuery.length > 0;
  const filteredWorkspaceTree = useMemo(
    () =>
      treeFileSearchActive
        ? filterWorkspaceTreeNodes(
            workspaceTree,
            workspace?.rootPath ?? "",
            trimmedTreeSearchQuery,
          )
        : workspaceTree,
    [treeFileSearchActive, trimmedTreeSearchQuery, workspace?.rootPath, workspaceTree],
  );
  const selectedTreeNode = selectedTreePath
    ? findWorkspaceTreeNode(workspaceTree, selectedTreePath)
    : null;
  const selectedTreeCreateParent =
    selectedTreeNode?.kind === "folder"
      ? selectedTreeNode.path
      : selectedTreeNode?.kind === "file"
        ? getParentPath(selectedTreeNode.path)
        : null;
  const treeLocationPath =
    selectedTreeNode?.kind === "folder"
      ? selectedTreeNode.path
      : selectedTreeNode?.kind === "file"
        ? getParentPath(selectedTreeNode.path)
        : workspace?.rootPath ?? null;
  const sidebarLocationLabel =
    sidebarState.activePanel === "tree"
      ? treeLocationPath
        ? normalizeDisplayPath(treeLocationPath)
        : "Open a folder to browse files."
      : activeLocationLabel;
  const editorContentWidth =
    editorWidthMode === "full"
      ? "calc(100% - 24px)"
      : `${clampEditorWidth(editorWidth)}px`;
  const editorContentPadding = editorWidthMode === "full" ? "18px" : "44px";
  const editorBaseFontSize = `${clampEditorFontSize(editorFontSize)}px`;
  const editorLineHeightCss = formatLineHeightCssValue(editorLineHeight);
  const editorFontFamilyCss = toCssFontFamily(editorFontFamily);
  const activeHeaderColors = resolveHeaderThemeColors(
    headerThemeMode,
    manualHeaderColors,
  );
  const headerThemeUsesChrome = headerThemeMode !== "none";
  const headerHeadingPaddingX = headerThemeUsesChrome ? "10px" : "0px";
  const headerHeadingPaddingY = headerThemeUsesChrome ? "5px" : "0px";
  const headerHeadingRadius = headerThemeUsesChrome ? "8px" : "0px";
  const editorPaneStyle = {
    "--editor-content-width": editorContentWidth,
    "--editor-content-padding": editorContentPadding,
    "--editor-font-size": editorBaseFontSize,
    "--editor-line-height": editorLineHeightCss,
    "--editor-font-family": editorFontFamilyCss,
    "--editor-heading-bg-h1": activeHeaderColors.h1,
    "--editor-heading-bg-h2": activeHeaderColors.h2,
    "--editor-heading-bg-h3": activeHeaderColors.h3,
    "--editor-heading-bg-h4": activeHeaderColors.h4,
    "--editor-heading-bg-h5": activeHeaderColors.h5,
    "--editor-heading-bg-h6": activeHeaderColors.h6,
    "--editor-heading-padding-x": headerHeadingPaddingX,
    "--editor-heading-padding-y": headerHeadingPaddingY,
    "--editor-heading-radius": headerHeadingRadius,
  } as CSSProperties;

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--editor-content-width", editorContentWidth);
    root.style.setProperty("--editor-content-padding", editorContentPadding);
    root.style.setProperty("--editor-font-size", editorBaseFontSize);
    root.style.setProperty("--editor-line-height", editorLineHeightCss);
    root.style.setProperty("--editor-font-family", editorFontFamilyCss);
    root.style.setProperty("--editor-heading-bg-h1", activeHeaderColors.h1);
    root.style.setProperty("--editor-heading-bg-h2", activeHeaderColors.h2);
    root.style.setProperty("--editor-heading-bg-h3", activeHeaderColors.h3);
    root.style.setProperty("--editor-heading-bg-h4", activeHeaderColors.h4);
    root.style.setProperty("--editor-heading-bg-h5", activeHeaderColors.h5);
    root.style.setProperty("--editor-heading-bg-h6", activeHeaderColors.h6);
    root.style.setProperty("--editor-heading-padding-x", headerHeadingPaddingX);
    root.style.setProperty("--editor-heading-padding-y", headerHeadingPaddingY);
    root.style.setProperty("--editor-heading-radius", headerHeadingRadius);
  }, [
    activeHeaderColors.h1,
    activeHeaderColors.h2,
    activeHeaderColors.h3,
    activeHeaderColors.h4,
    activeHeaderColors.h5,
    activeHeaderColors.h6,
    editorBaseFontSize,
    editorContentPadding,
    editorContentWidth,
    editorLineHeightCss,
    editorFontFamilyCss,
    headerHeadingPaddingX,
    headerHeadingPaddingY,
    headerHeadingRadius,
  ]);

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
      EDITOR_LINE_HEIGHT_STORAGE_KEY,
      formatLineHeightCssValue(editorLineHeight),
    );
  }, [editorLineHeight]);

  useEffect(() => {
    window.localStorage.setItem(
      EDITOR_FONT_FAMILY_STORAGE_KEY,
      editorFontFamily,
    );
  }, [editorFontFamily]);

  useEffect(() => {
    window.localStorage.setItem(
      EDITOR_TOOLBAR_VISIBLE_STORAGE_KEY,
      toolbarVisible ? "true" : "false",
    );
  }, [toolbarVisible]);

  useEffect(() => {
    window.localStorage.setItem(HEADER_THEME_MODE_STORAGE_KEY, headerThemeMode);
  }, [headerThemeMode]);

  useEffect(() => {
    window.localStorage.setItem(
      HEADER_MANUAL_COLORS_STORAGE_KEY,
      JSON.stringify(manualHeaderColors),
    );
  }, [manualHeaderColors]);

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
          if (ignoreUntil > Date.now()) {
            return;
          }

          const currentWorkspace = workspaceRef.current;
          if (
            currentWorkspace &&
            isInsideWorkspace(payload.path, currentWorkspace.rootPath)
          ) {
            void reloadWorkspace(currentWorkspace.rootPath, { silent: true });
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
    let disposed = false;

    const openStartupFiles = async () => {
      const paths = await startupFilePathsCommand();
      if (disposed || paths.length === 0) {
        return;
      }

      for (const path of paths) {
        if (disposed) {
          return;
        }

        await loadMarkdownFile(path, {
          silent: paths.length > 1,
        });
      }

      if (paths.length > 1) {
        setStatusMessage(`Opened ${paths.length} markdown files from launch.`);
      }
    };

    void openStartupFiles().catch((error) => {
      if (!disposed) {
        setStatusMessage(`Launch file open failed: ${asErrorMessage(error)}`);
      }
    });

    return () => {
      disposed = true;
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
    const handleKeyDown = (event: KeyboardEvent) => {
      const modifierPressed = event.ctrlKey || event.metaKey;
      if (!modifierPressed) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === "n") {
        event.preventDefault();
        createNewDocument();
        return;
      }

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
                dirty: tab.untitled ? true : nextContent !== tab.savedContent,
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
      if (isInsideWorkspace(existingTab.path, workspaceRef.current?.rootPath ?? null)) {
        setSelectedTreePath(existingTab.path);
      }
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
      untitled: false,
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
    if (isInsideWorkspace(file.path, workspaceRef.current?.rootPath ?? null)) {
      setSelectedTreePath(file.path);
    }
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

  async function reloadWorkspace(
    rootPath: string,
    options?: {
      silent?: boolean;
      resetExpanded?: boolean;
    },
  ) {
    setTreeLoading(true);

    try {
      const [nextWorkspace, nextTree] = await Promise.all([
        openWorkspaceCommand(rootPath),
        listWorkspaceTreeCommand(rootPath),
      ]);

      setWorkspace(nextWorkspace);
      setWorkspaceTree(nextTree);
      if (options?.resetExpanded) {
        setExpandedTreePaths(new Set());
      }
      contentSearchRequestRef.current += 1;
      setTreeNotice("");
      setContentSearchResults([]);
      setContentSearchLoading(false);
      setContentSearchError("");
      setContentSearchSubmittedQuery("");
      setTabs((currentTabs) =>
        currentTabs.map((tab) => ({
          ...tab,
          inWorkspace:
            !tab.untitled && isInsideWorkspace(tab.path, nextWorkspace.rootPath),
        })),
      );

      return nextWorkspace;
    } catch (error) {
      const errorMessage = asErrorMessage(error);
      setWorkspaceTree([]);
      setTreeNotice(errorMessage);
      if (!options?.silent) {
        setStatusMessage(errorMessage);
      }
      throw error;
    } finally {
      setTreeLoading(false);
    }
  }

  function createNewDocument() {
    const title = createUntitledTitle(tabsRef.current);
    const path = `${UNTITLED_PATH_PREFIX}${Date.now()}:${tabsRef.current.length + 1}`;
    const tab: DocumentTab = {
      path,
      title,
      content: "",
      savedContent: "",
      dirty: true,
      untitled: true,
      inWorkspace: false,
      lastSavedAt: null,
      syncState: "clean",
    };

    setTabs((currentTabs) => [...currentTabs, tab]);
    setActivePath(path);
    setSelectedTreePath(null);
    setStatusMessage(`Started ${title}.`);
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

    const nextWorkspace = await reloadWorkspace(rootPath, {
      resetExpanded: true,
    });
    setSelectedTreePath(null);
    setSidebarState({
      open: true,
      activePanel: "tree",
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

    if (!activeTab.untitled && !activeTab.dirty) {
      setStatusMessage(`No changes to save for ${activeTab.title}.`);
      return;
    }

    try {
      let targetPath = activeTab.path;
      if (activeTab.untitled) {
        const pickedPath = await save({
          title: "Save Markdown File",
          defaultPath: activeTab.title,
          filters: [
            {
              name: "Markdown",
              extensions: ["md", "markdown"],
            },
          ],
        });

        if (!pickedPath) {
          return;
        }

        targetPath = addMarkdownExtensionIfMissing(pickedPath);
        const targetKey = normalizePathForKey(targetPath);
        const alreadyOpenTab = tabsRef.current.find(
          (tab) => !tab.untitled && normalizePathForKey(tab.path) === targetKey,
        );
        if (alreadyOpenTab) {
          await message(
            `${alreadyOpenTab.title} is already open. Choose another file name or close the existing tab first.`,
            {
              title: "File already open",
              kind: "warning",
            },
          );
          return;
        }
      }

      const content = normalizeObsidianMarkdown(activeTab.content);
      const result = await saveFileCommand(targetPath, content);
      const previousKey = normalizePathForKey(activeTab.path);
      const normalized = normalizePathForKey(result.path);
      ignoreWatchUntilRef.current[normalized] = Date.now() + 1500;
      void watchPathsCommand(watchPaths).catch((error) => {
        console.error(error);
      });
      setTabs((currentTabs) =>
        currentTabs.map((tab) =>
          normalizePathForKey(tab.path) === previousKey
            ? {
                ...tab,
                path: result.path,
                title: getFileName(result.path),
                content,
                savedContent: content,
                dirty: false,
                untitled: false,
                inWorkspace: isInsideWorkspace(
                  result.path,
                  workspaceRef.current?.rootPath ?? null,
                ),
                lastSavedAt: result.modifiedAt,
                syncState: "clean",
              }
            : tab,
        ),
      );
      if (normalizePathForKey(activePathRef.current ?? "") === previousKey) {
        setActivePath(result.path);
      }

      const currentWorkspace = workspaceRef.current;
      if (
        activeTab.untitled &&
        currentWorkspace &&
        isInsideWorkspace(result.path, currentWorkspace.rootPath)
      ) {
        await reloadWorkspace(currentWorkspace.rootPath, { silent: true });
        expandTreeAncestors(result.path, currentWorkspace.rootPath);
        setSelectedTreePath(result.path);
      }

      setStatusMessage(`Saved ${getFileName(result.path)}.`);
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

  async function handleTreeNodeClick(node: WorkspaceTreeNode) {
    setSelectedTreePath(node.path);

    if (node.kind === "folder") {
      toggleTreeFolder(node.path);
      return;
    }

    if (node.kind !== "file") {
      return;
    }

    try {
      await loadMarkdownFile(node.path);
      setSidebarState((currentSidebar) => ({
        ...currentSidebar,
        open: true,
        activePanel: "tree",
      }));
    } catch (error) {
      await message(asErrorMessage(error), {
        title: "Open file failed",
        kind: "error",
      });
    }
  }

  async function createTreeFile() {
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace) {
      setStatusMessage("Open a folder before creating a markdown file.");
      return;
    }

    const fileName = window.prompt("New markdown file name", "untitled.md");
    if (fileName === null) {
      return;
    }

    try {
      const file = await createWorkspaceMarkdownFileCommand(
        currentWorkspace.rootPath,
        selectedTreeCreateParent,
        fileName,
      );
      await reloadWorkspace(currentWorkspace.rootPath, { silent: true });
      expandTreeAncestors(file.path, currentWorkspace.rootPath);
      setSelectedTreePath(file.path);
      await loadMarkdownFile(file.path, { silent: true });
      setStatusMessage(
        `Created ${toRelativePath(file.path, currentWorkspace.rootPath)}.`,
      );
    } catch (error) {
      await message(asErrorMessage(error), {
        title: "Create file failed",
        kind: "error",
      });
    }
  }

  async function deleteSelectedTreeFile() {
    const currentWorkspace = workspaceRef.current;
    const targetNode = selectedTreeNode;

    if (!currentWorkspace || targetNode?.kind !== "file") {
      return;
    }

    const relativePath = toRelativePath(targetNode.path, currentWorkspace.rootPath);
    const matchingTab = tabsRef.current.find(
      (tab) =>
        normalizePathForKey(tab.path) === normalizePathForKey(targetNode.path),
    );
    const shouldDelete = await confirm(
      matchingTab?.dirty
        ? `Delete ${relativePath}? The open tab has unsaved changes. This cannot be undone.`
        : `Delete ${relativePath}? This cannot be undone.`,
      {
        title: "Delete markdown file",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      },
    );

    if (!shouldDelete) {
      return;
    }

    try {
      const deletedPath = await deleteWorkspaceMarkdownFileCommand(
        currentWorkspace.rootPath,
        targetNode.path,
      );
      const normalizedDeletedPath = normalizePathForKey(deletedPath);
      const currentTabs = tabsRef.current;
      const deletedTabIndex = currentTabs.findIndex(
        (tab) => normalizePathForKey(tab.path) === normalizedDeletedPath,
      );
      const fallbackTab =
        currentTabs[deletedTabIndex + 1] ??
        currentTabs[deletedTabIndex - 1] ??
        null;

      setTabs((nextTabs) =>
        nextTabs.filter(
          (tab) => normalizePathForKey(tab.path) !== normalizedDeletedPath,
        ),
      );

      if (
        normalizePathForKey(activePathRef.current ?? "") === normalizedDeletedPath
      ) {
        setActivePath(fallbackTab?.path ?? null);
      }

      setSelectedTreePath(null);
      await reloadWorkspace(currentWorkspace.rootPath, { silent: true });
      setStatusMessage(`Deleted ${relativePath}.`);
    } catch (error) {
      await message(asErrorMessage(error), {
        title: "Delete file failed",
        kind: "error",
      });
    }
  }

  function handleTreeFileDragStart(
    event: DragEvent<HTMLButtonElement>,
    node: WorkspaceTreeNode,
  ) {
    if (node.kind !== "file") {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", node.path);
    event.dataTransfer.setData("application/x-markdown-editor-tree-file", node.path);
    setDraggingTreeFilePath(node.path);
  }

  function handleTreeFileDragEnd() {
    setDraggingTreeFilePath(null);
    setTreeDropTargetPath(null);
  }

  function handleTreeFolderDragOver(
    event: DragEvent<HTMLButtonElement>,
    node: WorkspaceTreeNode,
  ) {
    if (node.kind !== "folder" || !draggingTreeFilePath) {
      return;
    }

    if (!canMoveTreeFileToFolder(draggingTreeFilePath, node.path)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setTreeDropTargetPath(node.path);
  }

  function handleTreeFolderDragLeave(event: DragEvent<HTMLButtonElement>) {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget)
    ) {
      return;
    }

    setTreeDropTargetPath(null);
  }

  async function handleTreeFolderDrop(
    event: DragEvent<HTMLButtonElement>,
    node: WorkspaceTreeNode,
  ) {
    event.preventDefault();
    event.stopPropagation();

    const sourcePath =
      draggingTreeFilePath ||
      event.dataTransfer.getData("application/x-markdown-editor-tree-file") ||
      event.dataTransfer.getData("text/plain");

    setDraggingTreeFilePath(null);
    setTreeDropTargetPath(null);

    if (node.kind !== "folder" || !sourcePath) {
      return;
    }

    await moveTreeFileToFolder(sourcePath, node.path);
  }

  function canMoveTreeFileToFolder(sourcePath: string, targetDir: string) {
    const sourceNode = findWorkspaceTreeNode(workspaceTree, sourcePath);
    if (sourceNode?.kind !== "file") {
      return false;
    }

    return (
      normalizePathForKey(getParentPath(sourcePath)) !==
      normalizePathForKey(targetDir)
    );
  }

  async function moveTreeFileToFolder(sourcePath: string, targetDir: string) {
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace) {
      return;
    }

    if (!canMoveTreeFileToFolder(sourcePath, targetDir)) {
      setStatusMessage("The file is already in that folder.");
      return;
    }

    const sourceKey = normalizePathForKey(sourcePath);
    const predictedTargetPath = joinPathForDisplay(targetDir, getFileName(sourcePath));
    ignoreWatchUntilRef.current[sourceKey] = Date.now() + 1500;
    ignoreWatchUntilRef.current[normalizePathForKey(predictedTargetPath)] =
      Date.now() + 1500;

    try {
      const movedFile = await moveWorkspaceMarkdownFileCommand(
        currentWorkspace.rootPath,
        sourcePath,
        targetDir,
      );
      const movedKey = normalizePathForKey(movedFile.path);
      ignoreWatchUntilRef.current[sourceKey] = Date.now() + 1500;
      ignoreWatchUntilRef.current[movedKey] = Date.now() + 1500;

      setTabs((currentTabs) =>
        currentTabs.map((tab) => {
          if (normalizePathForKey(tab.path) !== sourceKey) {
            return tab;
          }

          return {
            ...tab,
            path: movedFile.path,
            title: getFileName(movedFile.path),
            content: tab.dirty ? tab.content : movedFile.content,
            savedContent: movedFile.content,
            lastSavedAt: movedFile.modifiedAt,
            syncState: "clean",
          };
        }),
      );

      if (normalizePathForKey(activePathRef.current ?? "") === sourceKey) {
        setActivePath(movedFile.path);
      }

      await reloadWorkspace(currentWorkspace.rootPath, { silent: true });
      expandTreeAncestors(movedFile.path, currentWorkspace.rootPath);
      setSelectedTreePath(movedFile.path);
      setStatusMessage(
        `Moved ${getFileName(movedFile.path)} to ${toRelativePath(
          targetDir,
          currentWorkspace.rootPath,
        )}.`,
      );
    } catch (error) {
      await message(asErrorMessage(error), {
        title: "Move file failed",
        kind: "error",
      });
    }
  }

  function handleTreeSearchQueryChange(event: ChangeEvent<HTMLInputElement>) {
    contentSearchRequestRef.current += 1;
    setTreeSearchQuery(event.currentTarget.value);
    setContentSearchResults([]);
    setContentSearchLoading(false);
    setContentSearchError("");
    setContentSearchSubmittedQuery("");
  }

  function handleTreeSearchModeChange(mode: TreeSearchMode) {
    contentSearchRequestRef.current += 1;
    setTreeSearchMode(mode);
    setContentSearchResults([]);
    setContentSearchLoading(false);
    setContentSearchError("");
    setContentSearchSubmittedQuery("");
  }

  function handleTreeSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (treeSearchMode !== "content" || event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    void runTreeContentSearch();
  }

  async function runTreeContentSearch() {
    const currentWorkspace = workspaceRef.current;
    const query = treeSearchQuery.trim();

    if (!query) {
      contentSearchRequestRef.current += 1;
      setContentSearchResults([]);
      setContentSearchLoading(false);
      setContentSearchError("");
      setContentSearchSubmittedQuery("");
      return;
    }

    if (!currentWorkspace) {
      contentSearchRequestRef.current += 1;
      setContentSearchResults([]);
      setContentSearchLoading(false);
      setContentSearchError("Open a folder before searching content.");
      setContentSearchSubmittedQuery(query);
      return;
    }

    const requestId = contentSearchRequestRef.current + 1;
    contentSearchRequestRef.current = requestId;
    setContentSearchLoading(true);
    setContentSearchError("");
    setContentSearchSubmittedQuery(query);

    try {
      const results = await searchWorkspaceCommand(currentWorkspace.rootPath, query);
      if (contentSearchRequestRef.current !== requestId) {
        return;
      }

      setContentSearchResults(results);
    } catch (error) {
      if (contentSearchRequestRef.current !== requestId) {
        return;
      }

      setContentSearchResults([]);
      setContentSearchError(asErrorMessage(error));
    } finally {
      if (contentSearchRequestRef.current === requestId) {
        setContentSearchLoading(false);
      }
    }
  }

  async function handleContentSearchHitClick(hit: SearchHit) {
    const currentWorkspace = workspaceRef.current;
    try {
      await loadMarkdownFile(hit.path, {
        jump: {
          path: hit.path,
          line: hit.line,
          column: hit.column,
          needle:
            contentSearchSubmittedQuery ||
            treeSearchQuery.trim() ||
            hit.preview,
        },
      });

      if (currentWorkspace) {
        expandTreeAncestors(hit.path, currentWorkspace.rootPath);
      }
    } catch (error) {
      await message(asErrorMessage(error), {
        title: "Open search result failed",
        kind: "error",
      });
    }
  }

  function renderWorkspaceTreeNodes(
    nodes: WorkspaceTreeNode[],
    depth = 0,
    forceExpanded = false,
  ) {
    return nodes.map((node) => {
      const nodeKey = normalizePathForKey(node.path);
      const hasChildren = node.children.length > 0;
      const expanded =
        node.kind === "folder" && (forceExpanded || expandedTreePaths.has(nodeKey));
      const dragging =
        node.kind === "file" &&
        draggingTreeFilePath !== null &&
        normalizePathForKey(draggingTreeFilePath) === nodeKey;
      const dropTarget =
        node.kind === "folder" &&
        treeDropTargetPath !== null &&
        normalizePathForKey(treeDropTargetPath) === nodeKey;
      const selected =
        selectedTreePath !== null &&
        normalizePathForKey(selectedTreePath) === nodeKey;
      const active =
        node.kind === "file" &&
        activeTab !== null &&
        normalizePathForKey(activeTab.path) === nodeKey;

      return (
        <div key={node.path} className="tree-node">
          <button
            type="button"
            className={`tree-item tree-item--${node.kind} ${
              hasChildren ? "has-children" : ""
            } ${expanded ? "is-expanded" : ""} ${
              dragging ? "is-dragging" : ""
            } ${dropTarget ? "is-drop-target" : ""} ${
              selected ? "is-selected" : ""
            } ${active ? "is-active" : ""}`}
            style={{ paddingLeft: `${12 + depth * 16}px` }}
            title={node.path}
            aria-expanded={node.kind === "folder" ? expanded : undefined}
            draggable={node.kind === "file"}
            onClick={() => void handleTreeNodeClick(node)}
            onDragStart={(event) => handleTreeFileDragStart(event, node)}
            onDragEnd={handleTreeFileDragEnd}
            onDragOver={(event) => handleTreeFolderDragOver(event, node)}
            onDragLeave={handleTreeFolderDragLeave}
            onDrop={(event) => void handleTreeFolderDrop(event, node)}
          >
            <span
              className={`tree-item__toggle ${
                node.kind === "folder" && hasChildren
                  ? ""
                  : "tree-item__toggle--placeholder"
              }`}
              aria-hidden="true"
            />
            <span
              className={`tree-item__icon tree-item__icon--${node.kind}`}
              aria-hidden="true"
            />
            <span className="tree-item__name">{node.name}</span>
          </button>
          {node.kind === "folder" && expanded && hasChildren ? (
            <div className="tree-node__children">
              {renderWorkspaceTreeNodes(node.children, depth + 1, forceExpanded)}
            </div>
          ) : null}
        </div>
      );
    });
  }

  function toggleTreeFolder(path: string) {
    const key = normalizePathForKey(path);

    setExpandedTreePaths((currentExpanded) => {
      const nextExpanded = new Set(currentExpanded);

      if (nextExpanded.has(key)) {
        nextExpanded.delete(key);
      } else {
        nextExpanded.add(key);
      }

      return nextExpanded;
    });
  }

  function expandTreeAncestors(path: string, rootPath: string) {
    const rootKey = normalizePathForKey(rootPath).replace(/\/+$/, "");
    const ancestorKeys: string[] = [];
    let currentPath = getParentPath(path);
    let currentKey = normalizePathForKey(currentPath).replace(/\/+$/, "");

    while (currentKey && currentKey !== rootKey && currentKey.startsWith(`${rootKey}/`)) {
      ancestorKeys.push(currentKey);
      currentPath = getParentPath(currentPath);
      const nextKey = normalizePathForKey(currentPath).replace(/\/+$/, "");

      if (nextKey === currentKey) {
        break;
      }

      currentKey = nextKey;
    }

    if (ancestorKeys.length === 0) {
      return;
    }

    setExpandedTreePaths((currentExpanded) => {
      const nextExpanded = new Set(currentExpanded);
      ancestorKeys.forEach((key) => nextExpanded.add(key));
      return nextExpanded;
    });
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

  function handleEditorLineHeightChange(event: ChangeEvent<HTMLInputElement>) {
    setEditorLineHeight(clampEditorLineHeight(Number(event.currentTarget.value)));
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

  function resetEditorLineHeight() {
    setEditorLineHeight(DEFAULT_EDITOR_LINE_HEIGHT);
  }

  function resetEditorFontFamily() {
    setEditorFontFamily(DEFAULT_EDITOR_FONT_FAMILY);
  }

  function selectHeaderThemeMode(mode: HeaderThemeMode) {
    setHeaderThemeMode(mode);
  }

  function handleManualHeaderColorTextChange(
    level: HeaderLevel,
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const nextInput = event.currentTarget.value;
    const normalizedColor = normalizeHexColor(nextInput);

    setManualHeaderColorInputs((currentColors) => ({
      ...currentColors,
      [level]: nextInput,
    }));

    if (!normalizedColor) {
      return;
    }

    setManualHeaderColors((currentColors) => ({
      ...currentColors,
      [level]: normalizedColor,
    }));
  }

  function handleManualHeaderColorInputBlur(level: HeaderLevel) {
    const normalizedColor = normalizeHexColor(manualHeaderColorInputs[level]);
    if (!normalizedColor) {
      return;
    }

    setManualHeaderColorInputs((currentColors) => ({
      ...currentColors,
      [level]: normalizedColor,
    }));
  }

  function handleManualHeaderColorPickerChange(
    level: HeaderLevel,
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const normalizedColor = normalizeHexColor(event.currentTarget.value);
    if (!normalizedColor) {
      return;
    }

    setManualHeaderColors((currentColors) => ({
      ...currentColors,
      [level]: normalizedColor,
    }));
    setManualHeaderColorInputs((currentColors) => ({
      ...currentColors,
      [level]: normalizedColor,
    }));
  }

  function resetManualHeaderColors() {
    const resetColors = { ...LEVEL_HEADER_COLORS };
    setManualHeaderColors(resetColors);
    setManualHeaderColorInputs(resetColors);
  }

  function resetHeaderTheme() {
    setHeaderThemeMode("none");
    resetManualHeaderColors();
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
    <div className="app-shell" style={editorPaneStyle}>
      <aside
        className={`sidebar ${sidebarState.open ? "sidebar--open" : "sidebar--closed"}`}
      >
        <div className="sidebar-panel">
          <div className="sidebar-panel__header">
            <div>
              <h1>
                {sidebarState.activePanel === "tree" ? "Tree" : "Outline"}
              </h1>
              <p>{sidebarLocationLabel}</p>
            </div>
          </div>

          {sidebarState.activePanel === "tree" ? (
            <div className="sidebar-panel__body">
              <div className="tree-actions">
                <button
                  type="button"
                  aria-label="Open folder"
                  title="Open folder"
                  onClick={() => void openFolderFromPicker()}
                >
                  <span aria-hidden="true">📂</span>
                </button>
                <button
                  type="button"
                  aria-label="New file"
                  title="New file"
                  onClick={() => void createTreeFile()}
                  disabled={!workspace}
                >
                  <span aria-hidden="true">＋</span>
                </button>
                <button
                  type="button"
                  aria-label="Delete file"
                  title="Delete file"
                  onClick={() => void deleteSelectedTreeFile()}
                  disabled={!workspace || selectedTreeNode?.kind !== "file"}
                >
                  <span aria-hidden="true">🗑</span>
                </button>
                <button
                  type="button"
                  aria-label="Refresh tree"
                  title="Refresh tree"
                  onClick={() =>
                    workspace
                      ? void reloadWorkspace(workspace.rootPath)
                      : undefined
                  }
                  disabled={!workspace || treeLoading}
                >
                  <span aria-hidden="true">↻</span>
                </button>
              </div>
              <div className="tree-search">
                <input
                  type="search"
                  aria-label={
                    treeSearchMode === "files" ? "Filter files" : "Search content"
                  }
                  placeholder={
                    treeSearchMode === "files"
                      ? "Filter files..."
                      : "Search content..."
                  }
                  value={treeSearchQuery}
                  onChange={handleTreeSearchQueryChange}
                  onKeyDown={handleTreeSearchKeyDown}
                  disabled={!workspace}
                />
                <div
                  className={`tree-search__controls ${
                    treeSearchMode === "content" ? "" : "tree-search__controls--solo"
                  }`}
                >
                  <div className="tree-search__modes" aria-label="Tree search mode">
                    <button
                      type="button"
                      className={`tree-search__mode ${
                        treeSearchMode === "files" ? "is-active" : ""
                      }`}
                      aria-pressed={treeSearchMode === "files"}
                      onClick={() => handleTreeSearchModeChange("files")}
                    >
                      Files
                    </button>
                    <button
                      type="button"
                      className={`tree-search__mode ${
                        treeSearchMode === "content" ? "is-active" : ""
                      }`}
                      aria-pressed={treeSearchMode === "content"}
                      onClick={() => handleTreeSearchModeChange("content")}
                    >
                      Content
                    </button>
                  </div>
                  {treeSearchMode === "content" ? (
                    <button
                      type="button"
                      className="tree-search__submit"
                      onClick={() => void runTreeContentSearch()}
                      disabled={
                        !workspace ||
                        contentSearchLoading ||
                        trimmedTreeSearchQuery.length === 0
                      }
                    >
                      Search
                    </button>
                  ) : null}
                </div>
              </div>
              {treeNotice ? (
                <p className="panel-note panel-note--error">{treeNotice}</p>
              ) : null}
              {treeSearchMode === "content" ? (
                <div className="search-results">
                  {!workspace ? (
                    <div className="empty-panel">Open a folder to search content.</div>
                  ) : contentSearchLoading ? (
                    <div className="empty-panel">Searching content...</div>
                  ) : contentSearchError ? (
                    <div className="empty-panel">{contentSearchError}</div>
                  ) : !contentSearchSubmittedQuery ? (
                    <div className="empty-panel">
                      {trimmedTreeSearchQuery
                        ? "Press Enter or Search to search content."
                        : "Enter a term to search file contents."}
                    </div>
                  ) : contentSearchResults.length === 0 ? (
                    <div className="empty-panel">No content matches found.</div>
                  ) : (
                    contentSearchResults.map((hit) => (
                      <button
                        key={`${hit.path}:${hit.line}:${hit.column}:${hit.preview}`}
                        type="button"
                        className="search-hit"
                        title={hit.path}
                        onClick={() => void handleContentSearchHitClick(hit)}
                      >
                        <span className="search-hit__path">
                          {toRelativePath(hit.path, workspace?.rootPath ?? null)}
                        </span>
                        <span className="search-hit__preview">{hit.preview}</span>
                        <span className="search-hit__meta">
                          Line {hit.line}, column {hit.column}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              ) : (
                <div className="tree-list">
                  {!workspace ? (
                    <div className="empty-panel">Open a folder to show the tree.</div>
                  ) : treeLoading && workspaceTree.length === 0 ? (
                    <div className="empty-panel">Loading tree...</div>
                  ) : workspaceTree.length === 0 ? (
                    <div className="empty-panel">No markdown files found.</div>
                  ) : treeFileSearchActive && filteredWorkspaceTree.length === 0 ? (
                    <div className="empty-panel">No matching files.</div>
                  ) : (
                    renderWorkspaceTreeNodes(
                      filteredWorkspaceTree,
                      0,
                      treeFileSearchActive,
                    )
                  )}
                </div>
              )}
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
                  sidebarState.open && sidebarState.activePanel === "tree",
                )}
                aria-pressed={sidebarState.open && sidebarState.activePanel === "tree"}
                onClick={() => toggleSidebarPanel("tree")}
              >
                Tree
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
                    title={tab.untitled ? tab.title : tab.path}
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
              title={
                activeTab?.untitled
                  ? activeTab.title
                  : activeTab?.path ?? workspace?.rootPath ?? topbarLocationLabel
              }
            >
              {topbarLocationLabel}
            </div>
          </div>
          <div className="tabs__actions">
            <div className="tabs__badges" aria-label="Active document status">
              <span className="meta-pill meta-pill--muted">{activeSaveStateLabel}</span>
            </div>
            <button
              type="button"
              className="tabs__settings-button"
              aria-label="Start a new markdown file"
              onClick={createNewDocument}
            >
              New
            </button>
            <button
              type="button"
              className={`tabs__settings-button ${toolbarVisible ? "is-active" : ""}`}
              aria-pressed={toolbarVisible}
              aria-label="Toggle markdown toolbar"
              onClick={() => setToolbarVisible((visible) => !visible)}
            >
              Toolbar
            </button>
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
          <header className="app-header app-header--panel settings-panel">
            <div className="settings-panel__title">
              <strong className="app-title">Editor settings</strong>
            </div>
            <div className="settings-panel__grid">
              <div className="settings-panel__controls">
                <div className="settings-panel__sliders">
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
                      aria-valuetext={
                        editorWidthMode === "full" ? "Window" : `${editorWidth}px`
                      }
                    />
                  </label>
                  <label className="font-slider">
                    <span>Text scale</span>
                    <input
                      type="range"
                      min={MIN_EDITOR_FONT_SIZE}
                      max={MAX_EDITOR_FONT_SIZE}
                      step={1}
                      value={editorFontSize}
                      onChange={handleEditorFontSizeChange}
                      aria-label="Adjust editor text scale"
                      aria-valuetext={activeTextSizeLabel}
                    />
                  </label>
                  <label className="line-height-slider">
                    <span>Line spacing</span>
                    <input
                      type="range"
                      min={MIN_EDITOR_LINE_HEIGHT}
                      max={MAX_EDITOR_LINE_HEIGHT}
                      step={0.05}
                      value={editorLineHeight}
                      onChange={handleEditorLineHeightChange}
                      aria-label="Adjust editor line spacing"
                      aria-valuetext={activeLineHeightLabel}
                    />
                  </label>
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
                  <button type="button" onClick={resetEditorLineHeight}>
                    Spacing reset
                  </button>
                  <button type="button" onClick={resetEditorFontFamily}>
                    Font reset
                  </button>
                </div>
                <section className="header-theme-panel" aria-label="Header backgrounds">
                  <div className="header-theme-panel__header">
                    <div>
                      <span>Header backgrounds</span>
                      <strong>{HEADER_THEME_LABELS[headerThemeMode]}</strong>
                    </div>
                    <button type="button" onClick={resetHeaderTheme}>
                      Reset
                    </button>
                  </div>
                  <div className="header-theme-options" role="group">
                    {HEADER_THEME_MODES.map((mode) => {
                      const previewColors = resolveHeaderThemeColors(
                        mode,
                        manualHeaderColors,
                      );

                      return (
                        <button
                          key={mode}
                          type="button"
                          className={`header-theme-choice ${
                            headerThemeMode === mode ? "is-active" : ""
                          }`}
                          aria-pressed={headerThemeMode === mode}
                          onClick={() => selectHeaderThemeMode(mode)}
                        >
                          <span>{HEADER_THEME_LABELS[mode]}</span>
                          <span className="header-theme-swatch-row" aria-hidden="true">
                            {HEADER_LEVELS.map((level) => (
                              <span
                                key={level}
                                className={
                                  previewColors[level] === "transparent"
                                    ? "header-theme-swatch header-theme-swatch--empty"
                                    : "header-theme-swatch"
                                }
                                style={{ backgroundColor: previewColors[level] }}
                              />
                            ))}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {headerThemeMode === "manual" ? (
                    <div className="manual-header-colors">
                      <div className="manual-header-colors__grid">
                        {HEADER_LEVELS.map((level, index) => {
                          const inputValue = manualHeaderColorInputs[level];
                          const validColor = normalizeHexColor(inputValue);
                          const invalid = !validColor;

                          return (
                            <label
                              key={level}
                              className={`manual-header-color ${
                                invalid ? "is-invalid" : ""
                              }`}
                            >
                              <span className="manual-header-color__label">
                                H{index + 1}
                              </span>
                              <input
                                type="color"
                                value={manualHeaderColors[level]}
                                onChange={(event) =>
                                  handleManualHeaderColorPickerChange(level, event)
                                }
                                aria-label={`Pick H${index + 1} header background`}
                              />
                              <input
                                type="text"
                                value={inputValue}
                                onChange={(event) =>
                                  handleManualHeaderColorTextChange(level, event)
                                }
                                onBlur={() => handleManualHeaderColorInputBlur(level)}
                                aria-invalid={invalid}
                                aria-label={`H${index + 1} header hex color`}
                                spellCheck={false}
                              />
                            </label>
                          );
                        })}
                      </div>
                      <div className="manual-header-colors__footer">
                        <span>Use #RGB or #RRGGBB.</span>
                        <button type="button" onClick={resetManualHeaderColors}>
                          Manual reset
                        </button>
                      </div>
                    </div>
                  ) : null}
                </section>
                <div className="app-actions settings-panel__actions">
                  <button type="button" onClick={createNewDocument}>
                    New File
                  </button>
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
              <div className="settings-panel__font">
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
                  <div className="font-browser__current" title={editorFontFamily}>
                    <span>Selected</span>
                    <strong style={{ fontFamily: toCssFontFamily(editorFontFamily) }}>
                      {editorFontFamily}
                    </strong>
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
                      Open a markdown file, open a folder for the tree, or
                      drop a file directly onto the window.
                    </p>
                    <div className="app-actions">
                      <button type="button" onClick={createNewDocument}>
                        New File
                      </button>
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
                  showToolbar={toolbarVisible}
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
          <span>Spacing: {activeLineHeightLabel}</span>
          <span>Font: {activeFontLabel}</span>
          <span>
            {sidebarState.open
              ? sidebarState.activePanel === "tree"
                ? "Tree panel"
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

function findWorkspaceTreeNode(
  nodes: WorkspaceTreeNode[],
  path: string,
): WorkspaceTreeNode | null {
  const normalizedPath = normalizePathForKey(path);

  for (const node of nodes) {
    if (normalizePathForKey(node.path) === normalizedPath) {
      return node;
    }

    const childMatch = findWorkspaceTreeNode(node.children, path);
    if (childMatch) {
      return childMatch;
    }
  }

  return null;
}

function filterWorkspaceTreeNodes(
  nodes: WorkspaceTreeNode[],
  rootPath: string,
  query: string,
) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return nodes;
  }

  const filteredNodes: WorkspaceTreeNode[] = [];

  nodes.forEach((node) => {
    if (node.kind === "file") {
      const relativePath = toRelativePath(node.path, rootPath);
      const searchableText = `${node.name}\n${relativePath}`.toLowerCase();
      if (searchableText.includes(normalizedQuery)) {
        filteredNodes.push(node);
      }
      return;
    }

    const children = filterWorkspaceTreeNodes(
      node.children,
      rootPath,
      normalizedQuery,
    );
    if (children.length > 0) {
      filteredNodes.push({
        ...node,
        children,
      });
    }
  });

  return filteredNodes;
}

function getParentPath(path: string) {
  const normalizedPath = path.replace(/\\/g, "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");

  if (separatorIndex === -1) {
    return path;
  }

  return normalizedPath.slice(0, separatorIndex);
}

function joinPathForDisplay(parentPath: string, fileName: string) {
  const separator = parentPath.includes("\\") && !parentPath.includes("/") ? "\\" : "/";
  return `${parentPath.replace(/[\\/]+$/, "")}${separator}${fileName}`;
}

function normalizeDisplayPath(path: string) {
  return path.replace(/\\/g, "/");
}

function createUntitledTitle(tabs: DocumentTab[]) {
  const usedTitles = new Set(tabs.map((tab) => tab.title.toLowerCase()));
  const defaultTitle = "untitled.md";
  if (!usedTitles.has(defaultTitle)) {
    return defaultTitle;
  }

  let index = 2;
  while (usedTitles.has(`untitled-${index}.md`)) {
    index += 1;
  }

  return `untitled-${index}.md`;
}

function addMarkdownExtensionIfMissing(path: string) {
  const fileName = path.replace(/\\/g, "/").split("/").pop() ?? path;
  if (/\.(md|markdown)$/i.test(fileName) || /\.[^./]+$/.test(fileName)) {
    return path;
  }

  return `${path}.md`;
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

function clampEditorLineHeight(value: number) {
  if (Number.isNaN(value)) {
    return DEFAULT_EDITOR_LINE_HEIGHT;
  }

  return Math.min(
    MAX_EDITOR_LINE_HEIGHT,
    Math.max(MIN_EDITOR_LINE_HEIGHT, value),
  );
}

function formatEditorTextScale(value: number) {
  const offset = clampEditorFontSize(value) - DEFAULT_EDITOR_FONT_SIZE;

  if (offset === 0) {
    return "Standard";
  }

  return `${offset > 0 ? "+" : ""}${offset}px`;
}

function formatLineHeightCssValue(value: number) {
  return clampEditorLineHeight(value).toFixed(2);
}

function formatEditorLineHeight(value: number) {
  const lineHeight = clampEditorLineHeight(value);
  if (Math.abs(lineHeight - DEFAULT_EDITOR_LINE_HEIGHT) < 0.001) {
    return "Standard";
  }

  return `${lineHeight.toFixed(2)}x`;
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

function resolveHeaderThemeColors(
  mode: HeaderThemeMode,
  manualColors: HeaderColorMap,
): HeaderColorMap {
  if (mode === "manual") {
    return manualColors;
  }

  if (mode === "level") {
    return LEVEL_HEADER_COLORS;
  }

  if (mode === "fade") {
    return FADE_HEADER_COLORS;
  }

  return TRANSPARENT_HEADER_COLORS;
}

function normalizeHexColor(value: string) {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const hex = match[1].toLowerCase();
  if (hex.length === 3) {
    return `#${hex
      .split("")
      .map((character) => `${character}${character}`)
      .join("")}`;
  }

  return `#${hex}`;
}

function coerceHeaderThemeMode(value: string | null): HeaderThemeMode {
  return HEADER_THEME_MODES.includes(value as HeaderThemeMode)
    ? (value as HeaderThemeMode)
    : "none";
}

function readStoredHeaderThemeMode(): HeaderThemeMode {
  if (typeof window === "undefined") {
    return "none";
  }

  return coerceHeaderThemeMode(
    window.localStorage.getItem(HEADER_THEME_MODE_STORAGE_KEY),
  );
}

function readStoredManualHeaderColors(): HeaderColorMap {
  if (typeof window === "undefined") {
    return { ...LEVEL_HEADER_COLORS };
  }

  const colors: HeaderColorMap = { ...LEVEL_HEADER_COLORS };
  const stored = window.localStorage.getItem(HEADER_MANUAL_COLORS_STORAGE_KEY);
  if (!stored) {
    return colors;
  }

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return colors;
    }

    const colorRecord = parsed as Record<string, unknown>;
    HEADER_LEVELS.forEach((level) => {
      const normalizedColor =
        typeof colorRecord[level] === "string"
          ? normalizeHexColor(colorRecord[level])
          : null;

      if (normalizedColor) {
        colors[level] = normalizedColor;
      }
    });
  } catch {
    return colors;
  }

  return colors;
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

function readStoredEditorLineHeight() {
  if (typeof window === "undefined") {
    return DEFAULT_EDITOR_LINE_HEIGHT;
  }

  const stored = Number(window.localStorage.getItem(EDITOR_LINE_HEIGHT_STORAGE_KEY));
  if (Number.isNaN(stored)) {
    return DEFAULT_EDITOR_LINE_HEIGHT;
  }

  return clampEditorLineHeight(stored);
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

function readStoredToolbarVisible() {
  if (typeof window === "undefined") {
    return true;
  }

  return window.localStorage.getItem(EDITOR_TOOLBAR_VISIBLE_STORAGE_KEY) !== "false";
}

export default App;
