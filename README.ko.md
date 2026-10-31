# Kabegame — 플러그인 기반 애니메 이미지·동영상 수집 및 아카이빙 도구

> *Translated by AI. [中文](README.md) | [English](README.en-US.md) | [日本語](README.ja.md) | 한국어*

일러스트 사이트, 커뮤니티, 크리에이터 플랫폼, 로컬 폴더에 흩어진 이미지와 동영상을 하나의 로컬 라이브러리에 모으고, 출처·태그·작품 메타데이터를 그대로 보존합니다.

Kabegame은 다운로드만 담당하지 않습니다. 플러그인이 캐릭터·작품·작가 등의 태그를 자동으로 분류하고, 로컬 디렉터리를 지속 동기화되는 화집으로 매핑할 수 있으며, 로그인이 필요하면 내장 브라우저에서 한 번 로그인하면 플러그인이 저장된 Cookie를 재사용할 수 있습니다. 일반 사이트는 가벼운 V8 플러그인으로 처리하고, JS 렌더링이 무겁거나 안티 크롤링이 있는 사이트는 실제 WebView로 수집할 수 있습니다.

<p align="center">
  <a href="https://github.com/kabegame/kabegame/releases/latest"><b>최신 버전 다운로드</b></a>
  · <a href="https://demo.kabegame.com">온라인 체험</a>
  · <a href="https://kabegame.com/guide/quickstart/">빠른 시작</a>
  · <a href="https://github.com/kabegame/crawler-plugins">플러그인 둘러보기</a>
  · <a href="https://kabegame.com/dev/overview/">플러그인 개발</a>
</p>

<p align="center">
  <a href="https://github.com/kabegame/kabegame/releases/latest">
    <img alt="최신 릴리스" src="https://img.shields.io/github/v/release/kabegame/kabegame?style=flat-square&sort=semver&logo=github" height="20"/>
  </a>
  <a href="https://github.com/kabegame/kabegame/releases">
    <img alt="누적 다운로드 수" src="https://img.shields.io/github/downloads/kabegame/kabegame/total?style=flat-square&logo=github" height="20"/>
  </a>
  <a href="https://github.com/kabegame/kabegame/stargazers">
    <img alt="GitHub Stars" src="https://img.shields.io/github/stars/kabegame/kabegame?style=flat-square&logo=github" height="20"/>
  </a>
  <a href="https://github.com/kabegame/kabegame/blob/main/LICENSE">
    <img alt="GPL-3.0 라이선스" src="https://img.shields.io/github/license/kabegame/kabegame?style=flat-square" height="20"/>
  </a>
  <a href="https://kabegame.com">
    <img alt="프로젝트 문서" src="https://img.shields.io/badge/docs-kabegame.com-2f80ed?style=flat-square" height="20"/>
  </a>
</p>

## 핵심 하이라이트

- **태그 자동 분류**: 지원 플러그인은 다운로드할 때 캐릭터, 작품, 작가, 모델, 출처 등 구조화된 태그를 함께 기록해, 탐색과 조합 필터가 가능한 태그 디렉터리를 자동으로 만듭니다. 수집 후 한 장씩 정리할 필요가 없습니다.
- **로컬 폴더 지속 동기화**: 디스크 디렉터리를 동기화 화집으로 매핑하면 디렉터리의 추가·삭제가 라이브러리에 반영되고, 하위 디렉터리는 기존 계층 그대로 하위 화집을 만들 수 있습니다. 그림 소프트웨어, AI 이미지 생성 도구, 기타 다운로더의 출력을 계속 받아들이기에 적합합니다.
- **한 번 로그인하면 이후 자동 재사용**: '서핑' 내장 브라우저에서 사이트에 정상 로그인하면 Kabegame이 모든 사이트 Cookie를 저장합니다. 플러그인은 호스트로부터 로그인 상태를 안전하게 주입받을 수 있어 Cookie를 반복해 복사할 필요가 없고, Cookie 평문도 읽지 않습니다.
- **서핑에서 동영상을 바로 저장**: 내장 브라우저에서 동영상을 우클릭해 '동영상 다운로드'를 선택하면 `blob:` / MSE 스트리밍 플레이어도 화질별로 오디오·비디오 조각을 캡처하고 합쳐 라이브러리에 넣으며, 오른쪽 아래에 스트림별 캡처 진행률이 실시간으로 표시됩니다.
- **실제 WebView 기반 크롤링**: 가벼운 V8 HTTP / HTML 플러그인 외에도 플러그인을 실제 브라우저 페이지에서 실행해 SPA, JS 렌더링, 브라우저 핑거프린트, Cloudflare 검사, 상호작용이 필요한 로그인 흐름을 처리할 수 있습니다.
- **스크립트로 새로운 콘텐츠 소스 확장**: 크롤러 플러그인은 JavaScript / TypeScript로 작성하므로 Kabegame 본체를 수정하거나 다시 컴파일할 필요가 없습니다. 하나의 플러그인이 수집 로직, 설정 폼, 태그 분류, 출처 메타데이터, 상세 뷰를 한꺼번에 정의하고 `.kgpg` 파일로 패키징해 다른 사용자와 공유할 수 있습니다.
- **출처 정보를 이미지와 함께 보존**: 플러그인은 작성자, 원본 게시물 링크, 본문, 댓글, 커뮤니티 태그, AI 생성 파라미터를 저장하고 자체 상세 뷰와 검색 조각을 제공할 수 있습니다. 이미지가 원본 사이트를 떠난 뒤에도 '어디서 왔고 왜 보관했는지'를 알 수 있습니다.

