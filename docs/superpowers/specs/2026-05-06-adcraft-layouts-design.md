# AdCraft 레이아웃 7종 확장 — Design Spec

**날짜:** 2026-05-06  
**목표:** 마케터가 Figma를 거치지 않고 AdCraft만으로 완성도 높은 광고소재를 바로 뽑을 수 있도록, 레이아웃 7종 신규 추가 + 인물 이미지 자동추출/수동입력 기능 구현

---

## 1. 배경 & 목표

- 현재 AdCraft: 포토오버레이 3종 + 레거시 4종 (사실상 포토오버레이 위주)
- 목표: 에듀테크 광고에서 실제 집행되는 레이아웃 7종으로 확장
- 성공 기준: 마케터가 URL 입력 → 레이아웃 선택 → 생성 클릭만으로 Figma 수정 없이 바로 쓸 수 있는 소재 출력

---

## 2. 아키텍처

```
[프론트] 레이아웃 선택 + (선택) 인물이미지 업로드/URL
    ↓ POST /api/generate-ad
[서버] fetchPageContent (인물이미지 자동감지 포함)
    ↓
[Claude] 카피 + 레이아웃별 추가필드 생성
    ↓
[assemblyAgent] layout_type → HTML generator 함수 라우팅
    ↓
[프론트] 생성 결과 미리보기 + 다운로드
```

**변경 파일:**
- `server.js`: HTML 생성함수 7개 추가, 인물이미지 추출 로직, API 파라미터 확장
- `public/index.html`: 레이아웃 피커 UI, 인물이미지 입력 UI, 세미나형 전용 입력 추가

---

## 3. 신규 레이아웃 7종

### ① 강사강조형 `instructor`
**구조:**
- 배경: 흰색/밝은 BG + 격자 텍스처 (grid pattern)
- 상단: 훅 텍스트 + 대제목 2줄 (포인트컬러 강조)
- 중단: USP 카드 4개 가로배열 (번호 + 이미지 placeholder + 설명텍스트), 마지막 카드에 선택적 강조 뱃지 (예: "ONLY" / "NEW" / "패캠 Only" — `cta_badge` 필드 재활용)
- 하단: [강사 원형사진 120px | 이름 굵게 + 현직 + 전직 | bullet 3개]
- CTA: 라운드 버튼 바 (포인트컬러)

**레이아웃별 Claude 추가 필드:**
```
instructor_name, instructor_title (현), instructor_career (전),
instructor_bullet1~3, usp_module1~4
```

**인물이미지:** 원형 crop, 120~160px, 강사 상반신

---

### ② 세미나형 `seminar` (인물강조)
**구조:**
- 배경: 그라디언트 (보라→파랑→민트, 또는 bgColor 기반)
- 상단: [이벤트 뱃지: 무료LIVE/유료] + 날짜·시간 텍스트
- 중상단: 대제목 2줄 (흰색, 굵게)
- 서브: 부제목 한 줄 (반투명 흰색)
- 중하단: 강사 전신사진 (원형 배경 + 이름 + 부제목)
- CTA: 하단 고정

**사용자 입력 필드 (프론트 추가):**
- `event_badge`: "무료 LIVE" / "유료 세미나" / "무료 웨비나" (드롭다운)
- `event_date`: 날짜+시간 텍스트 (예: "2026. 05. 10 (일) 20:00")

**Claude 추가 필드:** `instructor_name`, `instructor_subtitle`

**인물이미지:** 전신, 배경 제거 PNG 권장, 우측/중앙 배치

---

### ③ SNS UI형 `sns-post`
**구조:**
- 상단 nav바: 플랫폼 컬러 + 메뉴탭 (Q&A | 지식 | 커뮤니티 | 이벤트 | JOBS) + "질문하기" 버튼
- 포스트 영역 (흰/다크 BG):
  - [아바타 원] 닉네임 + 하트수 + 날짜
  - 제목: 굵은 의문형 본문제목
  - 본문: 3~4줄 자연스러운 카피 (개인 경험담 어투)
