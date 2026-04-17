# AdCraft — AI 광고소재 자동화

META 인스타그램 1:1 광고소재를 자동 생성하는 AI 툴.
상세페이지 URL + 타겟/USP/메시지를 입력하면 카피 배리에이션 3종(혜택형·공감형·긴박형) + 1080×1080 HTML 광고소재를 출력한다.

---

## 기술 스택

| 레이어 | 구성 |
|--------|------|
| Backend | Node.js + Express (`server.js`) |
| Frontend | Vanilla HTML/CSS/JS (`public/index.html`) |
| AI | Anthropic Claude API — `claude-sonnet-4-6` |

---

## 로컬 실행

```bash
# 1. 의존성 설치
npm install

# 2. 환경변수 설정 (.env 파일 생성)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 3. 서버 시작
npm start
# → http://localhost:3000
```

> **API 키 발급:** https://console.anthropic.com → API Keys → Create Key

---

## 역할 분담 규칙

| 역할 | 담당 파일 | 건드리지 말아야 할 파일 |
|------|----------|----------------------|
| 프론트엔드 | `public/index.html` | `server.js` |
| 백엔드/프롬프트 | `server.js` | `public/index.html` |

**파일 충돌 방지:** 각자 본인 파일만 수정한다. 기능 추가 시 반드시 브랜치를 따로 만든다.

---

## 브랜치 전략

```
main              ← 완성본만 머지
├── feat/frontend ← 프론트엔드 작업
└── feat/backend  ← 백엔드/프롬프트 작업
```

```bash
# 작업 시작
git checkout -b feat/frontend

# 작업 완료 후
git add public/index.html
git commit -m "feat: ..."
git push origin feat/frontend
# → GitHub에서 main으로 PR 생성
```

---

## API 명세

### POST `/api/generate-ad`

**요청 바디**
```json
{
  "url": "https://example.com/product",
  "target": "30대 직장인 데이터 분석 입문자",
  "usp1": "실무 현업 강사진",
  "usp2": "12개월 무제한 수강",
  "usp3": "취업 연계 지원",
  "ad_set_message": "지금 데이터 역량을 키워야 하는 이유",
  "creative_message": "12개월 무제한 + 실무 프로젝트 중심",
  "reference_images": ["data:image/png;base64,..."],
  "bg_color": "#1B5BD4"
}
```

**응답**
```json
{
  "variations": [
    {
      "adData": {
        "variation_label": "A - 혜택형",
        "brand": "패스트캠퍼스",
        "hook": "직장인도 3개월이면 충분합니다",
        "headline_line1": "데이터 분석",
        "headline_line2": "역량 레벨업",
        "visual_stat1_value": "3,200+",
        "visual_stat1_label": "누적 수강생",
        "visual_stat2_value": "12개월",
        "visual_stat2_label": "무제한 수강",
        "cta_badge": "📊 데이터 역량 UP",
        "cta_text": "지금 바로 수강 신청하기 →",
        "footnote": null
      },
      "html": "<!DOCTYPE html>..."
    },
    { "adData": { "variation_label": "B - 공감형", "..." }, "html": "..." },
    { "adData": { "variation_label": "C - 긴박형", "..." }, "html": "..." }
  ]
}
```

### POST `/api/fetch-image`

Meta 광고 라이브러리 이미지 URL을 base64로 변환해 반환 (CORS 우회용 프록시).

```json
{ "url": "https://scontent-*.fbcdn.net/v/..." }
→ { "dataUrl": "data:image/jpeg;base64,..." }
```

---

## 주요 함수 구조 (`server.js`)

```
fetchPageContent(url)
  └─ 상세페이지 크롤링 → 텍스트 3000자 추출

analyzeReferenceImages(images)
  └─ Claude Vision으로 레퍼런스 이미지 디자인 스타일 분석

extractAdDataVariations(pageContent, styleAnalysis, info)
  └─ Claude에게 3종 배리에이션 JSON 배열 요청

generateAdHTML(adData, bgColor)
  └─ JSON → 1080×1080 HTML 생성 (Pretendard 폰트, 인라인 CSS)
```

---

## 광고 데이터 필드 설명

| 필드 | 설명 | 제한 |
|------|------|------|
| `hook` | 상단 훅 문구 | 최대 25자 |
| `headline_line1` | 헤드라인 1줄 | 최대 12자 |
| `headline_line2` | 헤드라인 2줄 | 최대 12자 |
| `visual_stat1_value` | 수치 카드 값 | 예: "3,200+" |
| `visual_stat1_label` | 수치 카드 설명 | 예: "누적 수강생" |
| `cta_badge` | CTA 뱃지 | 이모지 포함 최대 12자 |
| `cta_text` | CTA 문구 | 최대 24자, "→"로 끝 |
| `footnote` | 하단 주석 | *로 시작, 없으면 null |

---

## 개발 시 Claude 활용 팁

- **프론트 작업:** "public/index.html에서 [구체적인 부분]을 수정해줘. server.js는 건드리지 마."
- **백엔드 작업:** "server.js의 extractAdDataVariations 프롬프트에서 [구체적인 내용]을 개선해줘."
- **버그 발생 시:** 에러 메시지 전체를 Claude에게 붙여넣고 어느 파일에서 발생했는지 알려주기
