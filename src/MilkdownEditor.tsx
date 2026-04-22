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
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { toggleLinkCommand } from "@milkdown/kit/component/link-tooltip";
import { undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
import {
  addBlockTypeCommand,
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  headingSchema,
  orderedListSchema,
  paragraphSchema,
  selectTextNearPosCommand,
  setBlockTypeCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  wrapInBlockTypeCommand,
} from "@milkdown/kit/preset/commonmark";
import { createTable } from "@milkdown/kit/preset/gfm";
import { replaceAll } from "@milkdown/kit/utils";

type MilkdownEditorProps = {
  value: string;
  onChange(nextMarkdown: string): void;
  autofocus?: boolean;
  jumpNeedle?: string;
  jumpKey?: string;
  disabled?: boolean;
  placeholder?: string;
  onReadyChange?(ready: boolean): void;
  onJumpHandled?(): void;
  style?: CSSProperties;
};

type ToolbarButton = {
  label: string;
  run(ctx: Ctx): void;
};

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

    crepeRef.current = crepe;
    lastMarkdownRef.current = value;

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        lastMarkdownRef.current = markdown;

        if (appliedMarkdownRef.current === markdown) {
          appliedMarkdownRef.current = null;
          return;
        }

        if (markdown !== valueRef.current) {
          onChangeRef.current(markdown);
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

    if (value === lastMarkdownRef.current) {
      return;
    }

    appliedMarkdownRef.current = value;
    lastMarkdownRef.current = value;
    editor.action(replaceAll(value, true));
  }, [get, loading, value]);

  useEffect(() => {
    if (loading || disabled || !autofocus) {
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

    editor.action((ctx) => {
      run(ctx);
      ctx.get(editorViewCtx).focus();
    });
  }

  return (
    <div
      ref={hostRef}
      className={`milkdown-editor${disabled ? " milkdown-editor--disabled" : ""}`}
      style={style}
    >
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
      <div className="milkdown-surface">
        <Milkdown />
      </div>
    </div>
  );
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
  const surface = host?.querySelector<HTMLElement>(".milkdown-surface");
  if (!surface) {
    return false;
  }

  surface.scrollTop = 0;
  return true;
}

function MilkdownEditor(props: MilkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MilkdownEditorInner {...props} />
    </MilkdownProvider>
  );
}

export default MilkdownEditor;