- CTA: 라운드 버튼 (플랫폼 컬러)
- 다크/라이트 variant: bgColor 밝기 기준 자동 결정 (luminance < 0.3 → 다크, 그 외 → 라이트)

**Claude 추가 필드:** `post_username`, `post_body` (3~4줄 이어쓰기)

---

### ④ 비교형 `comparison`
**구조:**
- 상단(45%): 다크BG + (배경이미지 있으면 dim) + 헤드라인/훅
- 물결/사선 분리선
- 하단(55%): 흰BG + 비교표
  - A행: 기존 방식 (회색/중립)
  - B행: 수강 후 / 우리 제품 (포인트컬러 강조)
  - 컬럼: 타임라인 단계별 (본과→인턴→전공의→... 등 페이지 맥락에서 추출)
- 하단 CTA: 마무리 카피 + 버튼

**Claude 추가 필드:**
```
comparison_a_label, comparison_b_label,
comparison_items: [{stage, a_state, b_state}] (최대 5개)
```

---

### ⑤ 이미지강조형 `image-hero`
**구조:**
- 풀블리드 배경 이미지 (GPT 이미지 or 업로드)
- 상단 우측: 소형 뱃지 (선착순/얼리버드 등, 라운드 필)
- 중하단: 대제목 2줄 (흰색, 굵게, 텍스트 그림자)
- CTA: 하단 고정 바 (포인트컬러, 전체 폭)

**기존 필드 활용** (추가 Claude 필드 없음)  
배경 이미지 의존도 높음. 처리 우선순위: ① 사용자 업로드 bgImage → ② GPT 이미지 자동 생성 (OPENAI_API_KEY 있을 때) → ③ bgColor 단색 배경

---

