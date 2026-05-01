import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import type { Ctx } from "@milkdown/kit/ctx";
import type {
  Handle,
  Join,
  Options as MarkdownStringifyOptions,
} from "mdast-util-to-markdown";
import {
  commandsCtx,
  editorViewCtx,
  remarkStringifyOptionsCtx,
} from "@milkdown/kit/core";
import { toggleLinkCommand } from "@milkdown/kit/component/link-tooltip";
import { undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
import {
  addBlockTypeCommand,
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  hardbreakSchema,
  headingSchema,
  htmlSchema,
  orderedListSchema,
  paragraphSchema,
  selectTextNearPosCommand,
  setBlockTypeCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  wrapInBlockTypeCommand,
} from "@milkdown/kit/preset/commonmark";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { createTable } from "@milkdown/kit/preset/gfm";
import { $remark, replaceAll } from "@milkdown/kit/utils";
import { normalizeSerializedMarkdown } from "./markdown";
import { milkdownHtmlPreview } from "./milkdownHtmlPreview";

type MilkdownEditorProps = {
  value: string;
  onChange(nextMarkdown: string): void;
  autofocus?: boolean;
  jumpNeedle?: string;
  jumpKey?: string;
  disabled?: boolean;
  placeholder?: string;
  showToolbar?: boolean;
  onReadyChange?(ready: boolean): void;
  onJumpHandled?(): void;
  style?: CSSProperties;
};

type ToolbarButton = {
  label: string;
  run(ctx: Ctx): void;
};

type BulletMarker = "-" | "*" | "+";

type RemarkNode = {
  type?: string;
  value?: unknown;
  data?: unknown;
  children?: RemarkNode[];
  position?: {
    start?: { line?: number };
    end?: { line?: number };
  };
};

type RectLike = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type EditorScrollSnapshot = {
  view: EditorView;
  surface: HTMLElement;
  scrollTop: number;
  scrollLeft: number;
  caretTop: number;
};

const USER_EDIT_GRACE_MS = 1200;
const pairedHtmlLinePattern =
  /^<([A-Za-z][A-Za-z0-9:-]*)(?:\s[^<>]*)?>[\s\S]*<\/([A-Za-z][A-Za-z0-9:-]*)>$/;
const blocksRequiringDefaultJoin = new Set([
  "blockquote",
  "html",
  "table",
  "thematicBreak",
]);

const obsidianLineBreakRemarkPlugin = $remark(
  "obsidianLineBreak",
  () => () => (tree) => {
    normalizeObsidianRemarkLineBreaks(tree as RemarkNode);
  },
);

const headingButtons: ToolbarButton[] = [
  {
    label: "P",
    run(ctx) {
      const commands = ctx.get(commandsCtx);
      commands.call(setBlockTypeCommand.key, {
        nodeType: paragraphSchema.type(ctx),
      });
    },
  },
  {
    label: "H1",
    run(ctx) {
      const commands = ctx.get(commandsCtx);
      commands.call(setBlockTypeCommand.key, {
        nodeType: headingSchema.type(ctx),
        attrs: { level: 1 },
      });
    },
  },
  {
    label: "H2",
    run(ctx) {
      const commands = ctx.get(commandsCtx);
      commands.call(setBlockTypeCommand.key, {
        nodeType: headingSchema.type(ctx),
        attrs: { level: 2 },
      });
    },
  },
  {
    label: "H3",
    run(ctx) {
      const commands = ctx.get(commandsCtx);
      commands.call(setBlockTypeCommand.key, {
        nodeType: headingSchema.type(ctx),
        attrs: { level: 3 },
      });
    },
  },
];

const formatButtons: ToolbarButton[] = [
  {
    label: "Bold",
    run(ctx) {
      ctx.get(commandsCtx).call(toggleStrongCommand.key);
    },
  },
  {
    label: "Italic",
    run(ctx) {
      ctx.get(commandsCtx).call(toggleEmphasisCommand.key);
    },
  },
  {
    label: "Link",
    run(ctx) {
      ctx.get(commandsCtx).call(toggleLinkCommand.key);
    },
  },
];

const listButtons: ToolbarButton[] = [
  {
    label: "Bullet",
    run(ctx) {
      ctx.get(commandsCtx).call(wrapInBlockTypeCommand.key, {
        nodeType: bulletListSchema.type(ctx),
      });
    },
  },
  {
    label: "Number",
    run(ctx) {
      ctx.get(commandsCtx).call(wrapInBlockTypeCommand.key, {
        nodeType: orderedListSchema.type(ctx),
      });
    },
  },
];

const insertButtons: ToolbarButton[] = [
  {
    label: "Quote",
    run(ctx) {
      ctx.get(commandsCtx).call(wrapInBlockTypeCommand.key, {
        nodeType: blockquoteSchema.type(ctx),
      });
    },
  },
  {
    label: "Inline",
    run(ctx) {
      ctx.get(commandsCtx).call(toggleInlineCodeCommand.key);
    },
  },
  {
    label: "Fence",
    run(ctx) {
      ctx.get(commandsCtx).call(setBlockTypeCommand.key, {
        nodeType: codeBlockSchema.type(ctx),
      });
    },
  },
  {
    label: "Table",
    run(ctx) {
      const commands = ctx.get(commandsCtx);
      const view = ctx.get(editorViewCtx);
      const { from } = view.state.selection;

      commands.call(addBlockTypeCommand.key, {
        nodeType: createTable(ctx, 3, 3),
      });
      commands.call(selectTextNearPosCommand.key, { pos: from });
    },
  },
];

const historyButtons: ToolbarButton[] = [
  {
    label: "Undo",
    run(ctx) {
      ctx.get(commandsCtx).call(undoCommand.key);
    },
  },
  {
    label: "Redo",
    run(ctx) {
      ctx.get(commandsCtx).call(redoCommand.key);
    },
  },
];

function MilkdownEditorInner({
  value,
  onChange,
  autofocus = true,
  jumpNeedle,
  jumpKey,
  disabled = false,
  placeholder = "Open a markdown file and start writing.",
  showToolbar = true,
  onReadyChange,
  onJumpHandled,
  style,
}: MilkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const onChangeRef = useRef(onChange);
  const onReadyChangeRef = useRef(onReadyChange);
  const onJumpHandledRef = useRef(onJumpHandled);
  const valueRef = useRef(value);
  const lastMarkdownRef = useRef(value);
  const appliedMarkdownRef = useRef<string | null>(null);
  const userEditUntilRef = useRef(0);
  const preferredBulletMarkerRef = useRef(inferPreferredBulletMarker(value));

  onChangeRef.current = onChange;
  onReadyChangeRef.current = onReadyChange;
  onJumpHandledRef.current = onJumpHandled;
  valueRef.current = value;

  const { loading, get } = useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: value,
      features: {
        [CrepeFeature.BlockEdit]: false,
        [CrepeFeature.ImageBlock]: false,
        [CrepeFeature.Latex]: false,
        [CrepeFeature.Toolbar]: false,
        [CrepeFeature.TopBar]: false,
      },
      featureConfigs: {
        [CrepeFeature.Placeholder]: {
          text: placeholder,
          mode: "doc",
        },
      },
    });
    crepe.editor.use(milkdownHtmlPreview);
    crepe.editor.use(obsidianLineBreakRemarkPlugin);
    crepe.editor.config((ctx) => {
      const bullet = preferredBulletMarkerRef.current;
      const bulletOther: BulletMarker = bullet === "*" ? "-" : "*";
      ctx.update(remarkStringifyOptionsCtx, (options) =>
        configureObsidianStringifyOptions(options, bullet, bulletOther),
      );
    });

    crepeRef.current = crepe;
    lastMarkdownRef.current = value;

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, previousMarkdown) => {
        const nextMarkdown = normalizeSerializedMarkdown(markdown);
        const previousNormalizedMarkdown =
          normalizeSerializedMarkdown(previousMarkdown);
        const userInitiated = hasRecentUserEditIntent();

        lastMarkdownRef.current = nextMarkdown;

        if (nextMarkdown === previousNormalizedMarkdown) {
          return;
        }

        if (appliedMarkdownRef.current === nextMarkdown) {
          appliedMarkdownRef.current = null;
          return;
        }

        if (!userInitiated) {
          return;
        }

        if (nextMarkdown !== valueRef.current) {
          onChangeRef.current(nextMarkdown);
        }
      });
    });

    return crepe;
  }, []);

  const toolbarGroups = useMemo(
    () => [headingButtons, formatButtons, listButtons, insertButtons, historyButtons],
    [],
  );

  useEffect(() => {
    onReadyChangeRef.current?.(!loading);
  }, [loading]);

  useEffect(() => {
    if (loading) {
      return;
    }

    const host = hostRef.current;
    if (!host) {
      return;
    }

    disableNativeSpellcheck(host);

    const observer = new MutationObserver(() => {
      disableNativeSpellcheck(host);
    });
    observer.observe(host, {
      childList: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, [loading]);

  useEffect(() => {
    if (loading) {
      return;
    }

    const host = hostRef.current;
    if (!host) {
      return;
    }

    const markInputIntent = (event: Event) => {
      const isHtmlEditCommit = event.type === "milkdown-html-user-edit";
      if (!disabled && (event.isTrusted || isHtmlEditCommit)) {
        markUserEditIntent();
      }
    };
    const markKeyboardIntent = (event: KeyboardEvent) => {
      if (!disabled && event.isTrusted && isEditingKey(event)) {
        markUserEditIntent();
      }
    };
    const stabilizeScrollOnEnter = (event: KeyboardEvent) => {
      if (
        disabled ||
        !event.isTrusted ||
        event.key !== "Enter" ||
        event.isComposing ||
        isFormFieldEvent(event)
      ) {
        return;
      }

      const editor = get();
      if (!editor) {
        return;
      }

      let snapshot: EditorScrollSnapshot | null = null;
      editor.action((ctx) => {
        snapshot = captureEditorScrollSnapshot(ctx.get(editorViewCtx), host);
      });

      if (!snapshot) {
        return;
      }

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          stabilizeUnexpectedEditorScroll(snapshot);
        });
      });
    };
    const convertHtmlLineOnEnter = (event: KeyboardEvent) => {
      if (
        disabled ||
        !event.isTrusted ||
        event.key !== "Enter" ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        isFormFieldEvent(event)
      ) {
        return;
      }

      const editor = get();
      if (!editor) {
        return;
      }

      let converted = false;
      editor.action((ctx) => {
        converted = convertCurrentLineToHtmlNode(ctx.get(editorViewCtx), ctx);
      });

      if (converted) {
        event.preventDefault();
      }
    };

    host.addEventListener("beforeinput", markInputIntent, true);
    host.addEventListener("input", markInputIntent, true);
    host.addEventListener("paste", markInputIntent, true);
    host.addEventListener("drop", markInputIntent, true);
    host.addEventListener("compositionend", markInputIntent, true);
    host.addEventListener("milkdown-html-user-edit", markInputIntent, true);
    host.addEventListener("keydown", markKeyboardIntent, true);
    host.addEventListener("keydown", stabilizeScrollOnEnter, true);
    host.addEventListener("keydown", convertHtmlLineOnEnter, true);

    return () => {
      host.removeEventListener("beforeinput", markInputIntent, true);
      host.removeEventListener("input", markInputIntent, true);
      host.removeEventListener("paste", markInputIntent, true);
      host.removeEventListener("drop", markInputIntent, true);
      host.removeEventListener("compositionend", markInputIntent, true);
      host.removeEventListener("milkdown-html-user-edit", markInputIntent, true);
      host.removeEventListener("keydown", markKeyboardIntent, true);
      host.removeEventListener("keydown", stabilizeScrollOnEnter, true);
      host.removeEventListener("keydown", convertHtmlLineOnEnter, true);
    };
  }, [disabled, get, loading]);

  useEffect(() => {
    return () => {
      onReadyChangeRef.current?.(false);
    };
  }, []);

  useEffect(() => {
    const crepe = crepeRef.current;
    if (!crepe) {
      return;
    }

    crepe.setReadonly(disabled);
  }, [disabled, loading]);

  useEffect(() => {
    if (loading) {
      return;
    }

    const editor = get();
    if (!editor) {
      return;
    }

    editor.action((ctx) => {
      normalizeLineBreakNodes(ctx.get(editorViewCtx), ctx);
    });
  }, [get, loading]);

  useEffect(() => {
    if (loading) {
      return;
    }

    const editor = get();
    if (!editor) {
      return;
    }

    if (value === lastMarkdownRef.current) {
      return;
    }

    appliedMarkdownRef.current = value;
    lastMarkdownRef.current = value;
    userEditUntilRef.current = 0;
    editor.action(replaceAll(value, true));
    editor.action((ctx) => {
      normalizeLineBreakNodes(ctx.get(editorViewCtx), ctx);
    });
  }, [get, loading, value]);

  useEffect(() => {
    if (loading || disabled || !autofocus) {
      return;
    }

    if (shouldPreserveExternalTextFocus(hostRef.current)) {
      return;
    }

    const editor = get();
    if (!editor) {
      return;
    }

    editor.action((ctx) => {
      ctx.get(editorViewCtx).focus();
    });
  }, [autofocus, disabled, get, loading]);

  useEffect(() => {
    if (loading || !jumpKey) {
      return;
    }

    let attempts = 0;
    let cancelled = false;

    const focusAttempt = () => {
      if (cancelled) {
        return;
      }

      const success = jumpNeedle
        ? focusNeedle(hostRef.current, jumpNeedle)
        : scrollEditorToTop(hostRef.current);

      attempts += 1;

      if (success || attempts >= 8) {
        onJumpHandledRef.current?.();
        return;
      }

      window.setTimeout(focusAttempt, 50);
    };

    window.setTimeout(focusAttempt, 60);

    return () => {
      cancelled = true;
    };
  }, [jumpKey, jumpNeedle, loading]);

  function runToolbarButton(
    event: MouseEvent<HTMLButtonElement>,
    run: ToolbarButton["run"],
  ) {
    event.preventDefault();

    if (loading || disabled) {
      return;
    }

    const editor = get();
    if (!editor) {
      return;
    }

    markUserEditIntent();
    editor.action((ctx) => {
      run(ctx);
      ctx.get(editorViewCtx).focus();
    });
  }

  function markUserEditIntent() {
    userEditUntilRef.current = Date.now() + USER_EDIT_GRACE_MS;
  }

  function hasRecentUserEditIntent() {
    return Date.now() <= userEditUntilRef.current;
  }

  return (
    <div
      ref={hostRef}
      className={`milkdown-editor${disabled ? " milkdown-editor--disabled" : ""}`}
      spellCheck={false}
      style={style}
    >
      {showToolbar ? (
        <div className="milkdown-toolbar" role="toolbar" aria-label="Markdown editor toolbar">
          {toolbarGroups.map((group, groupIndex) => (
            <div key={groupIndex} className="milkdown-toolbar__group">
              {group.map((button) => (
                <button
                  key={button.label}
                  type="button"
                  disabled={loading || disabled}
                  onMouseDown={(event) => runToolbarButton(event, button.run)}
                >
                  {button.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      <div className="milkdown-surface" spellCheck={false}>
        <Milkdown />
      </div>
    </div>
  );
}

function normalizeObsidianRemarkLineBreaks(node: RemarkNode) {
  insertEmptyParagraphsForSourceGaps(node);
  convertInlineRemarkBreaksToTextNewlines(node);
}

function insertEmptyParagraphsForSourceGaps(node: RemarkNode) {
  if (!node.children) {
    return;
  }

  const nextChildren: RemarkNode[] = [];

  node.children.forEach((child) => {
    const previous = nextChildren[nextChildren.length - 1];
    const lineBreakCount = getSourceLineBreakCount(previous, child);

    if (shouldPreserveSourceGap(node, previous, child, lineBreakCount)) {
      for (let index = 1; index < lineBreakCount; index += 1) {
        nextChildren.push(createEmptyParagraph());
      }
    }

    nextChildren.push(child);
  });

  node.children = nextChildren;

  node.children.forEach((child) => insertEmptyParagraphsForSourceGaps(child));
}

function shouldPreserveSourceGap(
  parent: RemarkNode,
  previous: RemarkNode | undefined,
  next: RemarkNode,
  lineBreakCount: number,
) {
  return (
    lineBreakCount >= 2 &&
    isFlowContainer(parent) &&
    Boolean(previous) &&
    !isListItemBoundary(previous, next)
  );
}

function getSourceLineBreakCount(
  previous: RemarkNode | undefined,
  next: RemarkNode,
) {
  const previousEndLine = previous?.position?.end?.line;
  const nextStartLine = next.position?.start?.line;

  if (
    typeof previousEndLine !== "number" ||
    typeof nextStartLine !== "number"
  ) {
    return 0;
  }

  return nextStartLine - previousEndLine;
}

function isFlowContainer(node: RemarkNode) {
  return !node.type || node.type === "root" || node.type === "blockquote";
}

function isListItemBoundary(previous: RemarkNode | undefined, next: RemarkNode) {
  return previous?.type === "listItem" || next.type === "listItem";
}

function createEmptyParagraph(): RemarkNode {
  return {
    type: "paragraph",
    children: [],
  };
}

function convertInlineRemarkBreaksToTextNewlines(node: RemarkNode) {
  if (!node.children) {
    return;
  }

  const nextChildren: RemarkNode[] = [];

  node.children.forEach((child) => {
    if (isInlineRemarkBreak(child)) {
      appendRemarkText(nextChildren, "\n");
      return;
    }

    convertInlineRemarkBreaksToTextNewlines(child);
    nextChildren.push(child);
  });

  node.children = nextChildren;
}

function isInlineRemarkBreak(node: RemarkNode) {
  return (
    node.type === "break" &&
    isPlainRecord(node.data) &&
    node.data.isInline === true
  );
}

function appendRemarkText(children: RemarkNode[], value: string) {
  const previous = children[children.length - 1];
  if (previous?.type === "text" && typeof previous.value === "string") {
    previous.value += value;
    return;
  }

  children.push({
    type: "text",
    value,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function disableNativeSpellcheck(host: HTMLElement) {
  const targets = [
    host,
    ...host.querySelectorAll<HTMLElement>(
      ".milkdown, .ProseMirror, [contenteditable='true'], textarea, input",
    ),
  ];

  targets.forEach((target) => {
    target.setAttribute("spellcheck", "false");
  });
}

function isEditingKey(event: KeyboardEvent) {
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
    return true;
  }

  if (["Backspace", "Delete", "Enter", "Tab"].includes(event.key)) {
    return true;
  }

  if (!(event.ctrlKey || event.metaKey)) {
    return false;
  }

  return ["b", "i", "u", "v", "x", "y", "z"].includes(event.key.toLowerCase());
}

function isFormFieldEvent(event: KeyboardEvent) {
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    target.closest("textarea, input, select, [contenteditable='false']")
  );
}

function captureEditorScrollSnapshot(
  view: EditorView,
  host: HTMLDivElement,
): EditorScrollSnapshot | null {
  const surface = getEditorScrollSurface(host);
  const caretRect = getEditorSelectionRect(view);
  if (!surface || !caretRect) {
    return null;
  }

  const surfaceRect = surface.getBoundingClientRect();
  if (!isRectVisibleInSurface(caretRect, surfaceRect)) {
    return null;
  }

  return {
    view,
    surface,
    scrollTop: surface.scrollTop,
    scrollLeft: surface.scrollLeft,
    caretTop: caretRect.top - surfaceRect.top,
  };
}

function stabilizeUnexpectedEditorScroll(
  snapshot: EditorScrollSnapshot | null,
) {
  if (
    !snapshot ||
    !snapshot.surface.isConnected ||
    !snapshot.view.dom.isConnected ||
    !snapshot.surface.contains(snapshot.view.dom)
  ) {
    return;
  }

  const scrollDelta = Math.abs(snapshot.surface.scrollTop - snapshot.scrollTop);
  const largeJumpThreshold = Math.max(96, snapshot.surface.clientHeight * 0.25);
  if (scrollDelta < largeJumpThreshold) {
    return;
  }

  const caretRect = getEditorSelectionRect(snapshot.view);
  if (!caretRect) {
    snapshot.surface.scrollTop = snapshot.scrollTop;
    snapshot.surface.scrollLeft = snapshot.scrollLeft;
    return;
  }

  const surfaceRect = snapshot.surface.getBoundingClientRect();
  const nextCaretTop = caretRect.top - surfaceRect.top;
  const correction = nextCaretTop - snapshot.caretTop;

  if (Number.isFinite(correction) && Math.abs(correction) >= 1) {
    snapshot.surface.scrollTop += correction;
  }

  snapshot.surface.scrollLeft = snapshot.scrollLeft;
}

function getEditorSelectionRect(view: EditorView): RectLike | null {
  try {
    const coords = view.coordsAtPos(view.state.selection.head);
    return {
      top: coords.top,
      right: coords.right,
      bottom: coords.bottom,
      left: coords.left,
    };
  } catch {
    return null;
  }
}

function isRectVisibleInSurface(rect: RectLike, surfaceRect: DOMRect) {
  return rect.bottom >= surfaceRect.top && rect.top <= surfaceRect.bottom;
}

function normalizeLineBreakNodes(view: EditorView, ctx: Ctx) {
  const hardbreakType = hardbreakSchema.type(ctx);
  const codeBlockType = codeBlockSchema.type(ctx);
  const { state } = view;
  const tr = state.tr;
  const textReplacements: Array<{
    pos: number;
    node: ProseMirrorNode;
  }> = [];
  let changed = false;

  state.doc.descendants((node, pos, parent) => {
    if (node.type === hardbreakType && node.attrs.isInline === true) {
      tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        isInline: false,
      });
      changed = true;
      return;
    }

    if (!node.isText || parent?.type === codeBlockType || !node.text?.includes("\n")) {
      return;
    }

    textReplacements.push({ pos, node });
    changed = true;
  });

  if (!changed) {
    return false;
  }

  textReplacements.reverse().forEach(({ pos, node }) => {
    const replacement = splitTextNodeWithHardbreaks(node, hardbreakType);
    tr.replaceWith(pos, pos + node.nodeSize, replacement);
  });

  tr.setMeta("addToHistory", false);
  view.dispatch(tr);
  return true;
}

function splitTextNodeWithHardbreaks(
  node: ProseMirrorNode,
  hardbreakType: ProseMirrorNode["type"],
) {
  const text = node.text ?? "";
  const parts = text.split("\n");
  const replacement: ProseMirrorNode[] = [];

  parts.forEach((part, index) => {
    if (part) {
      replacement.push(node.type.schema.text(part, node.marks));
    }

    if (index < parts.length - 1) {
      replacement.push(hardbreakType.create({ isInline: false }));
    }
  });

  return replacement;
}

function convertCurrentLineToHtmlNode(view: EditorView, ctx: Ctx) {
  const { state } = view;
  const { selection } = state;

  if (!(selection instanceof TextSelection) || !selection.empty) {
    return false;
  }

  const paragraphType = paragraphSchema.type(ctx);
  const htmlType = htmlSchema.type(ctx);
  const { $from } = selection;
  const parent = $from.parent;

  if (parent.type !== paragraphType || $from.parentOffset !== parent.content.size) {
    return false;
  }

  const rawHtml = parent.textContent.trim();
  if (!isCompletePairedHtmlLine(rawHtml)) {
    return false;
  }

  const paragraphDepth = $from.depth;
  const from = $from.before(paragraphDepth);
  const to = $from.after(paragraphDepth);
  const htmlNode = htmlType.create({ value: rawHtml });
  const htmlParagraph = paragraphType.create(null, htmlNode);
  const nextParagraph = paragraphType.create();
  const tr = state.tr.replaceWith(from, to, [htmlParagraph, nextParagraph]);
  const nextCursorPosition = from + htmlParagraph.nodeSize + 1;

  view.dispatch(
    tr
      .setSelection(TextSelection.create(tr.doc, nextCursorPosition))
      .scrollIntoView(),
  );
  return true;
}

function isCompletePairedHtmlLine(value: string) {
  const match = pairedHtmlLinePattern.exec(value.trim());
  return Boolean(match && match[1].toLowerCase() === match[2].toLowerCase());
}

function configureObsidianStringifyOptions(
  options: MarkdownStringifyOptions,
  bullet: BulletMarker,
  bulletOther: BulletMarker,
): MarkdownStringifyOptions {
  return {
    ...options,
    bullet,
    bulletOther,
    handlers: {
      ...(options.handlers ?? {}),
      break: renderLiteralLineBreak,
    },
    join: [...(options.join ?? []), joinObsidianBlocks],
  };
}

const renderLiteralLineBreak: Handle = () => "\n";

const joinObsidianBlocks: Join = (left, right, parent) => {
  if (parent.type !== "root") {
    return;
  }

  if (
    blocksRequiringDefaultJoin.has(left.type) ||
    blocksRequiringDefaultJoin.has(right.type)
  ) {
    return;
  }

  return 0;
};

function inferPreferredBulletMarker(markdown: string): BulletMarker {
  const counts: Record<BulletMarker, number> = {
    "-": 0,
    "*": 0,
    "+": 0,
  };

  markdown.split(/\r?\n/).forEach((line) => {
    const match = /^ {0,3}([-+*])\s+\S/.exec(line);
    if (match) {
      counts[match[1] as BulletMarker] += 1;
    }
  });

  return (Object.entries(counts) as Array<[BulletMarker, number]>).sort(
    (left, right) => right[1] - left[1],
  )[0][0];
}

function focusNeedle(host: HTMLDivElement | null, needle: string) {
  const container = host?.querySelector<HTMLElement>(".milkdown .ProseMirror");
  if (!container) {
    return false;
  }

  const normalizedNeedle = needle.trim().toLowerCase();
  if (!normalizedNeedle) {
    return scrollEditorToTop(host);
  }

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.textContent ?? "";
      return text.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
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
        current.parentElement.closest(
          "h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, table, div",
        ) ?? current.parentElement;

      block.scrollIntoView({
        block: "center",
        behavior: "auto",
      });
      container.focus({
        preventScroll: true,
      });
      return true;
    }

    current = walker.nextNode();
  }

  return false;
}

function scrollEditorToTop(host: HTMLDivElement | null) {
  const surface = getEditorScrollSurface(host);
  if (!surface) {
    return false;
  }

  surface.scrollTop = 0;
  return true;
}

function getEditorScrollSurface(host: HTMLDivElement | null) {
  return host?.querySelector<HTMLElement>(".milkdown-surface") ?? null;
}

function shouldPreserveExternalTextFocus(host: HTMLDivElement | null) {
  const activeElement = document.activeElement;
  if (!activeElement || activeElement === document.body) {
    return false;
  }

  if (host?.contains(activeElement)) {
    return false;
  }

  return (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    activeElement instanceof HTMLSelectElement ||
    (activeElement instanceof HTMLElement && activeElement.isContentEditable)
  );
}

function MilkdownEditor(props: MilkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MilkdownEditorInner {...props} />
    </MilkdownProvider>
  );
}

export default MilkdownEditor;
