# Kabegame 이차원 크롤러 클라이언트

> *Translated by AI. [中文](README.md) | [English](README.en-US.md) | [日本語](README.ja.md) | 한국어*

Tauri 기반 이차원 크롤러 클라이언트! 벽지를 크롤링·관리·설정/로테이션하여, 아내(또는 남편)들이 매일 당신 곁을 지켜주게 하세요~ 플러그인 확장을 지원해 다양한 이차원 사이트의 리소스를 손쉽게 크롤링할 수 있습니다.

📖 **전체 문서**：[https://kabegame.com](https://kabegame.com/)

🌐 **온라인 체험（Demo）**：[https://demo.kabegame.com](https://demo.kabegame.com/)

논문을 쓸 만한 [기술적 혁신](#관심-있을지도-모릅니다).

> 깨달았습니다, 이차원에는 스토리텔링이 필요하다는 것을. 그래서 플러그인 메타데이터를 추가해, 이미지를 크롤링할 때의 게시물 댓글을 볼 수 있게 했습니다.

> 알겠습니다, 이차원에는 신선함이 필요하다는 것을. 그래서 랜덤 정렬을 추가하고 크롤링을 자동으로 설정·실행해, 매일 새롭게 바뀌는 아름다운 이미지를 즐길 수 있게 했습니다.
> - 왜 벽지인가? 사실 대부분의 사람이 대부분의 시간을 벽지를 보며 보냅니다. 심리학적으로 벽지는 사람의 기분에 직접 영향을 주며, 방의 어수선함이 기분에 영향을 주는 것과 같습니다. 예쁜 벽지는 기분을 상쾌하게 하고 수명까지 늘려줍니다.
> - 왜 로테이션인가? 심미적 피로 때문입니다. 좋은 것도 오래 보면 환경이 되어버리고, 사람은 환경 속 소음을 자동으로 걸러내어 주관적으로는 더 이상 아름답다고 느끼지 못합니다. 로테이션은 새 벽지에 대한 기대와 바탕화면의 신선함을 항상 유지시켜 주어, 언제나 좋은 기분을 지켜줍니다.

> 깨달았습니다, 이차원은 야한 것, 선정적인 것과 떼려야 뗄 수 없다는 것을. 그래서
>  - R18 플러그인을 적극적으로 도입했고, MCP(AI가 캐릭터의 야한 이미지를 한 화집으로 모아 주는 기능)도 넣었습니다.
>  - 이미지 메타데이터 로딩과 고급 조합 검색 기능도 만들었습니다. 좋아하는 캐릭터를 빠르게 찾거나, AI prompt가 있는 이미지를 빠르게 걸러내기 위해서입니다.
>  - 폴더 화집도 만들었습니다. 생성한 이미지를 kabegame으로 자동으로 가져오기 위해서입니다.

> AI 이미지 생성은 3차원에서 2차원으로 가는 문을 여는 열쇠입니다. 이것이 있으면 그림을 못 그려도 남의 창작물에 얽매이지 않고 자신만의 2차원을 창조할 수 있습니다. 생각해 본 적도 없겠지만, 당신이 좋아하는 캐릭터는 사실 누군가가 만들어 준 것입니다. 대기업 회사원일 수도, 대머리 프로그래머일 수도 있습니다. AI 이미지 생성은 처음으로 모든 사람에게 스스로 2차원 세계를 창조할 능력을 부여해, 우리 자신의 2차원을 가능하게 하고, 우리 모두가 방관자가 아니라 참여자가 되게 했습니다.

<div align="center" style="line-height: 3em">
  <b>오직 이차원만을 위한 소프트웨어를 만들기 위해 노력합니다.</b>
</div>

<div align="center">
  <img src="docs/images/icon.png" alt="Kabegame" width="256"/>
</div>

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
    <img alt="라이선스" src="https://img.shields.io/github/license/kabegame/kabegame?style=flat-square" height="20"/>
  </a>
  <a href="https://kabegame.com">
    <img alt="프로젝트 문서" src="https://img.shields.io/badge/docs-kabegame.com-2f80ed?style=flat-square" height="20"/>
  </a>
  <br/>
  <a href="https://kabegame.com/guide/installation/">
    <img alt="지원 플랫폼" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-5c6bc0?style=flat-square" height="20"/>
  </a>
  <a href="https://v2.tauri.app/">
    <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" height="20"/>
  </a>
  <a href="https://vuejs.org/">
    <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3-42B883?style=flat-square&logo=vuedotjs&logoColor=white" height="20"/>
  </a>
</p>

<table width="100%">
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-main.png" alt="Kabegame 갤러리" width="100%"/><br/>
      <small>갤러리</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-preview.png" alt="Kabegame 이미지 미리보기" width="100%"/><br/>
      <small>미리보기</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-detail2.jpg" alt="Kabegame 상세 메타데이터" width="100%"/><br/>
      <small>상세 메타데이터</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-filters2.jpg" alt="Kabegame 갤러리 필터링" width="100%"/><br/>
      <small>자유로운 필터링</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/album/album-main2.jpg" alt="Kabegame 화집 정리" width="100%"/><br/>
      <small>화집 정리</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/album/album-folder2.jpg" alt="Kabegame 폴더 동기화" width="100%"/><br/>
      <small>폴더 동기화</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/source/source-main.jpg" alt="Kabegame 소스 플러그인 목록" width="100%"/><br/>
      <small>소스 플러그인 목록</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/source/source-doc2.jpg" alt="Kabegame 소스 플러그인 문서" width="100%"/><br/>
      <small>소스 플러그인 문서</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/crawler/crawler-config.jpg" alt="Kabegame 작업 매개변수 설정" width="100%"/><br/>
      <small>작업 매개변수 설정</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/crawler/crawler-start.jpg" alt="Kabegame 작업 실행" width="100%"/><br/>
      <small>작업 실행</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/crawler/task-images2.jpg" alt="Kabegame 작업 이미지" width="100%"/><br/>
      <small>작업 이미지</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/crawler/task-log2.jpg" alt="Kabegame 작업 로그" width="100%"/><br/>
      <small>작업 로그(빠른 문제 파악)</small>
    </td>
  </tr>
</table>

## 주요 기능

- 🔌 **크롤러 클라이언트**：`.kgpg` 플러그인으로 여러 사이트에서 벽지를 크롤링하고, 내장 플러그인 스토어에서 탐색/설치/관리할 수 있습니다. 4.3.0부터 릴리스 시점의 최신 플러그인을 모두 기본으로 포함합니다. 플러그인은 JS/TS로 작성되며 V8(deno_core) 또는 WebView 백엔드에서 실행됩니다.
- 🎨 **벽지 설정기(이미지/동영상)**：이차원 벽지를 수집·관리·로테이션하고, 지정한 화집에서 바탕화면 벽지를 자동으로 교체합니다.
- 🖼️ **이미지 관리자**：갤러리 탐색, 자동 태그 분류, 화집 정리, 가상 디스크, 드래그 앤 드롭 가져오기, 폴더-화집 동기화.
- 🧩 **MCP 정리**：MCP 서버를 열어 외부 AI 에이전트가 세밀한 권한 아래 벽지 정리를 돕게 할 수 있습니다.

Windows, macOS, Linux, Android를 지원합니다(v4.3.0 이하만 해당, 새 버전은 현재 대응 중입니다).

## 관심 있을지도 모릅니다
이차원 벽지나 크롤러에는 관심이 없을 수도 있지만, 이 앱에 담긴 몇 가지 기술적 혁신에는 흥미가 생길지도 모릅니다
- Tauri 기반 Webview 크롤러 [WebviewHandler](./src-tauri/kabegame-core/src/crawler/webview.rs)
- 자체 개발 Tauri runtime [tauri-runtime-cef](./src-tauri/tauri-runtime-cef/)
  Kabegame에 맞춰 깊이 커스터마이즈되어 있어 crate로 배포하지는 않았습니다. AI를 이용해 여러분의 프로젝트로 옮겨올 수 있습니다.
- 자체 개발 경로 폴딩 방식 쿼리 엔진 [PathQL](./src-tauri/pathql-rs/)
  간단히 소개하자면, Provider DSL이라 부르는 파서와 URL 경로 기반 쿼리 문법을 개발했습니다. 앱 내 대부분의 이미지 쿼리는 이미 [Provider DSL JSON5\YAML 형식](./src-tauri/kabegame-core/src/providers/dsl/)으로 바뀌었으며, 이 DSL 파일들이 PathQL 엔진이 쿼리를 폴딩하는 방식을 결정합니다. 예를 들어 갤러리에서 메타데이터에 성인 키워드가 포함된 이미지를 제외하고, yande.re 출처의 4:3~16:9 가로 이미지만 무작위 순서로 보고 싶다면 쿼리는 이렇게 씁니다:
    ```url
    images://gallery/hide/~not/~any/search/metadata/pussy/~or/search/native-metadata/pussy/~end/~end/~not/~any/search/metadata/penis/~or/search/native-metadata/penis/~end/~end/~not/~any/search/metadata/sex/~or/search/native-metadata/sex/~end/~end/~not/~any/search/metadata/r18/~or/search/native-metadata/r18/~end/~end/plugin/yandere/_kb_fc/aspect/4x3-16x9/_kb_fc/sort/random-7041412897802809
    ```
  이 경로의 의미는: 숨겨지지 않은 yande.re 이미지만 조회하고, 비즈니스 메타데이터와 이미지 원본 메타데이터 모두 `pussy`, `penis`, `sex`, `r18` 중 어떤 키워드도 포함하지 않아야 하며, 이미지 가로세로비가 4:3보다 크고 16:9 이하여야 하고, 마지막으로 고정 시드로 무작위 정렬한다는 뜻입니다.
  이 쿼리 엔진에 관심이 있다면 issue를 남겨주세요. 문서를 보완하겠습니다.
  이론상 crate로 배포할 수 있지만, 아직 찾아내지 못한 엣지 케이스 버그가 남아 있을 것이므로, AI를 시켜 여러분의 프로젝트로 베껴 오게 해도 됩니다(GPL-3.0에 유의하세요).

## 다운로드 및 설치

**[GitHub Releases](https://github.com/kabegame/kabegame/releases/latest)** 에서 플랫폼에 맞는 본체를 내려받으세요(`kabegame-cli`는 별도의 선택 도구이며 본체와 함께 설치되지 않습니다):

| 플랫폼 | 다운로드 파일 | 설치 단계 |
| --- | --- | --- |
| Windows x64 | `Kabegame-standard_<버전>_x64-setup.exe` | 설치 파일을 더블클릭하고 마법사에 따라 설치합니다. 화집 가상 디스크를 사용하려면 앱 설정에서 처음 '화집 드라이브'를 켤 때 안내에 따라 함께 제공되는 Dokan 2.x 드라이버 설치를 허용하세요. 드라이버 설치 후 다시 한 번 켜면 됩니다. |
| macOS(Apple 실리콘) | `Kabegame-standard_<버전>_aarch64.dmg` | DMG를 열고 `Kabegame.app`을 '응용 프로그램'으로 끌어다 놓습니다. 설치 파일은 서명되지 않았습니다. 첫 실행 시 '손상되었습니다' 또는 개발자를 확인할 수 없다는 메시지가 나오면 아래 `xattr` 명령을 터미널에서 실행한 뒤 다시 여세요. macOS 11 이상에서 사용할 수 있습니다. |
| Linux amd64 | `Kabegame-standard_<버전>_amd64.deb` | 다운로드 디렉터리에서 아래 `apt install` 명령을 실행하세요. 화집 가상 디스크에 필요한 `fuse3`도 함께 설치됩니다. |
| Android(v4.3.0 이하만) | `Kabegame_<버전>_android-preview.apk` | 시스템 설정에서 브라우저나 파일 관리자에 '알 수 없는 출처의 앱 설치'를 허용한 뒤 APK를 눌러 안내에 따라 설치하세요. Android 8.0 이상에서 사용할 수 있으며, 새 Android 클라이언트는 아직 대응 중입니다. |

macOS 첫 실행 시 격리 해제:

```bash
xattr -d com.apple.quarantine /Applications/Kabegame.app
```

macOS에서 화집 가상 디스크를 쓰려면 macFUSE도 설치하세요. 설치 후 시스템 안내에 따라 확장을 승인하고, 필요하면 재부팅합니다:

```bash
brew install --cask macfuse
```

Linux 설치(먼저 터미널에서 설치 파일이 있는 디렉터리로 이동):

```bash
sudo apt install ./Kabegame-standard_*_amd64.deb
```

설치 후 Kabegame을 실행하면 됩니다. 이미지는 기본적으로 사용자 사진 디렉터리의 `Pictures/Kabegame`에 저장되며, 앱을 삭제해도 이 이미지들은 삭제되지 않습니다.

## 문서

전체 문서는 모두 **[kabegame.com](https://kabegame.com/)** 에 있습니다(4.4.0 이후로는 일부 동기화되지 않았을 수 있습니다):

- [사용자 가이드](https://kabegame.com/guide/installation/) —— 설치, 갤러리, 화집, 벽지, 가상 디스크, MCP 등.
- [플러그인 개발](https://kabegame.com/dev/overview/) —— V8 / WebView 크롤러 플러그인 작성, `.kgpg` 형식, 패키징 및 배포.
- [개발 참여](https://kabegame.com/dev-contrib/building/) —— 소스에서 빌드, Android 개발, 아키텍처와 기술 스택, 감사의 말과 내장 의존성.(QQ를 추가해 주세요: 2905432378)
- [명령줄 도구](https://kabegame.com/reference/cli/) 와 [API 레퍼런스](https://kabegame.com/reference/kabegame-api/).

크롤러 플러그인 저장소：**[kabegame/crawler-plugins](https://github.com/kabegame/crawler-plugins)**(플러그인 모집 중!)

## 라이선스

소스 코드는 [GPL v3](./LICENSE) 라이선스로 제공됩니다.(오픈 소스야말로 궁극적인 답)

## 이름의 유래 🐢

**Kabegame** 는 일본어「壁亀」(かべがめ)의 로마자 표기로,「壁紙」(かべがみ, "벽지")와 발음이 비슷합니다~ 마치 조용한 거북이 한 마리가 당신의 바탕화면 위에 엎드려, 이차원 벽지 컬렉션을 묵묵히 지켜보는 것처럼요. 오픈 소스를 품고, 이차원 팬을 위한 이차원 팬 자신의 소프트웨어를 만듭니다.