### ⑥ 커리큘럼강조형 `curriculum`
**구조:**
- 배경: 다크 (네이비 #0a0e1a or 블랙)
- 상단: 대제목 2줄 (흰색, 포인트 키워드 강조)
- 중단: 수평 로드맵 (5단계, 점+선 연결, 각 단계명 라벨)
- 하단: 썸네일 그리드 (5열 × 4행 = 20개 회색 카드)
- 좌하: 원형 배지 (예: "국내 유일 Full-로드맵 강의")
- 우하: 서브카피 텍스트 + 강조 키워드

**Claude 추가 필드:** `curriculum_step1~5`, `curriculum_badge`

---

### ⑦ 후기사례형 `review`
**구조:**
- 배경: 다크 BG (블랙/다크 그레이)
- 상단: 훅 + 헤드라인 (흰색)
- 중단: 강사/수강생 사진 (우측, 자연스러운 포즈, 이미지강조)
- 하단: 별점 후기 카드 3개 (라운드 카드, 다크 배경)
  - ★★★★★ + 후기 본문 + 키워드 포인트컬러 강조
- CTA: 하단 버튼

**Claude 추가 필드:** `review_body1~3` (각 50자 이내, 키워드 **굵게** 마크 포함)

**인물이미지:** 측면/자연스러운 포즈, 우측 배치

---

## 4. 인물 이미지 처리

### 자동추출 (Auto)
`fetchPageContent` 내 인물이미지 감지 추가:
```
우선순위:
1. JSON-LD의 "instructor" / "teacher" / "author" → image 필드
2. <img>의 alt/class/id에 "강사|튜터|instructor|teacher|mentor|profile|avatar" 포함
3. srcset 중 가장 큰 이미지
4. OG image (폴백)
→ person_image_url 반환 (없으면 null)
```

서버가 `/api/generate-ad` 응답에 `detected_person_image` 포함 → 프론트가 미리보기 표시

### 수동입력 (Manual)
프론트에 "인물 이미지" 섹션 (인물강조 레이아웃 선택 시만 표시):
- 자동감지 이미지 썸네일 + "변경" 버튼
- 파일 업로드 → base64 변환 → `person_image_base64`로 전송
- CDN URL 입력 → "불러오기" 버튼 → `/api/fetch-image` 프록시 → base64 변환

### API 파라미터 추가
```json
POST /api/generate-ad
{
  "person_image_base64": "data:image/png;base64,...",
  "event_date": "2026. 05. 10 (일) 20:00",
  "event_badge": "무료 LIVE"
}
```

---

## 5. Claude 카피 스키마 확장

레이아웃별 추가 필드는 선택된 `layout_type` 기준으로 프롬프트에 조건부 삽입:

```json
{
  "hook": "", "headline_line1": "", "headline_line2": "",
  "cta_badge": "", "cta_text": "",
  "visual_stat1_value": "", "visual_stat1_label": "",

  // instructor / seminar / review 레이아웃
  "instructor_name": "",
  "instructor_title": "",
  "instructor_career": "",
  "instructor_bullet1": "", "instructor_bullet2": "", "instructor_bullet3": "",

  // instructor 전용
  "usp_module1": "", "usp_module2": "", "usp_module3": "", "usp_module4": "",

  // seminar 전용
  "instructor_subtitle": "",

  // review 전용
  "review_body1": "", "review_body2": "", "review_body3": "",

  // curriculum 전용
  "curriculum_step1": "", "curriculum_step2": "", "curriculum_step3": "",
  "curriculum_step4": "", "curriculum_step5": "", "curriculum_badge": "",

  // sns-post 전용
  "post_username": "", "post_body": "",

  // comparison 전용
  "comparison_a_label": "", "comparison_b_label": "",
  "comparison_items": [{"stage":"", "a_state":"", "b_state":""}]
}
```

---

## 6. 프론트엔드 변경

### 레이아웃 피커
- 기존 3종 카드 → 10종 카드 (7 신규 + 기존 3 유지)
- 각 카드: 레이아웃명 + 간단한 아이콘/설명
- 인물강조 레이아웃 선택 시: "인물 이미지" 섹션 자동 노출
- 세미나형 선택 시: "이벤트 날짜", "이벤트 배지" 입력란 자동 노출

### 인물 이미지 UI
```html
<!-- 인물강조 레이아웃 선택 시만 표시 -->
<section id="personImageSection" style="display:none">
  <div id="personImagePreview"><!-- 자동감지 미리보기 --></div>
  <input type="file" id="personImageUpload">
  <input type="url" id="personImageUrl" placeholder="CDN URL 입력">
  <button onclick="fetchPersonImageFromUrl()">불러오기</button>
</section>
```

---

## 7. assemblyAgent 라우팅 확장

```javascript
// server.js assemblyAgent
const layoutMap = {
  'photo-overlay':  (d, bg, img, css, font) => generateFigmaPhotoHTML(...),
  'twitter':        (d, bg, _, __, font)    => generateFigmaTwitterHTML(...),
  'instructor':     (d, bg, img, _, font)   => generateInstructorHTML(...),
  'seminar':        (d, bg, img, _, font)   => generateSeminarHTML(...),
  'sns-post':       (d, bg, _, __, font)    => generateSnsPostHTML(...),
  'comparison':     (d, bg, img, css, font) => generateComparisonHTML(...),
  'image-hero':     (d, bg, img, css, font) => generateImageHeroHTML(...),
  'curriculum':     (d, bg, _, __, font)    => generateCurriculumHTML(...),
  'review':         (d, bg, img, _, font)   => generateReviewHTML(...),
};
```

---

## 8. 인물강조 레이아웃 ID 정의

```
instructor  = (인물강조) 강사강조형
seminar     = (인물강조) 세미나형
review      = 후기사례형 (인물 선택적)
```

비인물 레이아웃: `sns-post`, `comparison`, `image-hero`, `curriculum`

---

## 9. 범위 제외 (이번 스펙에서 제외)

- 비교형의 그래프/차트 애니메이션 (정적 HTML만)
- 커리큘럼형 실제 썸네일 이미지 (회색 placeholder 카드로 처리)
- 세미나형 카운트다운 타이머 (정적 날짜 표시만)
- 다국어 레이아웃별 폰트 커스터마이징
