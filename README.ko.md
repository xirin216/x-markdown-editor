# X Markdown Editor

X Markdown Editor는 디스크 어디에 있는 `.md`, `.markdown` 파일이든 열고, 편집하고, 검색하고, 인쇄할 수 있는 Windows 우선 Markdown 편집기입니다. Tauri 데스크톱 앱으로 만들어졌고, React 프론트엔드와 Rust 백엔드가 파일 처리, 파일 감시, 워크스페이스 검색, 시스템 폰트 조회, Windows 패키징 관련 기능을 담당합니다.

영어 문서는 [README.md](README.md)를 확인하세요.

## 기능

- 디스크의 `.md`, `.markdown` 파일을 직접 엽니다.
- Windows에서 Markdown 파일 연결 프로그램으로 등록할 수 있습니다.
- 워크스페이스 폴더를 열고 Markdown 파일을 재귀적으로 검색합니다.
- 접을 수 있는 왼쪽 패널에서 Search와 Outline을 사용합니다.
- Milkdown과 Crepe 기반 편집 화면에서 Markdown을 편집합니다.
- 상단 버튼으로 서식 툴바를 켜고 끌 수 있습니다.
- Markdown 안의 raw HTML 블록을 미리보기로 렌더링하고, 렌더링된 HTML은 정화 처리합니다.
- 편집 화면의 브라우저 맞춤법 검사 붉은 밑줄을 숨깁니다.
- Markdown 파일 또는 하나의 워크스페이스 폴더를 드래그 앤 드롭으로 열 수 있습니다.
- 열린 파일과 워크스페이스 파일의 외부 변경을 감시합니다.
- 검색과 페이지 이동이 가능한 시스템 폰트 브라우저에서 에디터 폰트를 선택합니다.
- 에디터 폰트, 글자 크기, 페이지 폭, 툴바 표시 상태 등 설정을 저장합니다.
- 인쇄 시 에디터 폭, 폰트, 글자 크기 설정을 출력 양식에 반영합니다.
- Windows NSIS 설치 파일을 빌드합니다.

## 사용된 라이브러리

프론트엔드:

- React 19
- React DOM
- TypeScript
- Vite
- Milkdown Crepe, Kit, React bindings
- DOMPurify
- Tauri JavaScript API
- Tauri dialog plugin API

백엔드 및 데스크톱:

- Tauri 2
- Rust
- Serde, serde_json
- notify
- walkdir
- font-kit
- Windows용 winreg
- Rust 테스트용 tempfile

## 개발 언어

- 프론트엔드 애플리케이션: TypeScript, JSX
- 레이아웃, 에디터 스타일, 반응형 설정 UI, 인쇄 스타일: CSS
- 네이티브 명령, 파일 감시, 파일 분류, 워크스페이스 검색, 시스템 폰트 조회, 실행 인자 처리: Rust 2021
- 설정 파일: JSON, TOML

## 개발 환경

권장 환경:

- Windows 10 또는 Windows 11
- Node.js와 npm
- Rust stable toolchain
- Rust/Tauri 빌드를 위한 Microsoft C++ Build Tools 또는 Visual Studio Build Tools
- WebView2 Runtime
- Tauri 번들러가 사용하는 NSIS 도구

이 앱은 Tauri 2 데스크톱 앱이며, 개발 서버는 Vite를 통해 `http://localhost:1420`에서 실행되도록 설정되어 있습니다.

## 의존성 설치

```powershell
npm.cmd install
```

## 개발 실행

전체 Tauri 데스크톱 앱 실행:

```powershell
npm.cmd run tauri dev
```

Vite 프론트엔드 서버만 실행:

```powershell
npm.cmd run dev
```

## 빌드

프론트엔드만 빌드:

```powershell
npm.cmd run build
```

Rust 테스트 실행:

```powershell
cd src-tauri
cargo test
```

Windows 데스크톱 설치 파일 빌드:

```powershell
npm.cmd run package:windows
```

동일한 Windows 패키징 명령은 다음 배치 파일로도 실행할 수 있습니다.

```powershell
build-windows.bat
```

생성된 NSIS 설치 파일은 다음 경로에 만들어집니다.

```text
src-tauri\target\release\bundle\nsis\
```

## Windows 패키징 참고

- 번들 대상: NSIS
- 설치 모드: per-machine
- 예상 설치 위치: Program Files
- 설치 시 관리자 권한: 필요
- 파일 연결: `.md`, `.markdown`
- 코드 서명: 설정되지 않음
- 자동 업데이트: 설정되지 않음
