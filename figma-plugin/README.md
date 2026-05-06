# AdCraft Figma 플러그인 설치 가이드

AI가 자동으로 광고 카피를 생성하고 Figma 레이어에 바로 적용해주는 플러그인입니다.

---

## 설치 방법 (Figma Desktop 필수)

> **주의:** Figma 웹 브라우저 버전에서는 플러그인 개발자 가져오기가 지원되지 않습니다.  
> 반드시 **Figma Desktop 앱**을 사용해주세요.

### 1단계 — 플러그인 파일 다운로드

이 폴더의 파일 3개를 PC에 다운로드합니다:
- `manifest.json`
- `code.js`
- `ui.html`

같은 폴더에 모아서 저장해주세요 (예: `바탕화면/adcraft-plugin/`).

**GitHub에서 다운로드하는 방법:**
1. 이 레포 페이지 우측 상단 초록 `<> Code` 버튼 클릭
2. `Download ZIP` 선택 → 압축 해제
3. `figma-plugin` 폴더를 찾아 원하는 위치에 복사

---

### 2단계 — Figma에서 가져오기

1. **Figma Desktop** 실행
2. 상단 메뉴 → `Plugins` → `Development` → `Import plugin from manifest...`
3. 1단계에서 저장한 폴더의 **`manifest.json`** 파일 선택
4. 완료! 플러그인 목록에 `AdCraft — AI 광고소재`가 추가됩니다.

---

### 3단계 — 플러그인 실행

1. Figma에서 광고 프레임 선택
2. `Plugins` → `Development` → `AdCraft — AI 광고소재` 실행
3. URL, 타겟, USP 입력 후 `광고 카피 생성` 버튼 클릭

---

## 플러그인 업데이트

플러그인 파일이 바뀌면 다시 다운로드 후 같은 폴더에 덮어쓰면 됩니다.  
Figma를 재실행하면 자동으로 최신 버전이 적용됩니다.

---

## 문제 발생 시

- 오류 발생 시 슬랙 채널에 스크린샷과 함께 공유해주세요.
- 서버: `https://adcraft-hackathon.vercel.app`
