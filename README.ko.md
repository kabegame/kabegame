# Kabegame 이차원 크롤러 클라이언트

> *Translated by AI. [English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | 한국어*

Tauri 기반 이차원 크롤러 클라이언트! 벽지 크롤링·관리·설정·로테이션. 매일 좋아하는 이미지로 힐링하세요~ 플러그인으로 확장 가능, 다양한 이차원·애니 벽지 사이트에서 쉽게 이미지를 가져올 수 있습니다.

> 🌐 **데모 페이지**: [https://kabegame.com/](https://kabegame.com/)

<div align="center">
  <img src="docs/images/icon.png" alt="Kabegame" width="256"/>
</div>

## 갤러리 스크린샷

<table>
  <tr>
    <td align="center" style="width: 300px;">
      <img src="docs/images/main-screenshot-windows-gallery.png" alt="Kabegame Windows 스크린샷 1" width="300"/><br/>
      <small>Windows</small>
    </td>
    <td align="center" style="width: 300px;">
      <img src="docs/images/main-screenshot-windows-preview.png" alt="Kabegame Windows 스크린샷 2" width="300"/><br/>
      <small>Windows</small>
    </td>
    <td align="center" rowspan="2" style="vertical-align: top; text-align: right; width: 200px;">
      <img src="docs/images/main-screenshot-android-gallery.jpg" alt="Kabegame Android 스크린샷" width="200"><br/>
      <small>Android</small>
    </td>
  </tr>
  <tr>
    <td align="center" style="width: 300px;">
      <img src="docs/images/main-screenshot3-macos.png" alt="Kabegame macOS 스크린샷" width="300"/><br/>
      <small>macOS</small>
    </td>
    <td align="center" style="width: 300px;">
      <img src="docs/images/main-screenshot-linux.png" alt="Kabegame Linux 스크린샷" width="300"/><br/>
      <small>Linux</small>
    </td>
  </tr>
</table>

## 크롤러 스크린샷

|  |  |
| --- | --- |
| <div align="center"><img src="docs/images/crawler/pixiv.png" alt="Pixiv 크롤러" width="380"/><br/><small><a href="https://pixiv.net">Pixiv</a> (작가: <a href="https://www.pixiv.net/users/16365055">somna</a>)</small></div> | <div align="center"><img src="docs/images/crawler/anihonet.png" alt="anihonet 크롤러" width="380"/><br/><small><a href="https://anihonetwallpaper.com">anihonet</a> (연간 랭킹)</small></div> |
| <div align="center"><img src="docs/images/crawler/anime-pictures.png" alt="anime-pictures 크롤러" width="380"/><br/><small><a href="https://anime-pictures.net">anime-pictures</a> (키워드: 붕괴:스타레일)</small></div> | <div align="center"><img src="docs/images/crawler/konachan.png" alt="konachan 크롤러" width="380"/><br/><small><a href="https://konachan.net">konachan</a> 벽지</small></div> |
| <div align="center"><img src="docs/images/crawler/2dwallpaper.png" alt="2dwallpaper 크롤러" width="380"/><br/><small><a href="https://2dwallpapers.com">2dwallpaper</a> (게임→원신→최다 조회)</small></div> | <div align="center"><img src="docs/images/crawler/ziworld.png" alt="ziworld 크롤러" width="380"/><br/><small><a href="https://t.ziworld.top">ziworld</a> 벽지</small></div> |

<p align="center"><sub>다양한 사이트 지원, 플러그인으로 확장 가능. 기여 환영!</sub></p>

[→ 크롤러 플러그인 저장소](https://github.com/kabegame/crawler-plugins/tree/main)

## 이름 유래 🐢

**Kabegame**은 일본어 壁亀(かべがめ)의 로마자 표기. 壁紙(かべがみ, 벽지)와 발음이 비슷해요~ 조용한 거북이가 데스크톱에서 지켜보듯, 애니메이션 벽지 컬렉션을 조용히 지켜줍니다. これで毎日癒やされるね。やったぁ～ ✨

> 나의 철학: 오픈소스를 품고, 덕후를 위한 소프트웨어를 만들다.

## 기능

- 🔌 **크롤러 클라이언트**: `.kgpg` 플러그인으로 각 사이트에서 벽지 수집; 내장 플러그인 스토어로 탐색·설치·관리; 작업 진행·중지·삭제; CLI로 플러그인 실행·이미지 가져오기 등
- 🎨 **벽지 설정(이미지/동영상)**: 애니메이션 벽지 수집·관리·로테이션; 지정 앨범에서 자동으로 바탕화면 벽지 교체(랜덤/순차)
- 🖼️ **이미지 관리(이미지/동영상)**: 갤러리 탐색, 앨범 정리, 가상 디스크(Windows는 드라이브, macOS/Linux는 가상 폴더), 로컬 이미지·동영상·폴더·아카이브 또는 kgpg 드래그 앤 드롭

(동영상은 v3.2.2 기준 mp4, mov만 지원)

## 설치

**OS에 맞는 패키지를 선택하세요.**

**[GitHub Releases에서 다운로드 (최신)](https://github.com/kabegame/kabegame/releases/latest)**

| OS | 다운로드 |
|----|---------|
| Windows | [setup.exe](https://github.com/kabegame/kabegame/releases/download/v4.4.0/Kabegame-standard_4.4.0_x64-setup.exe) |
| macOS | [dmg](https://github.com/kabegame/kabegame/releases/download/v4.4.0/Kabegame-standard_4.4.0_aarch64.dmg) |
| Linux | [deb](https://github.com/kabegame/kabegame/releases/download/v4.4.0/Kabegame-standard_4.4.0_amd64.deb) |

- **Android 미리보기**：[apk](https://github.com/kabegame/kabegame/releases/download/v4.4.0/Kabegame_4.4.0_android-preview.apk)（동일 릴리스 페이지）。
- **CLI**: 앱에 번들되지 않고 별도로 배포됩니다. 동일한 릴리스 페이지에서 `kabegame-cli`를 다운로드해 PATH에 추가 후 사용하세요(`kabegame-cli --help`).

## 설치

### Windows

1. **다운로드**: `setup.exe` 다운로드
2. **설치 프로그램 실행**: 더블클릭 후 마법사 따르기
3. 이것으로 끝!

> **팁**: 설치 프로그램은 자동 업데이트 지원. 다시 실행하면 업그레이드 가능.

### macOS

> **최소**: macOS **11 (Big Sur)** 이상.

1. **DMG 다운로드**: `.dmg` 다운로드
2. **설치**: `.dmg` 열고 `Kabegame.app`을 애플리케이션 폴더로 드래그
> [!IMPORTANT]
> ## 수정: "Kabegame.app"이 손상되어 열 수 없음
> 애플리케이션 폴더에 설치 후 Gatekeeper 우회 필요(오픈소스 앱이라 Apple 개발자 수수료 미지불).
>
> `xattr -d com.apple.quarantine /Applications/Kabegame.app`
3. **가상 디스크/FUSE**: macFUSE 필요 `brew install macfuse`

### Linux (Debian 계열, Ubuntu 등)

> **최소**: Ubuntu **22.04** / Debian 12 이상 (glibc ≥ 2.35).

**설치**:
  ```bash
  sudo apt install ./Kabegame-standard_<version>_<arch>.deb
  ```
  - 또는 `sudo dpkg -i Kabegame-standard_<version>_<arch>.deb`. 의존성 문제 시 `sudo apt-get install -f`

## 주요 기능

### 🖼️ 갤러리 & 이미지 관리

갤러리는 Kabegame의 핵심. 수집한 벽지가 여기에 표시됩니다. 페이지네이션, 미리보기, 다중 선택, 중복 제거 등. 로컬 파일 드래그로 가져오기. 더블클릭으로 앱 내 미리보기(줌·팬·탐색).

### 📸 앨범

벽지를 커스텀 앨범으로 정리. 즐겨찾기 추가, 드래그로 순서 변경. 앨범은 벽지 로테이션과 가상 디스크 레이아웃에 사용.

### 🔌 플러그인 시스템

Kabegame의 강점은 플러그인 기반 크롤러. `.kgpg` 플러그인으로 애니메이션 벽지 사이트에서 이미지 수집. Rhai로 작성. 내장 플러그인 스토어로 원클릭 설치, 또는 타 개발자 플러그인 가져오기, 직접 작성도 가능. 分かるな。

### 🎨 벽지 & 로테이션

원클릭으로 바탕화면 벽지 설정. 네이티브 모드(성능)와 윈도우 모드(추가 기능). 로테이션으로 앨범에서 자동 교체(랜덤/순차), 간격 설정 가능.

### 📋 크롤러 작업 관리

모든 작업을 한곳에서 관리. 진행률·상태·이미지 수. 상세 보기, 실행 중 중지, 완료 삭제.

### 💾 가상 디스크

Windows·macOS·Linux에서 앨범을 가상 디스크(가상 폴더)로 마운트. 파일 관리자에서 일반 폴더처럼 탐색.

### ⌨️ CLI

Headless CLI로 플러그인 실행·이미지 가져오기·앨범 관리. 자동화·배치 작업에 적합. `.kgpg` 더블클릭 시 CLI로 상세 보기. 앱에 동봉되지 않으며 릴리스 페이지에서 별도로 다운로드합니다.

### 기타

내장 도움말 페이지로 Kabegame을 더 알아보세요.

これからもっと機能や改良を行っていく予定です。ぜひご期待を。

## 주의사항

- 크롤링 시 대상 사이트의 robots.txt와 이용약관을 준수하세요.
- 벽지는 기본적으로 `Pictures/Kabegame` 또는 앱 데이터 `images` 폴더에 저장(앱 내 설정 가능).
- 언인스톨 시 "데이터 삭제" 선택 시 앱 데이터만 삭제되고 이미지는 유지됩니다.
- 벽지 로테이션은 앱을 백그라운드(트레이)에서 실행해야 합니다.

## 언인스톨

### Windows
설정 → 앱 → 설치된 앱 → Kabegame 검색 → ⋮ → 제거

### Linux
`sudo dpkg -r kabegame`

---

## 기술 스택

- **프론트**: Vue 3 + TypeScript + Element Plus + UnoCSS
- **백엔드**: Rust (Tauri) + Kotlin (Jetpack)
- **상태**: Pinia
- **라우터**: Vue Router
- **빌드**: Vite 5
- **플러그인**: Rhai

## 개발

### 사전 요구사항

- Deno 2.9.0（권장: 트리 내 소스에서 빌드 — `bash scripts/build-deno.sh`로 `target/release/deno`를 생성하고 `target/release`를 PATH 앞에 추가. 또는 과도기적으로 공식 설치 스크립트로 2.9.0 설치）
- Rust 1.70+ (Rust 2021 Edition)
- [Tauri CLI](https://tauri.app/v2/guides/getting-started/prerequisites)

### 의존성 설치

```bash
deno install
```

FFmpeg는 `third/FFmpeg`의 Git 서브모듈. `deno task build:ffmpeg` 전에 `git submodule update --init --recursive`.

### 개발·빌드

```bash
deno task dev -c kabegame              # 메인 앱
deno task dev -c kabegame --mode local # 로컬 모드
deno task start -c kabegame-cli             # CLI
deno task b                        # 전체 빌드
deno task check -c kabegame            # 검사
```

### Android

- Android Studio, JAVA_HOME, ANDROID_HOME, NDK_HOME 필수
- `deno task dev -c kabegame --mode android`（`--android`에서 변경）
- 디버깅은 Chrome DevTools에서 `chrome://inspect/#devices`

## 프로젝트 구조

```
.
├── apps/kabegame/
├── packages/core/
├── src-tauri/
│   ├── kabegame-core/
│   ├── kabegame/
│   └── kabegame-cli/
├── src-crawler-plugins/
├── docs/
└── ...
```

![visitor badge](https://visitor-badge.laobi.icu/badge?page_id=kabegame.readme.ko)

## 플러그인 개발

- [플러그인 개발 가이드](docs/README_PLUGIN_DEV.md)
- [플러그인 형식](docs/PLUGIN_FORMAT.md)
- [Rhai API](docs/RHAI_API.md)

## 라이선스

GPL v3. [LICENSE](./LICENSE) 참조.

## 감사의 말

본 프로젝트는 Tauri, Vue, Vite, TypeScript, Element Plus, Pinia, Rhai, FFmpeg 등 오픈소스 프로젝트에 기반합니다. 감사합니다!

### 벤더 내장 & 패치 적용（`third/`）

이 상위 프로젝트들은 `third/` 아래 Git 서브모듈로 벤더링되어 있으며, `third-patches/`의 번호가 붙은 패치 시리즈로 관리됩니다.

- [**CEF (Chromium Embedded Framework)**](https://github.com/chromiumembedded/cef) - 데스크톱 WebView 백엔드로 사용하는 Chromium 브라우저 엔진（branch 7827）
- [**cef-rs**](https://github.com/tauri-apps/cef-rs) - CEF의 Rust 바인딩（tauri-apps fork, 플랫 서브프로세스 경로 패치 적용）
- [**deno**](https://github.com/denoland/deno) - V8 기반 JS 런타임; `deno_core` 크레이트가 크롤러 플러그인 V8 백엔드와 자체 빌드 Deno CLI를 구동
- [**rusty_v8**](https://github.com/denoland/rusty_v8) - V8의 Rust 바인딩; Android aarch64용 자체 빌드
- [**FFmpeg**](https://github.com/FFmpeg/FFmpeg) - 데스크톱 동영상 수집（미리보기 압축·크기 감지）용 멀티미디어 프레임워크
- [**x264**](https://code.videolan.org/videolan/x264) - H.264 인코더; FFmpeg 빌드에서 정적 링크
- [**rsmpeg**](https://github.com/larksuite/rsmpeg) - FFmpeg libav\*의 안전한 Rust 래퍼
- [**rusty_ffmpeg**](https://github.com/CCExtractor/rusty_ffmpeg) - rsmpeg가 사용하는 FFmpeg bindgen 헬퍼
- [**tauri**](https://github.com/tauri-apps/tauri) - 크로스 플랫폼 데스크톱 프레임워크; `TAURI_ANDROID_PACKAGE`, 최상위 `bins` 설정 등 Kabegame 전용 패치가 적용된 fork

이 프로젝트들이 도움이 됐다면 ⭐ Star 를 눌러주세요！
