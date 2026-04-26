import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { htmlSchema } from "@milkdown/kit/preset/commonmark";
import { $view } from "@milkdown/kit/utils";
import DOMPurify from "dompurify";

const blockTags = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "dialog",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

export const milkdownHtmlPreview = $view(
  htmlSchema.node,
  (): NodeViewConstructor => {
    return (initialNode, view, getPos) => {
      const dom = document.createElement("span");
      const preview = document.createElement("span");
      const editor = document.createElement("div");
      const textarea = document.createElement("textarea");
      const status = document.createElement("div");
      let currentValue = typeof initialNode.attrs.value === "string" ? initialNode.attrs.value : "";
      let editing = false;

      dom.className = "milkdown-html-node";
      dom.contentEditable = "false";
      preview.className = "milkdown-html-node__preview";
      editor.className = "milkdown-html-node__editor";
      textarea.className = "milkdown-html-node__textarea";
      status.className = "milkdown-html-node__status";
      textarea.spellcheck = false;
      textarea.setAttribute("aria-label", "Edit raw HTML");
      editor.appendChild(textarea);
      editor.appendChild(status);
      dom.appendChild(preview);
      dom.appendChild(editor);

      const updateCursorStatus = () => {
        const cursor = textarea.selectionDirection === "backward" ? textarea.selectionStart : textarea.selectionEnd;
        const beforeCursor = textarea.value.slice(0, cursor);
        const line = beforeCursor.split("\n").length;
        const column = beforeCursor.length - beforeCursor.lastIndexOf("\n");
        const selectionLength = Math.abs(textarea.selectionEnd - textarea.selectionStart);

        status.textContent =
          selectionLength > 0
            ? `Ln ${line}, Col ${column} · Selected ${selectionLength}`
            : `Ln ${line}, Col ${column}`;
      };

      const bindNode = (node: ProseNode) => {
        const raw = typeof node.attrs.value === "string" ? node.attrs.value : "";
        currentValue = raw;
        const sanitized = DOMPurify.sanitize(raw, {
          USE_PROFILES: {
            html: true,
          },
          ADD_ATTR: ["align"],
        });

        preview.innerHTML = sanitized;
        textarea.value = raw;
        dom.dataset.raw = raw;
        dom.classList.toggle("milkdown-html-node--empty", sanitized.trim().length === 0);
        dom.classList.toggle("milkdown-html-node--block", containsBlockMarkup(preview));
        updateCursorStatus();

        if (!sanitized.trim().length && raw.trim().length > 0) {
          preview.textContent = raw;
        }
      };

      const renderDraft = (raw: string) => {
        const sanitized = DOMPurify.sanitize(raw, {
          USE_PROFILES: {
            html: true,
          },
          ADD_ATTR: ["align"],
        });

        preview.innerHTML = sanitized;
        dom.dataset.raw = raw;
        dom.classList.toggle("milkdown-html-node--empty", sanitized.trim().length === 0);
        dom.classList.toggle("milkdown-html-node--block", containsBlockMarkup(preview));

        if (!sanitized.trim().length && raw.trim().length > 0) {
          preview.textContent = raw;
        }
      };

      const openEditor = () => {
        if (!view.editable || editing) {
          return;
        }

        editing = true;
        dom.classList.add("milkdown-html-node--editing");
        textarea.value = currentValue;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.max(textarea.scrollHeight, 56)}px`;
        updateCursorStatus();

        window.setTimeout(() => {
          textarea.focus();
          textarea.setSelectionRange(textarea.value.length, textarea.value.length);
          updateCursorStatus();
        }, 0);
      };

      const closeEditor = () => {
        editing = false;
        dom.classList.remove("milkdown-html-node--editing");
      };

      const commitDraft = () => {
        const nextValue = textarea.value;
        renderDraft(nextValue);

        if (nextValue === currentValue) {
          return;
        }

        const pos = getPos();
        if (typeof pos !== "number") {
          currentValue = nextValue;
          return;
        }

        dom.dispatchEvent(
          new CustomEvent("milkdown-html-user-edit", {
            bubbles: true,
          }),
        );
        view.dispatch(view.state.tr.setNodeAttribute(pos, "value", nextValue));
      };

      bindNode(initialNode);

      preview.addEventListener("click", () => {
        openEditor();
      });

      textarea.addEventListener("input", () => {
        renderDraft(textarea.value);
        textarea.style.height = "auto";
        textarea.style.height = `${Math.max(textarea.scrollHeight, 56)}px`;
        updateCursorStatus();
      });

      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          renderDraft(currentValue);
          textarea.value = currentValue;
          updateCursorStatus();
          closeEditor();
          dom.focus();
          return;
        }

        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          commitDraft();
          closeEditor();
          dom.focus();
        }
      });

      textarea.addEventListener("click", updateCursorStatus);
      textarea.addEventListener("focus", updateCursorStatus);
      textarea.addEventListener("keyup", updateCursorStatus);
      textarea.addEventListener("select", updateCursorStatus);

      textarea.addEventListener("blur", () => {
        commitDraft();
        closeEditor();
      });

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type !== initialNode.type) {
            return false;
          }

          bindNode(updatedNode);
          return true;
        },
        ignoreMutation() {
          return true;
        },
        stopEvent(event) {
          return event.target instanceof Node && editor.contains(event.target);
        },
        selectNode() {
          dom.classList.add("selected");
        },
        deselectNode() {
          if (editing) {
            commitDraft();
            closeEditor();
          }
          dom.classList.remove("selected");
        },
        destroy() {
          preview.replaceChildren();
          editor.replaceChildren();
          dom.remove();
        },
      };
    };
  },
);

function containsBlockMarkup(container: HTMLElement) {
  const stack = Array.from(container.children);

  while (stack.length > 0) {
    const element = stack.shift();
    if (!element) {
      continue;
    }

    if (blockTags.has(element.tagName.toLowerCase())) {
      return true;
    }

    stack.push(...Array.from(element.children));
  }

  return false;
}