<table width="100%">
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/features/auto-labels.jpg" alt="Kabegame 태그 자동 분류" width="100%"/><br/>
      <small>플러그인이 구조화 태그를 기록해 필터링 가능한 태그 디렉터리를 자동 생성</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/features/folder-sync.jpg" alt="Kabegame 로컬 폴더 동기화" width="100%"/><br/>
      <small>로컬 디렉터리를 계층을 유지한 채 지속 동기화되는 화집으로 매핑</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/features/cookie-reuse.jpg" alt="Kabegame이 Cookie를 자동 저장하고 재사용" width="100%"/><br/>
      <small>서핑에서 한 번 로그인하면 이후 수집은 로그인 상태를 자동 재사용</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/features/source-metadata.jpg" alt="Kabegame 출처 메타데이터" width="100%"/><br/>
      <small>작성자, 원본 게시물, 태그, 상호작용 정보를 이미지와 함께 보존</small>
    </td>
  </tr>
</table>

<table width="100%">
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/features/webview-crawler-images.jpg" alt="Kabegame WebView 크롤러 수집 결과" width="100%"/><br/>
      <small>플러그인이 실제 브라우저 페이지에서 실행되어 미디어를 수집 작업으로 넘깁니다</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/features/webview-crawler-log.jpg" alt="Kabegame WebView 크롤러 작업 로그" width="100%"/><br/>
      <small>페이지 상호작용, 스크롤, 추출 과정을 작업 로그에서 추적할 수 있습니다</small>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src="docs/images/features/surf-video-download.jpg" alt="Kabegame 서핑 동영상 다운로드와 캡처 진행률" width="100%"/><br/>
      <small>서핑에서 스트리밍 동영상을 우클릭으로 저장하고, 오른쪽 아래에 스트림별 캡처 진행률 표시</small>
    </td>
  </tr>
</table>

## 수집에서 아카이빙까지

- **통합 수집**: 플러그인으로 Pixiv, Bilibili, Danbooru, 벽지 사이트, 커뮤니티 등에서 일괄 수집할 수 있고, 내장 브라우저에서 둘러보며 수집할 수도 있습니다.
- **통합 검색**: 서로 다른 소스가 같은 갤러리에 들어오고, 시간, 플러그인, 태그, 미디어 유형, 크기, 파일 크기, 메타데이터 검색의 조합으로 필터링할 수 있습니다.
- **통합 관리**: 일반 화집으로 테마를 수동 정리하고, 태그 디렉터리로 자동 분류하고, 동기화 화집으로 디스크 폴더를 따라가며, 중복 제거와 숨기기로 오래 쌓인 라이브러리를 다룹니다.
- **로컬 소유**: 원본 파일과 라이브러리 데이터는 사용자가 보유합니다. 다운로드 디렉터리를 지정할 수 있고 가상 디스크를 통해 다른 앱에서 화집에 접근할 수 있습니다.
- **계속 확장**: 크롤러 플러그인은 JavaScript / TypeScript로 작성합니다. MCP를 사용하면 AI 에이전트가 명확한 권한 아래 라이브러리를 검색하고 정리할 수 있습니다.

Kabegame이 풀려는 것은 '이미지를 어떻게 다운로드할까'가 아니라, 이미지가 서로 다른 소스를 넘나들며 계속 쌓인 뒤에도 어떻게 맥락을 보존하고 장기적으로 정리할까입니다. 이미지 정리에서 당신의 손을 해방하며, AI 학습자, 이차원 팬, 그리고 회사에서 잠깐 딴짓하는 사람에게 알맞습니다. png 등 이미지는 메타데이터를 파싱할 수 있어 AI 생성 이미지의 프롬프트를 발견할 수도 있습니다! (저는 Kabegame으로 건진 워크플로가 여러 개 있습니다)

