import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import mermaid from "mermaid";

// 머메이드 라이브러리 초기화 설정
// startOnLoad는 false로 설정하여 수동 렌더링 제어를 하도록 하고, 보안 수준은 유연하게 설정합니다.
mermaid.initialize({
  startOnLoad: false,
  theme: "default",
  securityLevel: "loose",
});

// 플러그인 식별을 위한 고유 키 정의
const mermaidPluginKey = new PluginKey("milkdown-mermaid-plugin");

// 난수를 이용한 요청 식별자 발급용 카운터
let requestCounter = 0;

/**
 * 문자열을 36진수 형태의 고유 해시 코드로 변환하는 초경량 유틸리티 함수입니다.
 * ProseMirror Widget Decoration의 리렌더링 최적화 키(key)로 활용됩니다.
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // 32비트 정수 변환
  }
  return Math.abs(hash).toString(36);
}

/**
 * 머메이드 코드 블록의 텍스트 소스를 받아 비동기적으로 SVG로 렌더링하고
 * 지정된 프리뷰 엘리먼트에 안전하게 마운트하는 렌더러 함수입니다.
 * 
 * @param text 머메이드 다이어그램 코드 텍스트
 * @param previewEl 다이어그램을 출력할 DOM 엘리먼트
 */
function renderMermaidDiagram(text: string, previewEl: HTMLDivElement) {
  const code = text.trim();
  if (!code) {
    previewEl.innerHTML = "";
    return;
  }

  // 매 요청마다 고유한 아이디를 발급하여 비동기 경쟁 문제를 해결합니다.
  const requestId = `mermaid-req-${Date.now()}-${requestCounter++}`;
  previewEl.dataset.latestRequest = requestId;

  // mermaid.render API를 호출하기 위해 영문자로 시작하는 고유 DOM ID를 생성합니다.
  const domId = `mermaid-svg-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

  // 비동기 렌더링 처리 수행
  mermaid.render(domId, code)
    .then(({ svg }) => {
      // 비동기 처리가 끝났을 때, 다른 최신 타이핑 요청에 의해 덮어씌워지지 않았는지 검증합니다.
      if (previewEl.dataset.latestRequest === requestId) {
        previewEl.innerHTML = svg;
      }
    })
    .catch((error) => {
      // 에러 발생 시 최신 요청 검증 후 사용자에게 친절한 에러 메시지를 제공합니다.
      if (previewEl.dataset.latestRequest === requestId) {
        previewEl.innerHTML = `
          <div class="milkdown-mermaid-error">
            <span class="error-title">⚠️ 머메이드 다이어그램 문법 오류</span>
            <pre class="error-details">${error?.message || error}</pre>
          </div>
        `;
      }
      
      // 머메이드 내부 렌더링 중 실패하여 잔존하는 임시 노드가 있다면 즉시 파괴(청소)하여
      // 다음 렌더링 시 중복 ID 충돌 오류가 발생하지 않도록 조치합니다.
      const badElement = document.getElementById(domId);
      if (badElement) {
        badElement.remove();
      }
    });
}

/**
 * ProseMirror 문서를 순회하며 머메이드 코드 블록이 담긴 위치를 찾고
 * 해당 영역에 렌더링 뷰를 덧대는 데코레이션(Decoration) 집합을 구성합니다.
 */
function buildMermaidDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    // 노드 타입이 code_block이고 언어 속성이 mermaid로 설정되어 있는지 검증합니다.
    const isCodeBlock = node.type.name === "code_block";
    const language = node.attrs.language || node.attrs.params || "";
    const isMermaid = typeof language === "string" && language.trim().toLowerCase() === "mermaid";

    if (isCodeBlock && isMermaid) {
      // 코드 블록 노드의 뒷부분(pos + nodeSize)에 렌더링 결과물 위젯을 삽입합니다.
      const widgetPos = pos + node.nodeSize;
      const textContent = node.textContent;

      decorations.push(
        Decoration.widget(
          widgetPos,
          () => {
            // 프리뷰를 감싸는 최상위 컨테이너 생성 (편집 불가능하도록 contentEditable 제어)
            const container = document.createElement("div");
            container.className = "milkdown-mermaid-preview-container hide-code"; // 기본적으로는 다이어그램만 보이도록 'hide-code' 세팅
            container.contentEditable = "false";

            // 우측 상단에 올라갈 미니멀 토글 버튼 생성
            const toggleBtn = document.createElement("button");
            toggleBtn.className = "milkdown-mermaid-toggle-btn";
            toggleBtn.type = "button";
            container.appendChild(toggleBtn);

            // 실제 SVG가 주입될 다이어그램 영역 엘리먼트 생성
            const previewEl = document.createElement("div");
            previewEl.className = "milkdown-mermaid-preview";
            container.appendChild(previewEl);

            /**
             * 위젯이 DOM에 삽입 완료된 후, 바로 이전 형제 요소(code_block DOM)의 숨김 여부를 제어합니다.
             * codeBlockDom.dataset.mermaidEditMode 속성을 통해 타이핑 중 위젯이 갱신되어도 상태를 기억합니다.
             */
            const initVisibility = () => {
              const codeBlockDom = container.previousSibling as HTMLElement;
              if (!codeBlockDom) return;

              const isEditMode = codeBlockDom.dataset.mermaidEditMode === "true";

              if (isEditMode) {
                // 사용자가 편집 모드를 열어놓은 경우
                container.classList.remove("hide-code");
                container.classList.add("show-code");
                codeBlockDom.style.display = "";
                toggleBtn.textContent = "다이어그램만 보기";
              } else {
                // 기본값: 다이어그램만 보기 (코드는 숨김)
                container.classList.remove("show-code");
                container.classList.add("hide-code");
                codeBlockDom.style.display = "none";
                toggleBtn.textContent = "코드 편집";
                codeBlockDom.dataset.mermaidEditMode = "false";
              }
            };

            // 버튼 클릭 시 다이어그램 모드 ↔ 에디터 노출 모드를 부드럽게 전환시킵니다.
            toggleBtn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();

              const codeBlockDom = container.previousSibling as HTMLElement;
              if (!codeBlockDom) return;

              const isCurrentlyHidden = container.classList.contains("hide-code");

              if (isCurrentlyHidden) {
                // 편집(코드 보이기) 상태로 돌림
                container.classList.remove("hide-code");
                container.classList.add("show-code");
                codeBlockDom.style.display = "";
                codeBlockDom.dataset.mermaidEditMode = "true";
                toggleBtn.textContent = "다이어그램만 보기";

                // 직관적인 글 작성을 위해 내부 CodeMirror 입력창에 포커스를 주입합니다.
                const editorArea = codeBlockDom.querySelector(".cm-content") as HTMLElement;
                if (editorArea) {
                  editorArea.focus();
                } else {
                  codeBlockDom.focus();
                }
              } else {
                // 다이어그램만 보기 (코드 숨김)
                container.classList.remove("show-code");
                container.classList.add("hide-code");
                codeBlockDom.style.display = "none";
                codeBlockDom.dataset.mermaidEditMode = "false";
                toggleBtn.textContent = "코드 편집";
              }
            });

            // ProseMirror 렌더 사이클 직후 DOM 부착 상태에서 안전하게 뷰를 조작하도록 지연 처리
            window.setTimeout(initVisibility, 0);

            // 비동기로 머메이드 렌더링 호출
            renderMermaidDiagram(textContent, previewEl);

            return container;
          },
          {
            // 동일한 소스 코드를 타이핑할 때는 ProseMirror가 DOM을 재사용하도록 안정적인 key 지정
            key: `mermaid-widget-${hashString(textContent)}`,
            side: 1, // 노드 아래 영역에 출력되도록 지정
            ignoreSelection: true,
          }
        )
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

/**
 * x-markdown-editor의 Milkdown Crepe 에디터에 통합할
 * 커스텀 머메이드 다이어그램 ProseMirror 플러그인입니다.
 */
export const milkdownMermaid = $prose(() => {
  return new Plugin({
    key: mermaidPluginKey,
    state: {
      // 에디터 최초 로드 시 문서의 머메이드 블록을 식별하여 데코레이션을 구성합니다.
      init(_, state) {
        return buildMermaidDecorations(state.doc);
      },
      // 문서 내용이 변경될 때 실시간으로 머메이드 데코레이션 목록을 갱신합니다.
      apply(tr, oldState) {
        if (tr.docChanged) {
          return buildMermaidDecorations(tr.doc);
        }
        return oldState;
      },
    },
    props: {
      // 등록된 데코레이션 세트를 에디터 뷰에 주입합니다.
      decorations(state) {
        return this.getState(state);
      },
    },
  });
});
