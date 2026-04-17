# AdCraft — 광고 소재 자동 생성 개발 가이드

주예진 콘텐츠 기준 + 성과 소재 레퍼런스 기반으로 META 인스타그램 1:1 광고 소재를 자동 생성합니다.

---

## 파일 구조

```
hackathon-demo/
├── server.js                 ← 백엔드 (Express + Claude API)
├── public/index.html         ← 프론트엔드 (UI)
├── CHECKLIST.md              ← 주예진 광고 소재 필수 기준 (12개 MUST)
├── DESIGN_SPEC.md            ← 성과 소재 6종 디자인 분석 스펙 ★NEW
├── prompts/
│   └── generate_ad.md        ← Claude 시스템 프롬프트 v2
├── reference_images/         ← 레퍼런스 이미지 폴더 ★NEW
│   ├── .gitkeep
│   └── (여기에 성과 소재 이미지 넣으면 자동 적용)
└── .env                      ← API 키 설정
```

---

## 빠른 시작

```bash
# 1. 설치
npm install

# 2. 환경변수 (.env)
ANTHROPIC_API_KEY=sk-ant-...
UNSPLASH_ACCESS_KEY=...       # 선택: 배경 이미지 검색

# 3. 서버 시작
npm start
# → http://localhost:3000
```

---

## ★ reference_images/ 사용법

폴더에 성과 소재 이미지를 넣으면 **서버 시작 시 자동으로 로드**됩니다.  
API 요청에 `reference_images`가 없으면 폴더 이미지가 자동 적용됩니다.

```
reference_images/
├── stat_card_01.jpg      ← 수치카드형 레퍼런스
├── headline_copy_02.jpg  ← 헤드카피형 레퍼런스
├── photo_overlay_03.jpg  ← 포토오버레이형 레퍼런스
└── ...
```

**지원 형식**: JPG, JPEG, PNG, WEBP  
**최대 권장**: 3장 (Claude Vision 분석 한도)

### 코드로 직접 넘기는 방법 (API 사용 시)

```javascript
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// reference_images/ 폴더 전체를 base64로 변환
function loadReferenceImages(folderPath = './reference_images') {
  const files = readdirSync(folderPath)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort();

  return files.map(f => {
    const buf = readFileSync(join(folderPath, f));
    const ext = f.split('.').pop().toLowerCase();
    const mime = ext === 'png' ? 'image/png'
               : ext === 'webp' ? 'image/webp'
               : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  });
}

// API 요청에 포함
const response = await fetch('http://localhost:3000/api/generate-ad', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://example.com/product',
    target: '30대 직장인',
    reference_images: loadReferenceImages(),  // ← 이미지 자동 포함
  }),
});
```

---

## 에이전트 구조 (v2)

```
URL 크롤링
     ↓
  [병렬 실행]─────────────────────────────────
  🖼 이미지 에이전트              소재정보 추출
  ├─ reference_images/ 자동로드   (URL에서 자동)
  ├─ 스타일 분석 (Claude Vision)
  └─ OG 이미지 fetch
  ─────────────────────────────────────────────
     ↓ (둘 다 완료)
  ✍️ 카피 에이전트
  └─ 스타일 분석 결과 + 체크리스트 기준으로 카피 3종 생성
     ↓
  🔧 조합 에이전트
  └─ 카피 + 이미지 → HTML 1080×1080 소재 3종
```

---

## API 명세

### POST `/api/generate-ad`

```json
{
  "url": "https://example.com/product",
  "target": "30대 직장인 데이터 분석 입문자",
  "usp1": "실무 현업 강사진",
  "usp2": "12개월 무제한 수강",
  "usp3": "취업 연계 지원",
  "reference_images": ["data:image/jpeg;base64,..."],
  "bg_color": "#1B5BD4",
  "custom_bg_image": "data:image/jpeg;base64,..."
}
```

### POST `/api/suggest-design`

URL 분석 → AI 디자인 제안 반환

```json
{ "url": "https://example.com/product" }

→ {
  "bg_keywords_en": "professional data analysis",
  "copy_tone": "친근한 공감형",
  "color_hex": "#0A1628",
  "target": "현업 전환을 원하는 30대",
  "hook_suggestion": "데이터 분석, 이제 선택이 아니에요"
}
```

### GET `/api/search-unsplash?q=keyword`

Unsplash 이미지 검색 (UNSPLASH_ACCESS_KEY 필요)

---

## 체크리스트 기준 변경 시

`CHECKLIST.md`만 수정 → 서버 재시작 → 자동 반영  
코드 수정 불필요.

## 디자인 스펙 변경 시

`DESIGN_SPEC.md`에 수치 업데이트 → `prompts/generate_ad.md`에 반영  
새 레퍼런스 이미지는 `reference_images/` 폴더에 추가 후 서버 재시작.

---

> 담당: 소수현 (백엔드/프롬프트) · 주예진 (콘텐츠 기준)