## 빠른 시작

1. [GitHub Releases](https://github.com/kabegame/kabegame/releases/latest)에서 Kabegame을 내려받아 설치합니다.
2. '소스'를 열고 공식 플러그인 디렉터리에서 관심 있는 플러그인을 설치합니다. 로컬 이미지만 관리한다면 이 단계는 건너뛰어도 됩니다.
3. '갤러리'로 돌아가 '수집 시작'을 클릭하고 로컬 가져오기 또는 네트워크 플러그인을 선택합니다.
4. 갤러리에서 출처와 태그로 필터링하고 원본 게시물 메타데이터를 확인한 뒤, 오래 보관할 내용을 화집으로 정리합니다.

5분 전체 흐름은 [빠른 시작](https://kabegame.com/guide/quickstart/)을 참고하세요. 데스크톱 앱을 설치하지 않아도 [온라인 Demo](https://demo.kabegame.com)에서 라이브러리 화면을 체험할 수 있습니다.

## 핵심 기능

| 기능 | 설명 |
| --- | --- |
| 플러그인 기반 수집 | 내장 플러그인 스토어에서 `.kgpg` 플러그인을 설치·업그레이드·관리합니다. V8과 WebView 백엔드가 각각 가벼운 요청과 실제 브라우저 시나리오를 담당합니다. |
| 로그인 상태 재사용 | 서핑이 사이트 Cookie를 저장하고 V8 플러그인은 안전하게 주입을 요청할 수 있습니다. WebView 플러그인은 브라우저 세션을 직접 사용합니다. |
| 태그와 메타데이터 | 플러그인은 태그를 자동 분류하고 원본 게시물, 작성자, 댓글, 생성 파라미터를 저장하며 상세 뷰와 검색 필드를 제공할 수 있습니다. |
| 갤러리와 검색 | 이미지와 동영상을 탐색하고 시간, 출처, 태그, 미디어, 크기, 파일 크기, 메타데이터 조합으로 필터링합니다. |
| 화집과 폴더 | 수동 화집은 다단계 구성을 지원하고, 동기화 화집은 로컬 디렉터리와 하위 디렉터리의 변화를 지속적으로 따라갑니다. |
| 로컬 라이브러리 통합 | 다운로드 디렉터리 지정, 드래그 앤 드롭 가져오기, 일괄 작업, 중복 제거, 가상 디스크, 원본 메타데이터 읽기. |
| 자동화와 개방형 인터페이스 | 예약 수집, CLI, MCP를 지원합니다. 벽지 설정과 화집 로테이션은 데스크톱 추가 기능으로 제공합니다. |

## 플러그인 생태계

공식 플러그인 저장소는 이미 스무 개가 넘는 일러스트 사이트, 커뮤니티, 크리에이터 플랫폼, 벽지 사이트를 지원합니다. 플러그인마다 자체 설정 폼, 로그인 방식, 태그 축, 상세 표시, 추천 작업을 제공할 수 있습니다.

- **플러그인 사용**: [공식 플러그인 디렉터리 보기](https://github.com/kabegame/crawler-plugins) · [플러그인 설치 및 관리](https://kabegame.com/guide/plugins-usage/)
- **플러그인 개발**: [개발 개요](https://kabegame.com/dev/overview/) · [V8 / WebView 백엔드 선택](https://kabegame.com/dev/crawler-backends/) · [API 레퍼런스](https://kabegame.com/reference/kabegame-api/)
- **플러그인 기여**: 새로운 소스를 제출하거나, 깨진 사이트를 고치거나, 기존 플러그인의 문서와 메타데이터를 개선할 수 있습니다.

V8 플러그인은 자체 완결형 ES Module로, HTTP 요청, API, HTML 파싱으로 수집하기에 적합하며 Android에서도 실행됩니다. 실제 브라우저 렌더링, 브라우저 세션, 페이지 상호작용에 의존해야 할 때는 데스크톱 WebView 백엔드를 사용할 수 있습니다. 페이지를 실제로 실행한 뒤 DOM, 네트워크 응답, 페이지 다운로드에서 내용을 추출합니다.

> 플러그인은 접근 권한이 있는 콘텐츠를 정리하는 데에만 사용해야 합니다. 소스 사이트의 이용약관을 준수하고, 작성자의 저작권과 프라이버시를 존중하며, 접근 빈도를 적절히 조절하세요.

## 다운로드와 플랫폼

현재 주요 배포판은 데스크톱 버전입니다. `kabegame-cli`는 별도의 선택 도구이며 본체와 함께 설치되지 않습니다.

| 플랫폼 | 다운로드 파일 | 설명 |
| --- | --- | --- |
| Windows x64 | `Kabegame-standard_<버전>_x64-setup.exe` | 더블클릭으로 설치합니다. 화집 가상 디스크에는 Dokan 2.x가 필요하며, 처음 활성화할 때 앱이 설치를 안내합니다. |
| macOS Apple 실리콘 | `Kabegame-standard_<버전>_aarch64.dmg` | macOS 11 이상을 지원하며, 설치 파일은 아직 서명되지 않았습니다. |
| Linux amd64 | `Kabegame-standard_<버전>_amd64.deb` | `apt`로 설치합니다. 화집 가상 디스크는 `fuse3`에 의존합니다. |
| Android | `Kabegame_<버전>_android-preview.apk` | Android 8.0 이상. 최신 버전은 Releases에서 다운로드할 수 있습니다. |

macOS 첫 실행 시 개발자를 확인할 수 없거나 앱이 손상되었다고 표시되면:

```bash
xattr -d com.apple.quarantine /Applications/Kabegame.app
```

macOS에서 화집 가상 디스크를 쓰려면 macFUSE도 설치합니다:

```bash
brew install --cask macfuse
```

Linux 설치:

```bash
sudo apt install ./Kabegame-standard_*_amd64.deb
```

이미지는 기본적으로 사용자 사진 디렉터리의 `Pictures/Kabegame`에 저장되며, 앱을 삭제해도 이곳의 이미지는 삭제되지 않습니다. 더 자세한 플랫폼 요구사항, 데이터 디렉터리, 문제 해결 방법은 [설치 문서](https://kabegame.com/guide/installation/)를 참고하세요.

## 프로젝트 참여

Tauri / Rust 모노레포 전체를 먼저 알지 못해도 Kabegame에 참여할 수 있습니다:

- 문제가 생기면 [Bug report](https://github.com/kabegame/kabegame/issues/new?template=bug_report.md)를 제출하세요.
- 새로운 소스를 지원하고 싶다면 [플러그인 저장소](https://github.com/kabegame/crawler-plugins)에 플러그인을 제출하거나 요청을 남기세요.
- 앱 본체를 개선하려면 먼저 [소스에서 빌드](https://kabegame.com/dev-contrib/building/)와 [아키텍처](https://kabegame.com/dev-contrib/architecture/)를 읽어 보세요.
- 문서, 번역, 스크린샷, 플러그인 설명도 똑같이 가치 있는 기여입니다.

Kabegame이 도움이 되었다면 Star를 눌러 주세요. 더 많은 사용자와 잠재적 플러그인 작성자가 프로젝트를 발견하게 돕고, 저에게도 큰 힘이 됩니다.

## 기술적 하이라이트

Kabegame은 Vue 3, Tauri 2, Rust로 구축되었으며, 라이브러리 쿼리, 플러그인 런타임, 데스크톱 브라우저 기능에 여러 확장을 더했습니다:

- [WebviewHandler](./src-tauri/kabegame-core/src/crawler/webview.rs): 로그인 상태나 페이지 상호작용이 필요한 플러그인을 실제 페이지 환경에서 실행합니다.
- [tauri-runtime-kbcef](./src-tauri/tauri-runtime-kbcef/): 데스크톱에 맞춰 커스터마이즈한 CEF Tauri runtime.
- [PathQL](./src-tauri/pathql-rs/): 경로 조합 필터, 정렬, 페이지네이션과 Provider DSL을 갖춘 데이터베이스 쿼리 엔진.

프로젝트 구조, 프로세스 모델, 주요 모듈은 [아키텍처와 프로젝트 구조](https://kabegame.com/dev-contrib/architecture/)를 참고하세요.

## 라이선스

Kabegame은 [GPL-3.0](./LICENSE)으로 오픈 소스로 공개되어 있습니다.

## 이름의 유래 🐢

**Kabegame**은 일본어「壁亀」(かべがめ)의 로마자 표기로,「壁紙」(かべがみ, '벽지')와 발음이 비슷합니다. 마치 조용한 거북이 한 마리가 바탕화면에 엎드려 당신의 이미지 컬렉션을 지켜주는 것처럼요.
