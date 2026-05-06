# AdCraft 레이아웃 7종 확장 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 레이아웃 7종 신규 추가 + 인물 이미지 자동추출/수동입력 + 컬러 커스터마이징 패널 구현으로, 마케터가 Figma 없이 AdCraft만으로 완성 소재를 바로 뽑을 수 있게 한다.

**Architecture:** `server.js`에 HTML 생성 함수 7개 추가 및 `assemblyAgent` 라우팅 확장. `fetchPageContent`에 인물이미지 감지 로직 추가. `/api/generate-ad` 응답에 `detectedPersonImageUrl` 포함. `public/index.html`에 레이아웃 카드 7종, 인물이미지 UI, 컬러 커스터마이징 패널 추가. HTML 템플릿 전체에 CSS 변수 통일 적용하여 서버 재호출 없이 색상 실시간 변경.

**Tech Stack:** Node.js + Express, Vanilla JS, Anthropic Claude API (claude-sonnet-4-6), Vercel

---

## 파일 맵

| 파일 | 작업 |
|---|---|
| `server.js` | 인물이미지 추출 함수, /api/fetch-person-image, copyAgent 확장, 7개 HTML 생성 함수, assemblyAgent 확장, generateAdHTML 확장 |
| `public/index.html` | 레이아웃 카드 7종, 인물이미지 UI, 세미나 입력 필드, 컬러 커스터마이징 패널 |

---

## Task 1: 인물 이미지 추출 + `/api/fetch-person-image`

**Files:**
- Modify: `server.js` (fetchPageContent 함수, 새 API 엔드포인트)

- [ ] **Step 1: `extractPersonImageUrl` 헬퍼 함수 추가**

`server.js`의 `fetchPageContent` 함수(line 514) 바로 위에 삽입:

```javascript
// ─── 인물 이미지 URL 추출 (강사/인물 우선) ───
function extractPersonImageUrl(html) {
  // 1순위: JSON-LD instructor/teacher/author image
  const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdMatches) {
    try {
      const inner = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
      const data = JSON.parse(inner);
      const objs = Array.isArray(data) ? data : [data];
      for (const obj of objs) {
        const candidates = [obj.instructor, obj.teacher, obj.author, obj.creator]
          .flat().filter(Boolean);
        for (const c of candidates) {
          const img = typeof c === 'object' ? (c.image?.url || c.image) : null;
          if (img && typeof img === 'string' && img.startsWith('http')) return img;
        }
      }
    } catch {}
  }

  // 2순위: <img> alt/class/id에 인물 키워드 포함
  const PERSON_KEYWORDS = /강사|튜터|멘토|instructor|teacher|mentor|tutor|profile|avatar|lecturer|faculty/i;
  const imgTags = html.match(/<img[^>]+>/gi) || [];
  for (const tag of imgTags) {
    if (!PERSON_KEYWORDS.test(tag)) continue;
    const srcMatch = tag.match(/src=["']([^"']+)["']/i);
    if (srcMatch && srcMatch[1].startsWith('http')) return srcMatch[1];
  }

  return null; // 없으면 null (OG image 폴백은 호출자가 처리)
}
```

- [ ] **Step 2: `fetchPageContent` 반환값에 `personImageUrl` 추가**

`fetchPageContent` 함수 내부 마지막 return 문을 수정한다 (현재 `return { text, themeColor, ogImageUrl };`):

```javascript
  const personImageUrl = extractPersonImageUrl(html) || null;
  return { text, themeColor, ogImageUrl, personImageUrl };
```

- [ ] **Step 3: `/api/generate-ad` 핸들러에서 personImageUrl 수신 + 응답 포함**

`server.js` line 162 `/api/generate-ad` 핸들러의 `req.body` 구조분해에 추가:

```javascript
    person_image_base64 = null,  // 프론트에서 업로드한 base64
    person_image_url = null,     // 프론트에서 입력한 CDN URL
    event_date = '',             // 세미나형 전용
    event_badge = '무료 LIVE',  // 세미나형 전용
```

그리고 크롤링 결과 수신 부분 (line 192 근처)을 수정:

```javascript
    const { text: pageContent, themeColor: pageThemeColor, ogImageUrl, personImageUrl: autoPersonImageUrl } = await fetchPageContent(url);
    console.log('[크롤링 완료] 텍스트', pageContent.length, 'chars | 테마:', pageThemeColor || '없음', '| OG:', ogImageUrl ? 'O' : 'X', '| 인물:', autoPersonImageUrl ? 'O' : 'X');
```

`assemblyAgent` 호출 부분을 수정 (line 227 근처):

```javascript
    // 인물 이미지 결정: 수동입력 > 자동감지
    const effectivePersonImageBase64 = person_image_base64 || null;
    const effectivePersonImageUrl = person_image_url || autoPersonImageUrl || null;

    const variations = assemblyAgent({
      adDataList,
      bgColor: effectiveBgColor,
      bgImageBase64: imageResult.bgImageBase64,
      bgCss: imageResult.bgCss,
      font,
      layoutTypes: effectiveLayouts,
      personImageBase64: effectivePersonImageBase64,
      personImageUrl: effectivePersonImageUrl,
      eventDate: event_date,
      eventBadge: event_badge,
    });
```

`res.json` 응답에 `detectedPersonImageUrl` 추가 (line 251 근처):

```javascript
    res.json({
      variations,
      extractedInfo,
      effectiveBgColor,
      colorSource,
      detectedPersonImageUrl: autoPersonImageUrl || null,
    });
```

- [ ] **Step 4: `/api/fetch-person-image` 엔드포인트 추가**

기존 `/api/fetch-image` 엔드포인트(line 289) 바로 아래에 추가:

```javascript
// ─── 인물 이미지 URL 프록시 (일반 CDN, 상세페이지 이미지) ───
app.post('/api/fetch-person-image', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다' });

  let hostname;
  try { hostname = new URL(url).hostname; } catch {
    return res.status(400).json({ error: '잘못된 URL입니다' });
  }

  // 사설 IP / localhost 차단 (SSRF 방지)
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(hostname)) {
    return res.status(403).json({ error: '허용되지 않는 주소입니다' });
  }

  try {
    const imgRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!imgRes.ok) throw new Error(`다운로드 실패: HTTP ${imgRes.status}`);

    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) throw new Error('이미지 파일이 아닙니다');

    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    res.json({ dataUrl: `data:${contentType};base64,${base64}` });
  } catch (err) {
    console.error('[인물이미지 프록시 오류]', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: 로컬 서버 실행 후 확인**

```bash
cd "C:\Users\SB_소수현\Documents\adcraft-hackathon"
npm start
```

브라우저에서 `http://localhost:3000` 접속 → 서버 에러 없음 확인

- [ ] **Step 6: 커밋**

```bash
git add server.js
git commit -m "feat: 인물이미지 자동추출 + /api/fetch-person-image 프록시"
```

---

## Task 2: Claude 카피 스키마 확장 (레이아웃별 추가 필드)

**Files:**
- Modify: `server.js` (`copyAgent`, `extractAdDataVariations` 함수)

- [ ] **Step 1: `copyAgent` 함수 시그니처에 `layoutTypes` 추가**

`copyAgent` 함수 (line ~415 근처) 파라미터에 추가:

```javascript
async function copyAgent({ pageContent, pageInfo, styleAnalysis, layoutTypes = ['photo-overlay'] }) {
  console.log('[✍️ 카피 에이전트] 시작 | 타겟:', pageInfo.target ? pageInfo.target.slice(0, 30) : '자동추출됨', '| 레이아웃:', layoutTypes.join(','));

  const adDataList = await extractAdDataVariations(pageContent, styleAnalysis, pageInfo, layoutTypes);
  ...
}
```

- [ ] **Step 2: `/api/generate-ad`에서 copyAgent 호출 시 layoutTypes 전달**

line ~219 근처:

```javascript
    const { adDataList } = await copyAgent({
      pageContent,
      pageInfo: resolvedPageInfo,
      styleAnalysis: imageResult.styleAnalysis,
      layoutTypes: effectiveLayouts,
    });
```

- [ ] **Step 3: `extractAdDataVariations` 함수 시그니처 + 레이아웃별 필드 프롬프트 추가**

`extractAdDataVariations` 함수 선언부를 찾아 `layoutTypes` 파라미터 추가:

```javascript
async function extractAdDataVariations(pageContent, styleAnalysis, pageInfo, layoutTypes = ['photo-overlay']) {
```

함수 내 `layoutSpec` 변수 정의 부분을 다음으로 교체한다 (현재 `const layoutSpec = \`...` 시작 부분):

```javascript
  // 레이아웃별 추가 필드 스펙
  const needsInstructor = layoutTypes.some(t => ['instructor', 'seminar', 'review'].includes(t));
  const needsCurriculum = layoutTypes.includes('curriculum');
  const needsSns       = layoutTypes.includes('sns-post');
  const needsComparison= layoutTypes.includes('comparison');
  const needsReview    = layoutTypes.includes('review');

  const extraFields = [];
  if (needsInstructor) {
    extraFields.push(`- instructor_name: 강사/발표자 이름 (페이지에서 추출, 없으면 "강사명" 플레이스홀더)
- instructor_title: 현재 직함 (예: "현) OO대학교 교수")
- instructor_career: 이전 경력 (예: "전) 삼성전자 수석연구원")
- instructor_bullet1: 핵심 이력 1 (20자 이내)
- instructor_bullet2: 핵심 이력 2 (20자 이내)
- instructor_bullet3: 핵심 이력 3 (20자 이내)`);
  }
  if (layoutTypes.includes('instructor')) {
    extraFields.push(`- usp_module1: USP 카드 1 설명 (15자 이내)
- usp_module2: USP 카드 2 설명 (15자 이내)
- usp_module3: USP 카드 3 설명 (15자 이내)
- usp_module4: USP 카드 4 설명 (15자 이내, 마지막 카드)`);
  }
  if (layoutTypes.includes('seminar')) {
    extraFields.push(`- instructor_subtitle: 강사 소개 한 줄 (예: "부린이 공부방의 레나쌤")`);
  }
  if (needsReview) {
    extraFields.push(`- review_body1: 수강생 후기 1 (40자 이내, 핵심 키워드는 **굵게** 마크)
- review_body2: 수강생 후기 2 (40자 이내, 핵심 키워드는 **굵게** 마크)
- review_body3: 수강생 후기 3 (40자 이내, 핵심 키워드는 **굵게** 마크)`);
  }
  if (needsCurriculum) {
    extraFields.push(`- curriculum_step1: 커리큘럼 1단계 명칭 (10자 이내)
- curriculum_step2: 커리큘럼 2단계 명칭 (10자 이내)
- curriculum_step3: 커리큘럼 3단계 명칭 (10자 이내)
- curriculum_step4: 커리큘럼 4단계 명칭 (10자 이내)
- curriculum_step5: 커리큘럼 5단계 명칭 (10자 이내)
- curriculum_badge: 배지 텍스트 (예: "국내 유일 Full-로드맵", 15자 이내)`);
  }
  if (needsSns) {
    extraFields.push(`- post_username: 가상 커뮤니티 닉네임 (실제 닉네임 스타일, 예: "데이터_공부중")
- post_body: 커뮤니티 게시글 본문 (100자 이내, 개인 경험담 어투, 줄바꿈은 \\n 사용)`);
  }
  if (needsComparison) {
    extraFields.push(`- comparison_a_label: 비교 A행 라벨 (예: "수강 전", "기존 방식", 6자 이내)
- comparison_b_label: 비교 B행 라벨 (예: "수강 후", "우리 과정", 6자 이내)
- comparison_items: 비교 항목 배열 (최대 5개) 예시:
  [{"stage":"입문","a_state":"혼자 독학","b_state":"전문가 멘토링"},...]`);
  }

  const extraFieldsText = extraFields.length > 0 ? `\n\n## 레이아웃 추가 필드 (선택된 레이아웃: ${layoutTypes.join(', ')})\n${extraFields.join('\n')}` : '';

  const layoutSpec = `
## 카피 — 1종
...기존 layoutSpec 내용 유지...
${extraFieldsText}`;
```

> **주의:** 위 코드에서 `...기존 layoutSpec 내용 유지...` 부분은 실제 파일의 기존 `layoutSpec` 내용을 그대로 유지하고, 마지막에 `${extraFieldsText}`만 추가한다. 기존 JSON 스키마 예시 뒤에 `${extraFieldsText}`를 붙인다.

구체적으로: 기존 JSON 예시 한 줄:
```
{"variation_label":"광고 소재","brand":"","hook":"","headline_line1":"","headline_line2":"","cta_badge":"","cta_text":"","visual_stat1_value":"","visual_stat1_label":"","footnote":null,"validation":{...},"validation_score":15,"validation_fails":[]}
```
을 아래로 교체:
```javascript
`[
  {"variation_label":"광고 소재","brand":"","hook":"","headline_line1":"","headline_line2":"","cta_badge":"","cta_text":"","visual_stat1_value":"","visual_stat1_label":"","footnote":null${needsInstructor ? ',"instructor_name":"","instructor_title":"","instructor_career":"","instructor_bullet1":"","instructor_bullet2":"","instructor_bullet3":""' : ''}${layoutTypes.includes('instructor') ? ',"usp_module1":"","usp_module2":"","usp_module3":"","usp_module4":""' : ''}${layoutTypes.includes('seminar') ? ',"instructor_subtitle":""' : ''}${needsReview ? ',"review_body1":"","review_body2":"","review_body3":""' : ''}${needsCurriculum ? ',"curriculum_step1":"","curriculum_step2":"","curriculum_step3":"","curriculum_step4":"","curriculum_step5":"","curriculum_badge":""' : ''}${needsSns ? ',"post_username":"","post_body":""' : ''}${needsComparison ? ',"comparison_a_label":"","comparison_b_label":"","comparison_items":[]' : ''},"validation":{"C1":true,"C2":true,"C3":true,"C4":true,"C5":true,"C6":true,"V1":true,"V2":true,"V3":true,"V4":true,"V5":true,"V6":true,"V7":true,"S1":true,"P1":true},"validation_score":15,"validation_fails":[]}
]`
```

- [ ] **Step 4: 로컬 서버 재시작 후 기존 기능 정상 확인**

```bash
# 서버 재시작 후 curl 테스트
curl -s -X POST http://localhost:3000/api/generate-ad \
  -H "Content-Type: application/json" \
  -d '{"url":"https://fastcampus.co.kr","layout_types":["photo-overlay"]}' \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const r=JSON.parse(d);console.log('variations:',r.variations?.length,'extractedInfo:',!!r.extractedInfo)"
```

Expected: `variations: 1 extractedInfo: true`

- [ ] **Step 5: 커밋**

```bash
git add server.js
git commit -m "feat: 레이아웃별 Claude 카피 추가 필드 — instructor/seminar/review/curriculum/sns/comparison"
```

---

## Task 3: HTML 생성 유틸리티 — CSS 변수 + 색상 헬퍼

**Files:**
- Modify: `server.js` (getAdFontCSS 함수 아래에 추가)

- [ ] **Step 1: `buildCssVars` 헬퍼 함수 추가**

`getAdFontCSS` 함수 (line 812) 바로 아래에 삽입:

```javascript
// ─── 광고 CSS 변수 빌더 ───
// colors: { accentColor, headlineColor, subColor, ctaColor, ctaTextColor }
function buildCssVars(bgColor = '#1B5BD4', colors = {}) {
  const accent     = colors.accentColor   || bgColor;
  const headline   = colors.headlineColor || '#ffffff';
  const sub        = colors.subColor      || 'rgba(255,255,255,0.82)';
  const ctaBg      = colors.ctaColor      || accent;
  const ctaText    = colors.ctaTextColor  || '#ffffff';
  return `--accent:${accent};--headline-clr:${headline};--sub-clr:${sub};--cta-bg:${ctaBg};--cta-text:${ctaText};`;
}

// ─── 밝기 판별 (SNS 다크/라이트 자동 결정) ───
function isColorDark(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return (0.299*r + 0.587*g + 0.114*b) < 128;
}

// ─── 후기 본문 **굵게** 마크 → <strong> 변환 ───
function boldMark(str = '') {
  return str.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--accent)">$1</strong>');
}
```

- [ ] **Step 2: 커밋**

```bash
git add server.js
git commit -m "feat: buildCssVars, isColorDark, boldMark 유틸 함수 추가"
```

---

## Task 4: HTML 생성 함수 7종

**Files:**
- Modify: `server.js` (generateAdHTML dispatcher 아래, line ~869에 추가)

- [ ] **Step 1: `generateInstructorHTML` — 강사강조형**

`generateAdHTML` 함수 (line 856) 바로 아래에 삽입:

```javascript
// ─── 강사강조형 ───
function generateInstructorHTML(d, bgColor = '#f5a623', personImg = null, font = 'Pretendard', colors = {}) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
  const accent = colors.accentColor || bgColor;

  const uspCards = [1,2,3,4].map(i => {
    const mod = d[`usp_module${i}`] || `모듈 ${i}`;
    const isLast = i === 4;
    return `<div style="flex:1;background:#fff;border-radius:14px;border:1.5px solid #eee;padding:14px 10px;display:flex;flex-direction:column;align-items:center;gap:8px;position:relative;min-width:0">
      ${isLast && d.cta_badge ? `<div style="position:absolute;top:-10px;right:-4px;background:${accent};color:#fff;font-size:11px;font-weight:800;padding:3px 8px;border-radius:20px;white-space:nowrap">${d.cta_badge}</div>` : ''}
      <div style="width:24px;height:24px;border-radius:50%;background:${accent};color:#fff;font-size:13px;font-weight:900;display:flex;align-items:center;justify-content:center">${i}</div>
      <div style="width:100%;aspect-ratio:16/9;background:#f0f0f0;border-radius:8px"></div>
      <div style="font-size:13px;font-weight:600;color:#222;text-align:center;line-height:1.4">${mod}</div>
    </div>`;
  }).join('');

  const personSection = personImg
    ? `<div style="width:88px;height:88px;border-radius:50%;overflow:hidden;border:3px solid ${accent};flex-shrink:0"><img src="${personImg}" style="width:100%;height:100%;object-fit:cover"></div>`
    : `<div style="width:88px;height:88px;border-radius:50%;background:#e0e0e0;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:32px">👤</div>`;

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily};--accent:${accent}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative;background:#fafafa;background-image:radial-gradient(circle,#ddd 1px,transparent 1px);background-size:28px 28px">

  <!-- 상단 훅 + 헤드라인 -->
  <div style="padding:52px 52px 0">
    <div style="font-size:26px;font-weight:600;color:#555;margin-bottom:12px">${nl2br(d.hook || '')}</div>
    <div style="font-size:64px;font-weight:900;color:#111;line-height:1.1;letter-spacing:-2px">${d.headline_line1 || ''}</div>
    <div style="font-size:64px;font-weight:900;color:var(--accent);line-height:1.1;letter-spacing:-2px">${d.headline_line2 || ''}</div>
  </div>

  <!-- USP 카드 4개 -->
  <div style="padding:28px 52px 0;display:flex;gap:12px">
    ${uspCards}
  </div>

  <!-- 강사 섹션 -->
  <div style="position:absolute;bottom:110px;left:52px;right:52px;display:flex;align-items:center;gap:24px">
    ${personSection}
    <div style="flex:1">
      <div style="font-size:26px;font-weight:900;color:#111;margin-bottom:4px">${d.instructor_name || '[강사명]'}</div>
      <div style="font-size:16px;color:#444;margin-bottom:2px">${d.instructor_title || '현) -'}</div>
      <div style="font-size:15px;color:#666;margin-bottom:10px">${d.instructor_career || '전) -'}</div>
      <div style="display:flex;flex-direction:column;gap:3px">
        ${[1,2,3].map(i => d[`instructor_bullet${i}`] ? `<div style="font-size:14px;color:#444">• ${d[`instructor_bullet${i}`]}</div>` : '').join('')}
      </div>
    </div>
  </div>

  <!-- CTA 바 -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:var(--cta-bg);border-radius:0;display:flex;align-items:center;justify-content:center">
    <div style="font-size:26px;font-weight:800;color:var(--cta-text)">${d.cta_text || '지금 바로 신청하기 →'}</div>
  </div>

</div></body></html>`;
}
```

- [ ] **Step 2: `generateSeminarHTML` — 세미나형**

```javascript
// ─── 세미나형 (인물강조) ───
function generateSeminarHTML(d, bgColor = '#7c3aed', personImg = null, font = 'Pretendard', colors = {}, eventDate = '', eventBadge = '무료 LIVE') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
  const accent = colors.accentColor || '#ffffff';

  // bgColor 기반 그라디언트 (항상 어두운 방향)
  const grad = `linear-gradient(160deg, ${bgColor} 0%, ${bgColor}cc 40%, #1a0533 100%)`;

  const personBlock = personImg
    ? `<div style="position:absolute;bottom:120px;left:50%;transform:translateX(-50%);text-align:center">
        <div style="width:280px;height:280px;border-radius:50%;background:rgba(255,255,255,0.15);overflow:hidden;margin:0 auto">
          <img src="${personImg}" style="width:100%;height:100%;object-fit:cover;object-position:top">
        </div>
        <div style="margin-top:12px;font-size:22px;font-weight:800;color:#fff">${d.instructor_name || ''}</div>
        <div style="font-size:16px;color:rgba(255,255,255,0.7)">${d.instructor_subtitle || ''}</div>
      </div>`
    : `<div style="position:absolute;bottom:120px;left:50%;transform:translateX(-50%);text-align:center">
        <div style="width:200px;height:200px;border-radius:50%;background:rgba(255,255,255,0.15);margin:0 auto;display:flex;align-items:center;justify-content:center;font-size:72px">👤</div>
        <div style="margin-top:12px;font-size:22px;font-weight:800;color:#fff">${d.instructor_name || '[강사명]'}</div>
      </div>`;

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative;background:${grad}">

  <!-- 상단: 이벤트 뱃지 + 날짜 -->
  <div style="padding:52px 52px 0;display:flex;align-items:center;gap:18px">
    <div style="background:#e11d48;color:#fff;font-size:20px;font-weight:900;padding:8px 20px;border-radius:6px">${eventBadge}</div>
    ${eventDate ? `<div style="color:rgba(255,255,255,0.85);font-size:22px;font-weight:600">${eventDate}</div>` : ''}
  </div>

  <!-- 헤드라인 -->
  <div style="padding:32px 52px 0">
    <div style="font-size:66px;font-weight:900;color:#fff;line-height:1.1;letter-spacing:-2px">${d.headline_line1 || ''}</div>
    <div style="font-size:66px;font-weight:900;color:#fff;line-height:1.1;letter-spacing:-2px">${d.headline_line2 || ''}</div>
    <div style="margin-top:16px;font-size:24px;color:rgba(255,255,255,0.72)">${d.hook || ''}</div>
  </div>

  <!-- 인물 사진 + 이름 -->
  ${personBlock}

  <!-- CTA 바 -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:var(--cta-bg);display:flex;align-items:center;justify-content:center">
    <div style="font-size:26px;font-weight:800;color:var(--cta-text)">${d.cta_text || '무료로 신청하기 →'}</div>
  </div>

</div></body></html>`;
}
```

- [ ] **Step 3: `generateSnsPostHTML` — SNS UI형**

```javascript
// ─── SNS UI형 ───
function generateSnsPostHTML(d, bgColor = '#1877f2', font = 'Pretendard', colors = {}) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
  const dark = isColorDark(bgColor);
  const panelBg = dark ? '#1c1c1e' : '#f5f5f7';
  const textMain = dark ? '#ffffff' : '#1c1e21';
  const textSub  = dark ? '#8e8e93' : '#65676b';
  const cardBg   = dark ? '#2c2c2e' : '#ffffff';

  const postBody = (d.post_body || d.hook || '').replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
  const username = d.post_username || '익명의수강생';

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative;background:${panelBg}">

  <!-- 플랫폼 상단 nav 바 -->
  <div style="background:${bgColor};height:70px;display:flex;align-items:center;padding:0 36px;gap:32px">
    <span style="color:#fff;font-size:18px;font-weight:700">Q&A</span>
    <span style="color:rgba(255,255,255,.65);font-size:18px">지식</span>
    <span style="color:rgba(255,255,255,.65);font-size:18px">커뮤니티</span>
    <span style="color:rgba(255,255,255,.65);font-size:18px">이벤트</span>
    <span style="color:rgba(255,255,255,.65);font-size:18px">JOBS</span>
    <div style="margin-left:auto;border:1.5px solid #fff;color:#fff;font-size:16px;font-weight:700;padding:8px 20px;border-radius:20px">질문하기</div>
  </div>

  <!-- 포스트 카드 -->
  <div style="background:${cardBg};margin:32px 52px;border-radius:18px;padding:40px;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
    <!-- 프로필 행 -->
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:28px">
      <div style="width:60px;height:60px;border-radius:50%;background:${bgColor};display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;font-weight:900">${username[0]}</div>
      <div>
        <div style="font-size:20px;font-weight:700;color:${textMain}">${username}</div>
        <div style="font-size:16px;color:${textSub}">❤ 2.5k &nbsp;·&nbsp; 1개월 전</div>
      </div>
    </div>

    <!-- 제목 -->
    <div style="font-size:30px;font-weight:800;color:${textMain};margin-bottom:20px;line-height:1.3">${d.headline_line1 || ''}${d.headline_line2 ? ' ' + d.headline_line2 : ''}</div>

    <!-- 본문 -->
    <div style="font-size:22px;color:${textSub};line-height:1.75">${postBody}</div>
  </div>

  <!-- CTA 버튼 -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:var(--cta-bg);display:flex;align-items:center;justify-content:center">
    <div style="font-size:26px;font-weight:800;color:var(--cta-text)">${d.cta_text || '자세히 알아보기 →'}</div>
  </div>

</div></body></html>`;
}
```

- [ ] **Step 4: `generateComparisonHTML` — 비교형**

```javascript
// ─── 비교형 (그래프형) ───
function generateComparisonHTML(d, bgColor = '#111111', bgImageBase64 = null, bgCss = null, font = 'Pretendard', colors = {}) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
  const accent = colors.accentColor || bgColor;

  const bgStyle = bgImageBase64
    ? `background:url('${bgImageBase64}') center/cover no-repeat; position:relative`
    : bgCss ? bgCss : `background:${bgColor}`;

  const items = Array.isArray(d.comparison_items) ? d.comparison_items.slice(0, 5) : [];
  const colCount = Math.max(items.length, 3);
  const colW = Math.floor(900 / colCount);

  const headerRow = items.map(it =>
    `<div style="width:${colW}px;text-align:center;font-size:16px;font-weight:700;color:#666;padding:10px 4px">${it.stage || ''}</div>`
  ).join('');

  const aRow = items.map(it =>
    `<div style="width:${colW}px;text-align:center;padding:10px 4px">
      <div style="display:inline-block;background:#f0f0f0;border-radius:20px;padding:6px 14px;font-size:14px;color:#666">${it.a_state || '–'}</div>
    </div>`
  ).join('');

  const bRow = items.map(it =>
    `<div style="width:${colW}px;text-align:center;padding:10px 4px">
      <div style="display:inline-block;background:${accent};border-radius:20px;padding:6px 14px;font-size:14px;color:#fff;font-weight:700">${it.b_state || '✓'}</div>
    </div>`
  ).join('');

  const aLabel = d.comparison_a_label || '기존 방식';
  const bLabel = d.comparison_b_label || '수강 후';

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative">

  <!-- 상단 다크 영역 (45%) -->
  <div style="height:486px;${bgStyle};display:flex;flex-direction:column;justify-content:flex-end;padding:0 52px 40px">
    ${bgImageBase64 ? '<div style="position:absolute;inset:0;background:rgba(0,0,0,0.6)"></div>' : ''}
    <div style="position:relative;z-index:1">
      <div style="font-size:28px;color:rgba(255,255,255,0.7);margin-bottom:10px">${d.hook || ''}</div>
      <div style="font-size:62px;font-weight:900;color:#fff;line-height:1.1;letter-spacing:-2px">${d.headline_line1 || ''}</div>
      <div style="font-size:62px;font-weight:900;color:var(--accent);line-height:1.1;letter-spacing:-2px">${d.headline_line2 || ''}</div>
    </div>
  </div>

  <!-- 물결 분리선 -->
  <svg viewBox="0 0 1080 48" style="display:block;margin-top:-1px" preserveAspectRatio="none" height="48" width="1080">
    <path d="M0,0 Q270,48 540,24 Q810,0 1080,32 L1080,48 L0,48 Z" fill="#fff"/>
  </svg>

  <!-- 하단 흰 영역 — 비교표 -->
  <div style="background:#fff;padding:20px 52px 0">
    <!-- 헤더 행 -->
    <div style="display:flex;margin-left:120px">
      ${headerRow || '<div style="color:#999;font-size:16px">비교 항목을 입력하세요</div>'}
    </div>

    <!-- A행 -->
    <div style="display:flex;align-items:center;margin-bottom:8px">
      <div style="width:120px;font-size:18px;font-weight:700;color:#888">${aLabel}</div>
      ${aRow}
    </div>

    <!-- B행 -->
    <div style="display:flex;align-items:center">
      <div style="width:120px;font-size:18px;font-weight:800;color:${accent}">${bLabel}</div>
      ${bRow}
    </div>

    <!-- 결론 카피 -->
    <div style="margin-top:32px">
      <div style="font-size:34px;font-weight:800;color:#111;line-height:1.4">${d.headline_line1 || ''} <span style="color:var(--accent)">${d.visual_stat1_value || ''}</span></div>
      <div style="font-size:34px;font-weight:800;color:#111">${d.headline_line2 || ''} <span style="color:var(--accent)">${d.visual_stat1_label || ''}</span></div>
    </div>
  </div>

  <!-- CTA 바 -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:var(--cta-bg);display:flex;align-items:center;justify-content:center">
    <div style="font-size:26px;font-weight:800;color:var(--cta-text)">${d.cta_text || '지금 바로 시작하기 →'}</div>
  </div>

</div></body></html>`;
}
```

- [ ] **Step 5: `generateImageHeroHTML` — 이미지강조형**

```javascript
// ─── 이미지강조형 (풀블리드) ───
function generateImageHeroHTML(d, bgColor = '#111', bgImageBase64 = null, bgCss = null, font = 'Pretendard', colors = {}) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);

  const bg = bgImageBase64
    ? `url('${bgImageBase64}') center/cover no-repeat`
    : bgCss || bgColor;

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative;background:${bg}">

  <!-- 다크 오버레이 그라디언트 -->
  <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0.08) 0%,rgba(0,0,0,0.25) 40%,rgba(0,0,0,0.72) 75%,rgba(0,0,0,0.9) 100%)"></div>

  <!-- 상단 우측 뱃지 -->
  ${d.cta_badge ? `<div style="position:absolute;top:40px;right:40px;z-index:10;background:var(--cta-bg);color:var(--cta-text);font-size:18px;font-weight:800;padding:10px 22px;border-radius:28px">${d.cta_badge}</div>` : ''}

  <!-- 중하단 헤드라인 -->
  <div style="position:absolute;bottom:130px;left:52px;right:52px;z-index:10">
    <div style="font-size:24px;color:rgba(255,255,255,0.8);margin-bottom:12px">${d.hook || ''}</div>
    <div style="font-size:80px;font-weight:900;color:var(--headline-clr);line-height:1.05;letter-spacing:-3px;text-shadow:0 4px 24px rgba(0,0,0,0.5)">${d.headline_line1 || ''}</div>
    <div style="font-size:80px;font-weight:900;color:var(--accent);line-height:1.05;letter-spacing:-3px;text-shadow:0 4px 24px rgba(0,0,0,0.5)">${d.headline_line2 || ''}</div>
  </div>

  <!-- CTA 바 -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:var(--cta-bg);display:flex;align-items:center;justify-content:center;z-index:10">
    <div style="font-size:26px;font-weight:800;color:var(--cta-text)">${d.cta_text || '지금 시작하기 →'}</div>
  </div>

</div></body></html>`;
}
```

- [ ] **Step 6: `generateCurriculumHTML` — 커리큘럼강조형**

```javascript
// ─── 커리큘럼강조형 ───
function generateCurriculumHTML(d, bgColor = '#0a0e1a', font = 'Pretendard', colors = {}) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
  const accent = colors.accentColor || '#4a9eff';

  const steps = [1,2,3,4,5].map(i => d[`curriculum_step${i}`] || `단계 ${i}`);
  const stepW = 160;
  const stepStart = 52;

  const stepDots = steps.map((s, i) => {
    const x = stepStart + i * (stepW + 28);
    return `
      <div style="position:absolute;left:${x}px;top:0;width:${stepW}px;text-align:center">
        <div style="width:18px;height:18px;border-radius:50%;background:${accent};margin:0 auto 8px"></div>
        <div style="font-size:15px;font-weight:600;color:#fff;line-height:1.3">${s}</div>
      </div>`;
  }).join('');

  // 연결선
  const lineW = (steps.length - 1) * (stepW + 28) + stepW;

  // 썸네일 그리드 (5×4 = 20개)
  const thumbs = Array(20).fill(0).map(() =>
    `<div style="width:168px;height:96px;background:rgba(255,255,255,0.08);border-radius:8px;border:1px solid rgba(255,255,255,0.1)"></div>`
  ).join('');

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative;background:${bgColor}">

  <!-- 배경 광 효과 -->
  <div style="position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:800px;height:600px;background:radial-gradient(ellipse,${accent}22 0%,transparent 70%);pointer-events:none"></div>

  <!-- 헤드라인 -->
  <div style="padding:52px 52px 0">
    <div style="font-size:60px;font-weight:900;color:#fff;line-height:1.1;letter-spacing:-2px">${d.headline_line1 || ''}</div>
    <div style="font-size:60px;font-weight:900;color:var(--accent);line-height:1.1;letter-spacing:-2px">${d.headline_line2 || ''}</div>
  </div>

  <!-- 수평 로드맵 -->
  <div style="margin:36px 52px 0;position:relative;height:80px">
    <!-- 연결선 -->
    <div style="position:absolute;top:8px;left:${stepStart + stepW/2}px;width:${lineW - stepW}px;height:2px;background:${accent}55"></div>
    ${stepDots}
  </div>

  <!-- 썸네일 그리드 -->
  <div style="margin:32px 52px 0;display:flex;flex-wrap:wrap;gap:10px">
    ${thumbs}
  </div>

  <!-- 배지 + 서브카피 -->
  <div style="position:absolute;bottom:120px;left:52px;right:52px;display:flex;align-items:center;gap:24px">
    ${d.curriculum_badge ? `<div style="background:${accent};color:#000;font-size:14px;font-weight:900;padding:12px 16px;border-radius:50%;width:100px;height:100px;display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.3;flex-shrink:0">${d.curriculum_badge}</div>` : ''}
    <div style="font-size:22px;color:rgba(255,255,255,0.75);line-height:1.6">${d.hook || ''}</div>
  </div>

  <!-- CTA 바 -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:var(--cta-bg);display:flex;align-items:center;justify-content:center">
    <div style="font-size:24px;font-weight:800;color:var(--cta-text)">${d.cta_text || '전체 커리큘럼 보기 →'}</div>
  </div>

</div></body></html>`;
}
```

- [ ] **Step 7: `generateReviewHTML` — 후기사례형**

```javascript
// ─── 후기사례형 ───
function generateReviewHTML(d, bgColor = '#111111', personImg = null, font = 'Pretendard', colors = {}) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
  const accent = colors.accentColor || bgColor;

  const reviewCards = [1,2,3].map(i => {
    const body = d[`review_body${i}`];
    if (!body) return '';
    return `<div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:22px 24px">
      <div style="color:#fbbf24;font-size:18px;margin-bottom:10px">★★★★★</div>
      <div style="font-size:18px;color:rgba(255,255,255,0.88);line-height:1.6">${boldMark(body)}</div>
    </div>`;
  }).join('');

  const personBlock = personImg
    ? `<div style="position:absolute;right:52px;top:90px;width:340px;height:460px;overflow:hidden;border-radius:20px"><img src="${personImg}" style="width:100%;height:100%;object-fit:cover;object-position:top"></div>`
    : '';

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative;background:${bgColor}">

  <!-- 배경 그라디언트 -->
  <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 30% 0%,${accent}33 0%,transparent 60%)"></div>

  <!-- 인물 사진 -->
  ${personBlock}

  <!-- 왼쪽 콘텐츠 영역 -->
  <div style="position:absolute;top:52px;left:52px;right:${personImg ? '420px' : '52px'}">
    <div style="font-size:22px;color:rgba(255,255,255,0.65);margin-bottom:12px">${d.hook || ''}</div>
    <div style="font-size:56px;font-weight:900;color:#fff;line-height:1.1;letter-spacing:-2px;margin-bottom:4px">${d.headline_line1 || ''}</div>
    <div style="font-size:56px;font-weight:900;color:var(--accent);line-height:1.1;letter-spacing:-2px">${d.headline_line2 || ''}</div>
  </div>

  <!-- 후기 카드 3개 -->
  <div style="position:absolute;bottom:120px;left:52px;right:${personImg ? '420px' : '52px'};display:flex;flex-direction:column;gap:12px">
    ${reviewCards || '<div style="color:rgba(255,255,255,0.4);font-size:16px">후기 데이터를 입력해주세요</div>'}
  </div>

  <!-- CTA 버튼 -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:var(--cta-bg);display:flex;align-items:center;justify-content:center">
    <div style="font-size:26px;font-weight:800;color:var(--cta-text)">${d.cta_text || '수강 후기 더 보기 →'}</div>
  </div>

</div></body></html>`;
}
```

- [ ] **Step 8: `generateAdHTML` dispatcher에 신규 레이아웃 추가**

`generateAdHTML` 함수 (line 856) 내 기존 dispatcher 마지막 폴백 위에 추가:

```javascript
function generateAdHTML(d, bgColor = '#1B5BD4', bgImageBase64 = null, cssBackground = null, font = 'Pretendard', ctaColor = null, personImg = null, colors = {}, eventDate = '', eventBadge = '무료 LIVE') {
  const effectiveColors = ctaColor ? { ...colors, ctaColor } : colors;
  // 신규 7종
  if (d.layout_type === 'instructor')  return generateInstructorHTML(d, bgColor, personImg, font, effectiveColors);
  if (d.layout_type === 'seminar')     return generateSeminarHTML(d, bgColor, personImg, font, effectiveColors, eventDate, eventBadge);
  if (d.layout_type === 'sns-post')    return generateSnsPostHTML(d, bgColor, font, effectiveColors);
  if (d.layout_type === 'comparison')  return generateComparisonHTML(d, bgColor, bgImageBase64, cssBackground, font, effectiveColors);
  if (d.layout_type === 'image-hero')  return generateImageHeroHTML(d, bgColor, bgImageBase64, cssBackground, font, effectiveColors);
  if (d.layout_type === 'curriculum')  return generateCurriculumHTML(d, bgColor, font, effectiveColors);
  if (d.layout_type === 'review')      return generateReviewHTML(d, bgColor, personImg, font, effectiveColors);
  // 기존 포토오버레이 3종
  if (d.layout_type === '포토오버레이-시네마틱형') return generatePhotoOverlayHTML(d, bgColor, bgImageBase64, cssBackground, font, ctaColor);
  if (d.layout_type === '포토오버레이-센터패널형') return generatePhotoCenterPanelHTML(d, bgColor, bgImageBase64, cssBackground, font, ctaColor);
  if (d.layout_type === '포토오버레이-사이드형')   return generatePhotoSideHTML(d, bgColor, bgImageBase64, cssBackground, font, ctaColor);
  if (d.layout_type === '포토오버레이형') return generatePhotoOverlayHTML(d, bgColor, bgImageBase64, cssBackground, font, ctaColor);
  if (d.layout_type === '헤드라인밴드형') return generateHeadlineBandHTML(d, bgColor, font);
  if (d.layout_type === '다크스플릿형')   return generateDarkSplitHTML(d, bgColor, font);
  if (d.layout_type === '이미지모자이크형') return generateImageMosaicHTML(d, bgColor, bgImageBase64, cssBackground, font);
  if (d.layout_type === '헤드카피형')    return generateHeadlineCopyHTML(d, bgColor, font);
  if (d.layout_type === '커뮤니티형')    return generateCommunityHTML(d, bgColor, font);
  return generatePhotoOverlayHTML(d, bgColor, bgImageBase64, cssBackground, font, ctaColor);
}
```

- [ ] **Step 9: `assemblyAgent` 확장**

`assemblyAgent` 함수 (line 432) 전체를 교체:

```javascript
function assemblyAgent({ adDataList, bgColor, bgImageBase64, bgCss, font = 'Pretendard', layoutTypes = ['photo-overlay'], personImageBase64 = null, personImageUrl = null, eventDate = '', eventBadge = '무료 LIVE', colors = {} }) {
  console.log('[🔧 조합 에이전트] 시작 | 레이아웃:', layoutTypes.join(', '), '| 카피:', adDataList.length, '종 | 인물이미지:', personImageBase64 ? '업로드' : personImageUrl ? 'URL' : 'X');

  const variations = [];
  const layoutLabels = {
    'photo-overlay': '[기본형]', 'twitter': '[커뮤니티]',
    'instructor': '[강사강조]', 'seminar': '[세미나]',
    'sns-post': '[SNS]', 'comparison': '[비교]',
    'image-hero': '[이미지]', 'curriculum': '[커리큘럼]', 'review': '[후기]',
  };

  // 인물 이미지: base64 우선, URL 폴백
  const personImg = personImageBase64 || personImageUrl || null;

  for (const layoutType of layoutTypes) {
    for (const adData of adDataList) {
      const prefix = layoutLabels[layoutType] || `[${layoutType}]`;
      const labeledData = { ...adData, variation_label: `${prefix} ${adData.variation_label || ''}`.trim(), layout_type: layoutType };
      let html;
      if (layoutType === 'photo-overlay') {
        html = generateFigmaPhotoHTML(labeledData, bgColor, bgImageBase64, bgCss, font);
      } else if (layoutType === 'twitter') {
        html = generateFigmaTwitterHTML(labeledData, bgColor, font);
      } else {
        html = generateAdHTML(labeledData, bgColor, bgImageBase64, bgCss, font, colors.ctaColor || null, personImg, colors, eventDate, eventBadge);
      }
      variations.push({ adData: labeledData, html });
    }
  }

  console.log('[🔧 조합 에이전트] 완료 | HTML 소재', variations.length, '종 생성');
  return variations;
}
```

- [ ] **Step 10: `/api/regenerate-with-bg` 엔드포인트에 colors 파라미터 추가**

line ~2020 근처:

```javascript
app.post('/api/regenerate-with-bg', (req, res) => {
  const { adData, bgColor, bgImageBase64, cssBackground, font, ctaColor, personImg, colors, eventDate, eventBadge } = req.body;
  if (!adData) return res.status(400).json({ error: 'adData 필요' });
  try {
    const html = generateAdHTML(adData, bgColor || '#1B5BD4', bgImageBase64 || null, cssBackground || null, font || 'Pretendard', ctaColor || null, personImg || null, colors || {}, eventDate || '', eventBadge || '무료 LIVE');
    res.json({ html });
  } catch (err) {
    console.error('[HTML 재생성 실패]', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 11: 로컬 서버 재시작 후 7종 레이아웃 테스트**

```bash
# instructor 레이아웃 테스트
curl -s -X POST http://localhost:3000/api/generate-ad \
  -H "Content-Type: application/json" \
  -d '{"url":"https://fastcampus.co.kr","layout_types":["instructor"],"target":"30대 직장인"}' \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const r=JSON.parse(d);const h=r.variations?.[0]?.html||'';console.log('HTML 길이:',h.length,'instructor함수:',h.includes('instructor_name')||h.includes('강사'))"
```

Expected: `HTML 길이: (숫자) instructor함수: true`

- [ ] **Step 12: 커밋**

```bash
git add server.js
git commit -m "feat: 레이아웃 HTML 생성 함수 7종 추가 — instructor/seminar/sns-post/comparison/image-hero/curriculum/review"
```

---

## Task 5: 프론트엔드 — 레이아웃 카드 7종 추가 + 인물이미지 UI + 세미나 입력

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 레이아웃 카드 7종을 `#layoutCardGrid`에 추가**

`public/index.html`에서 `<!-- 커뮤니티형 카드 -->` 블록 닫는 태그 `</div>` 바로 다음, `</div>` (layoutCardGrid 닫기) 전에 삽입:

```html
        <!-- 강사강조형 카드 -->
        <div class="layout-select-card" data-layout="instructor" onclick="toggleLayout('instructor',this)">
          <div class="layout-card-thumb">
            <svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
              <rect width="108" height="108" fill="#fafafa"/>
              <rect x="0" y="0" width="108" height="108" fill="url(#gGrid)" opacity="0.3"/>
              <defs><pattern id="gGrid" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M8 0L0 0 0 8" fill="none" stroke="#ddd" stroke-width="0.5"/></pattern></defs>
              <!-- 헤드라인 -->
              <rect x="8" y="10" width="70" height="7" rx="2" fill="#111"/>
              <rect x="8" y="20" width="55" height="7" rx="2" fill="#f5a623"/>
              <!-- USP 카드 4개 -->
              <rect x="4" y="36" width="22" height="26" rx="3" fill="#fff" stroke="#ddd" stroke-width="0.5"/>
              <rect x="29" y="36" width="22" height="26" rx="3" fill="#fff" stroke="#ddd" stroke-width="0.5"/>
              <rect x="54" y="36" width="22" height="26" rx="3" fill="#fff" stroke="#ddd" stroke-width="0.5"/>
              <rect x="79" y="36" width="22" height="26" rx="3" fill="#fff" stroke="#ddd" stroke-width="0.5"/>
              <!-- 강사 원형 -->
              <circle cx="18" cy="80" r="10" fill="#e0e0e0"/>
              <rect x="34" y="74" width="40" height="4" rx="2" fill="#111"/>
              <rect x="34" y="81" width="28" height="3" rx="1.5" fill="#888"/>
              <!-- CTA -->
              <rect x="0" y="96" width="108" height="12" rx="0" fill="#f5a623"/>
            </svg>
          </div>
          <div class="layout-card-info">
            <div class="layout-card-name">강사강조형</div>
            <div class="layout-card-desc">인물강조 · USP 카드</div>
          </div>
          <div class="layout-card-check">✓</div>
        </div>

        <!-- 세미나형 카드 -->
        <div class="layout-select-card" data-layout="seminar" onclick="toggleLayout('seminar',this)">
          <div class="layout-card-thumb">
            <svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
              <defs><linearGradient id="gSem" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#1a0533"/></linearGradient></defs>
              <rect width="108" height="108" fill="url(#gSem)"/>
              <!-- 배지 -->
              <rect x="8" y="10" width="28" height="10" rx="3" fill="#e11d48"/>
              <rect x="40" y="12" width="40" height="6" rx="2" fill="rgba(255,255,255,0.6)"/>
              <!-- 헤드라인 -->
              <rect x="8" y="28" width="75" height="8" rx="2" fill="#fff"/>
              <rect x="8" y="39" width="60" height="8" rx="2" fill="#fff"/>
              <!-- 인물 원형 -->
              <circle cx="54" cy="75" r="20" fill="rgba(255,255,255,0.15)"/>
              <circle cx="54" cy="68" r="10" fill="#e0e0e0"/>
              <!-- 이름 -->
              <rect x="30" y="92" width="48" height="5" rx="2" fill="rgba(255,255,255,0.8)"/>
              <!-- CTA -->
              <rect x="0" y="100" width="108" height="8" fill="#7c3aed"/>
            </svg>
          </div>
          <div class="layout-card-info">
            <div class="layout-card-name">세미나형</div>
            <div class="layout-card-desc">인물강조 · 라이브/이벤트</div>
          </div>
          <div class="layout-card-check">✓</div>
        </div>

        <!-- SNS UI형 카드 -->
        <div class="layout-select-card" data-layout="sns-post" onclick="toggleLayout('sns-post',this)">
          <div class="layout-card-thumb">
            <svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
              <rect width="108" height="108" fill="#f5f5f7"/>
              <!-- nav 바 -->
              <rect x="0" y="0" width="108" height="16" fill="#1877f2"/>
              <rect x="6" y="5" width="15" height="5" rx="1" fill="#fff"/>
              <rect x="25" y="5" width="12" height="5" rx="1" fill="rgba(255,255,255,0.5)"/>
              <rect x="41" y="5" width="18" height="5" rx="1" fill="rgba(255,255,255,0.5)"/>
              <!-- 카드 -->
              <rect x="6" y="22" width="96" height="70" rx="8" fill="#fff"/>
              <circle cx="18" cy="32" r="7" fill="#1877f2"/>
              <rect x="28" y="28" width="30" height="4" rx="2" fill="#333"/>
              <rect x="28" y="34" width="20" height="3" rx="1.5" fill="#aaa"/>
              <rect x="10" y="44" width="85" height="5" rx="2" fill="#222"/>
              <rect x="10" y="52" width="70" height="4" rx="2" fill="#666"/>
              <rect x="10" y="59" width="80" height="4" rx="2" fill="#666"/>
              <rect x="10" y="66" width="60" height="4" rx="2" fill="#666"/>
              <!-- CTA -->
              <rect x="0" y="96" width="108" height="12" fill="#1877f2"/>
            </svg>
          </div>
          <div class="layout-card-info">
            <div class="layout-card-name">SNS UI형</div>
            <div class="layout-card-desc">커뮤니티 게시글 모방</div>
          </div>
          <div class="layout-card-check">✓</div>
        </div>

        <!-- 비교형 카드 -->
        <div class="layout-select-card" data-layout="comparison" onclick="toggleLayout('comparison',this)">
          <div class="layout-card-thumb">
            <svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
              <rect width="108" height="52" fill="#111"/>
              <rect y="52" width="108" height="56" fill="#fff"/>
              <!-- 물결 -->
              <path d="M0,48 Q27,58 54,52 Q81,46 108,56 L108,52 L0,52 Z" fill="#fff"/>
              <!-- 다크 헤드라인 -->
              <rect x="8" y="16" width="60" height="6" rx="2" fill="#fff"/>
              <rect x="8" y="25" width="45" height="6" rx="2" fill="#f5a623"/>
              <!-- 비교표 -->
              <rect x="8" y="62" width="88" height="1" fill="#e0e0e0"/>
              <rect x="8" y="72" width="12" height="8" rx="2" fill="#e0e0e0"/>
              <rect x="24" y="72" width="15" height="8" rx="2" fill="#e0e0e0"/>
              <rect x="43" y="72" width="15" height="8" rx="2" fill="#e0e0e0"/>
              <rect x="62" y="72" width="15" height="8" rx="2" fill="#e0e0e0"/>
              <rect x="8" y="84" width="12" height="8" rx="2" fill="#f5a623"/>
              <rect x="24" y="84" width="15" height="8" rx="2" fill="#f5a623"/>
              <rect x="43" y="84" width="15" height="8" rx="2" fill="#f5a623"/>
              <rect x="62" y="84" width="15" height="8" rx="2" fill="#f5a623"/>
              <!-- CTA -->
              <rect x="0" y="100" width="108" height="8" fill="#111"/>
            </svg>
          </div>
          <div class="layout-card-info">
            <div class="layout-card-name">비교형</div>
            <div class="layout-card-desc">Before/After 비교표</div>
          </div>
          <div class="layout-card-check">✓</div>
        </div>

        <!-- 이미지강조형 카드 -->
        <div class="layout-select-card" data-layout="image-hero" onclick="toggleLayout('image-hero',this)">
          <div class="layout-card-thumb">
            <svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
              <defs><linearGradient id="gImgHero" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1a1a2e" stop-opacity="0.3"/><stop offset="60%" stop-color="#000" stop-opacity="0.8"/><stop offset="100%" stop-color="#000" stop-opacity="0.95"/></linearGradient></defs>
              <rect width="108" height="108" fill="#2a3a4a"/>
              <rect width="108" height="108" fill="url(#gImgHero)"/>
              <!-- 뱃지 -->
              <rect x="74" y="10" width="26" height="10" rx="5" fill="#f5a623"/>
              <!-- 헤드라인 -->
              <rect x="8" y="62" width="80" height="9" rx="2" fill="#fff"/>
              <rect x="8" y="74" width="65" height="9" rx="2" fill="#4a9eff"/>
              <!-- CTA 바 -->
              <rect x="0" y="96" width="108" height="12" fill="#4a9eff"/>
            </svg>
          </div>
          <div class="layout-card-info">
            <div class="layout-card-name">이미지강조형</div>
            <div class="layout-card-desc">풀블리드 · 임팩트 헤드</div>
          </div>
          <div class="layout-card-check">✓</div>
        </div>

        <!-- 커리큘럼강조형 카드 -->
        <div class="layout-select-card" data-layout="curriculum" onclick="toggleLayout('curriculum',this)">
          <div class="layout-card-thumb">
            <svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
              <rect width="108" height="108" fill="#0a0e1a"/>
              <!-- 헤드라인 -->
              <rect x="8" y="12" width="70" height="7" rx="2" fill="#fff"/>
              <rect x="8" y="22" width="55" height="7" rx="2" fill="#4a9eff"/>
              <!-- 로드맵 -->
              <line x1="18" y1="42" x2="90" y2="42" stroke="#4a9eff44" stroke-width="1.5"/>
              <circle cx="18" cy="42" r="4" fill="#4a9eff"/>
              <circle cx="36" cy="42" r="4" fill="#4a9eff"/>
              <circle cx="54" cy="42" r="4" fill="#4a9eff"/>
              <circle cx="72" cy="42" r="4" fill="#4a9eff"/>
              <circle cx="90" cy="42" r="4" fill="#4a9eff"/>
              <!-- 썸네일 그리드 -->
              <rect x="4" y="54" width="18" height="11" rx="2" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
              <rect x="25" y="54" width="18" height="11" rx="2" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
              <rect x="46" y="54" width="18" height="11" rx="2" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
              <rect x="67" y="54" width="18" height="11" rx="2" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
              <rect x="88" y="54" width="16" height="11" rx="2" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
              <rect x="4" y="68" width="18" height="11" rx="2" fill="rgba(255,255,255,0.06)"/>
              <rect x="25" y="68" width="18" height="11" rx="2" fill="rgba(255,255,255,0.06)"/>
              <rect x="46" y="68" width="18" height="11" rx="2" fill="rgba(255,255,255,0.06)"/>
              <rect x="67" y="68" width="18" height="11" rx="2" fill="rgba(255,255,255,0.06)"/>
              <rect x="88" y="68" width="16" height="11" rx="2" fill="rgba(255,255,255,0.06)"/>
              <!-- 배지 원 -->
              <circle cx="16" cy="88" r="10" fill="#4a9eff"/>
              <!-- CTA -->
              <rect x="0" y="100" width="108" height="8" fill="#4a9eff"/>
            </svg>
          </div>
          <div class="layout-card-info">
            <div class="layout-card-name">커리큘럼형</div>
            <div class="layout-card-desc">로드맵 · 강의 구성 강조</div>
          </div>
          <div class="layout-card-check">✓</div>
        </div>

        <!-- 후기사례형 카드 -->
        <div class="layout-select-card" data-layout="review" onclick="toggleLayout('review',this)">
          <div class="layout-card-thumb">
            <svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
              <rect width="108" height="108" fill="#111"/>
              <!-- 헤드라인 -->
              <rect x="8" y="12" width="62" height="6" rx="2" fill="#fff"/>
              <rect x="8" y="21" width="50" height="6" rx="2" fill="#f5a623"/>
              <!-- 인물 사진 영역 -->
              <rect x="68" y="8" width="36" height="52" rx="6" fill="#333"/>
              <!-- 후기 카드 3개 -->
              <rect x="4" y="46" width="60" height="15" rx="4" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
              <rect x="4" y="64" width="60" height="15" rx="4" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
              <rect x="4" y="82" width="60" height="12" rx="4" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
              <!-- 별점 (노랑) -->
              <rect x="8" y="49" width="20" height="3" rx="1" fill="#fbbf24"/>
              <rect x="8" y="67" width="20" height="3" rx="1" fill="#fbbf24"/>
              <rect x="8" y="85" width="20" height="3" rx="1" fill="#fbbf24"/>
              <!-- CTA -->
              <rect x="0" y="100" width="108" height="8" fill="#f5a623"/>
            </svg>
          </div>
          <div class="layout-card-info">
            <div class="layout-card-name">후기사례형</div>
            <div class="layout-card-desc">별점 후기 · 소셜 증명</div>
          </div>
          <div class="layout-card-check">✓</div>
        </div>
```

- [ ] **Step 2: 인물이미지 섹션 HTML 추가**

`#scVariations` 섹션 닫는 `</div>` 바로 뒤에 삽입 (레이아웃 선택 섹션 다음):

```html
    <!-- ⑤ 인물 이미지 (인물강조 레이아웃 선택 시만 표시) -->
    <div id="scPersonImage" style="display:none;margin-top:4px">
      <div class="sc-toggle-header" onclick="toggleSection('scPersonImageBody')">
        <span>④ 인물 이미지 <small style="color:var(--tx-muted)">(강사·모델 사진)</small></span>
        <span class="sc-toggle-arrow" id="scPersonImageBodyArrow">▼</span>
      </div>
      <div id="scPersonImageBody" class="sc-section-body">
        <!-- 자동감지 미리보기 -->
        <div id="personImgAutoRow" style="display:none;margin-bottom:12px">
          <div style="font-size:12px;color:var(--tx-sub);margin-bottom:6px">🔍 페이지에서 자동 감지된 이미지</div>
          <div style="display:flex;align-items:center;gap:12px">
            <img id="personImgAutoThumb" src="" style="width:72px;height:72px;object-fit:cover;border-radius:50%;border:2px solid var(--bdr)">
            <div>
              <div style="font-size:12px;color:var(--tx-sub);margin-bottom:4px">이 이미지를 사용합니다. 다른 이미지로 변경하려면 아래에서 업로드하거나 URL을 입력하세요.</div>
              <button onclick="clearPersonImage()" style="font-size:12px;padding:4px 10px;border:1px solid var(--bdr);border-radius:6px;background:var(--panel-bg);color:var(--tx-sub);cursor:pointer">✕ 제거</button>
            </div>
          </div>
        </div>

        <!-- 업로드 -->
        <div style="margin-bottom:10px">
          <label style="font-size:12px;font-weight:600;color:var(--tx-sub);display:block;margin-bottom:4px">파일 업로드</label>
          <label style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border:1.5px dashed var(--bdr);border-radius:8px;cursor:pointer;font-size:13px;color:var(--tx-sub)">
            📁 이미지 선택
            <input type="file" id="personImgFile" accept="image/*" style="display:none" onchange="onPersonImageFileChange(event)">
          </label>
          <span id="personImgFileName" style="margin-left:8px;font-size:12px;color:var(--tx-muted)"></span>
        </div>

        <!-- CDN URL -->
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--tx-sub);display:block;margin-bottom:4px">이미지 URL (CDN 링크)</label>
          <div style="display:flex;gap:6px">
            <input type="url" id="personImgUrl" placeholder="https://..." style="flex:1;padding:8px 10px;border:1.5px solid var(--bdr);border-radius:8px;font-size:13px;background:var(--inp-bg);color:var(--tx)">
            <button onclick="fetchPersonImageFromUrl()" style="padding:8px 14px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">불러오기</button>
          </div>
          <div id="personImgUrlError" style="font-size:12px;color:#e53e3e;margin-top:4px;display:none"></div>
        </div>

        <!-- 선택된 이미지 미리보기 -->
        <div id="personImgSelectedRow" style="display:none;margin-top:12px;display:flex;align-items:center;gap:10px">
          <img id="personImgSelectedThumb" src="" style="width:72px;height:72px;object-fit:cover;border-radius:50%;border:2px solid var(--accent)">
          <div style="font-size:12px;color:var(--accent);font-weight:600">✓ 선택됨 — 생성 시 이 이미지를 사용합니다</div>
        </div>
      </div>
    </div>

    <!-- ⑥ 세미나형 전용 입력 -->
    <div id="scSeminarFields" style="display:none;margin-top:4px">
      <div class="sc-toggle-header" onclick="toggleSection('scSeminarBody')">
        <span>⑤ 세미나 정보 <small style="color:var(--tx-muted)">(세미나형 전용)</small></span>
        <span class="sc-toggle-arrow" id="scSeminarBodyArrow">▼</span>
      </div>
      <div id="scSeminarBody" class="sc-section-body">
        <div style="margin-bottom:10px">
          <label style="font-size:12px;font-weight:600;color:var(--tx-sub);display:block;margin-bottom:4px">이벤트 유형</label>
          <select id="seminarEventBadge" style="width:100%;padding:8px 10px;border:1.5px solid var(--bdr);border-radius:8px;font-size:13px;background:var(--inp-bg);color:var(--tx)">
            <option value="무료 LIVE">무료 LIVE</option>
            <option value="무료 웨비나">무료 웨비나</option>
            <option value="유료 세미나">유료 세미나</option>
            <option value="무료 특강">무료 특강</option>
            <option value="온라인 강의">온라인 강의</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--tx-sub);display:block;margin-bottom:4px">날짜 · 시간</label>
          <input type="text" id="seminarEventDate" placeholder="예: 2026. 05. 10 (일) 20:00" style="width:100%;padding:8px 10px;border:1.5px solid var(--bdr);border-radius:8px;font-size:13px;background:var(--inp-bg);color:var(--tx)">
        </div>
      </div>
    </div>
```

- [ ] **Step 3: `toggleLayout` 함수 수정 + 인물강조/세미나 감지 로직 추가**

`public/index.html`에서 `toggleLayout` 함수를 찾아 다음으로 교체:

```javascript
const PERSON_LAYOUTS = ['instructor', 'seminar', 'review'];

function toggleLayout(type, el) {
  el.classList.toggle('selected');
  updateSelectedLayouts();
  // 인물강조 레이아웃 선택 여부에 따라 인물이미지 섹션 표시
  const anyPersonLayout = [...document.querySelectorAll('.layout-select-card.selected')]
    .some(c => PERSON_LAYOUTS.includes(c.dataset.layout));
  document.getElementById('scPersonImage').style.display = anyPersonLayout ? 'block' : 'none';
  // 세미나형 선택 여부에 따라 세미나 입력 표시
  const anySeminar = [...document.querySelectorAll('.layout-select-card.selected')]
    .some(c => c.dataset.layout === 'seminar');
  document.getElementById('scSeminarFields').style.display = anySeminar ? 'block' : 'none';
}
```

- [ ] **Step 4: 인물이미지 JS 함수 추가**

`</script>` 바로 위에 삽입:

```javascript
// ─── 인물 이미지 관련 ───
let personImageBase64 = null; // 선택된 인물 이미지 (base64)

function onPersonImageFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('personImgFileName').textContent = file.name;
  const reader = new FileReader();
  reader.onload = ev => {
    personImageBase64 = ev.target.result;
    showPersonImagePreview(personImageBase64, 'selected');
  };
  reader.readAsDataURL(file);
}

async function fetchPersonImageFromUrl() {
  const url = document.getElementById('personImgUrl').value.trim();
  const errEl = document.getElementById('personImgUrlError');
  errEl.style.display = 'none';
  if (!url) { errEl.textContent = 'URL을 입력해주세요'; errEl.style.display = 'block'; return; }
  try {
    const res = await fetch('/api/fetch-person-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || '불러오기 실패'; errEl.style.display = 'block'; return; }
    personImageBase64 = data.dataUrl;
    showPersonImagePreview(personImageBase64, 'selected');
  } catch (e) {
    errEl.textContent = '서버 오류: ' + e.message; errEl.style.display = 'block';
  }
}

function showPersonImagePreview(src, type) {
  if (type === 'auto') {
    document.getElementById('personImgAutoRow').style.display = 'flex';
    document.getElementById('personImgAutoThumb').src = src;
    document.getElementById('personImgSelectedRow').style.display = 'none';
  } else {
    document.getElementById('personImgSelectedRow').style.display = 'flex';
    document.getElementById('personImgSelectedThumb').src = src;
    document.getElementById('personImgAutoRow').style.display = 'none';
  }
}

function clearPersonImage() {
  personImageBase64 = null;
  document.getElementById('personImgAutoRow').style.display = 'none';
  document.getElementById('personImgSelectedRow').style.display = 'none';
  document.getElementById('personImgFile').value = '';
  document.getElementById('personImgFileName').textContent = '';
  document.getElementById('personImgUrl').value = '';
}

// 생성 결과에서 자동감지 이미지 표시
function applyDetectedPersonImage(url) {
  if (!url || personImageBase64) return; // 이미 수동 선택된 이미지가 있으면 스킵
  personImageBase64 = null; // URL을 직접 서버에 전달
  document.getElementById('personImgAutoRow').style.display = 'flex';
  document.getElementById('personImgAutoThumb').src = url;
  window._detectedPersonImageUrl = url; // 다음 생성 시 전달용
}
```

- [ ] **Step 5: `generateAd()` 함수에 인물이미지 + 세미나 파라미터 추가**

`public/index.html`에서 `/api/generate-ad` fetch body 부분을 찾아 다음 필드를 추가:

```javascript
// 기존 body JSON.stringify 안에 추가
person_image_base64: personImageBase64 || null,
person_image_url: (!personImageBase64 && window._detectedPersonImageUrl) ? window._detectedPersonImageUrl : null,
event_badge: document.getElementById('seminarEventBadge')?.value || '무료 LIVE',
event_date: document.getElementById('seminarEventDate')?.value || '',
```

그리고 생성 완료 후 응답 처리 부분에 추가:

```javascript
// res.json() 파싱 후 (variations 처리 코드 근처)
if (data.detectedPersonImageUrl) {
  applyDetectedPersonImage(data.detectedPersonImageUrl);
}
```

- [ ] **Step 6: 커밋**

```bash
git add public/index.html
git commit -m "feat: 레이아웃 카드 7종 + 인물이미지 UI + 세미나 입력 필드"
```

---

## Task 6: 컬러 커스터마이징 패널

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 컬러 패널 CSS 추가**

`public/index.html` `<style>` 블록 안 (기존 `.cta-color-presets` 스타일 아래)에 추가:

```css
    /* ── 컬러 커스터마이징 패널 ── */
    .color-panel-tabs { display:flex; gap:4px; margin-bottom:12px; flex-wrap:wrap; }
    .color-panel-tab { padding:5px 10px; border-radius:6px; border:1.5px solid var(--bdr); background:var(--panel-bg); color:var(--tx-sub); font-size:12px; font-weight:600; cursor:pointer; transition:.15s; }
    .color-panel-tab.active { border-color:var(--accent); color:var(--accent); background:var(--accent-lt); }
    .color-swatches { display:grid; grid-template-columns:repeat(6,1fr); gap:5px; margin-bottom:10px; }
    .color-swatch-item { width:100%; aspect-ratio:1; border-radius:6px; cursor:pointer; border:2px solid transparent; transition:.12s; }
    .color-swatch-item:hover { transform:scale(1.12); border-color:var(--tx); }
    .color-swatch-item.selected { border-color:var(--tx); box-shadow:0 0 0 2px var(--accent); }
    .color-hex-row { display:flex; gap:6px; align-items:center; }
    .color-hex-input { flex:1; padding:7px 10px; border:1.5px solid var(--bdr); border-radius:8px; font-size:13px; font-family:monospace; background:var(--inp-bg); color:var(--tx); }
    .color-hex-preview { width:34px; height:34px; border-radius:6px; border:1.5px solid var(--bdr); flex-shrink:0; }
```

- [ ] **Step 2: 컬러 패널 HTML 추가**

`#scSeminarFields` 섹션 닫는 `</div>` 바로 뒤에 삽입:

```html
    <!-- ⑦ 컬러 커스터마이징 -->
    <div style="margin-top:4px">
      <div class="sc-toggle-header" onclick="toggleSection('scColorPanel')">
        <span>⑥ 색상 조정 <small style="color:var(--tx-muted)">(실시간 적용)</small></span>
        <span class="sc-toggle-arrow" id="scColorPanelArrow">▼</span>
      </div>
      <div id="scColorPanel" class="sc-section-body" style="display:none">

        <!-- 요소 탭 -->
        <div class="color-panel-tabs">
          <button class="color-panel-tab active" data-color-el="accentColor" onclick="switchColorTab(this)">강조색</button>
          <button class="color-panel-tab" data-color-el="ctaColor" onclick="switchColorTab(this)">CTA 배경</button>
          <button class="color-panel-tab" data-color-el="ctaTextColor" onclick="switchColorTab(this)">CTA 텍스트</button>
          <button class="color-panel-tab" data-color-el="headlineColor" onclick="switchColorTab(this)">헤드라인</button>
          <button class="color-panel-tab" data-color-el="subColor" onclick="switchColorTab(this)">서브카피</button>
        </div>

        <!-- 스와치 팔레트 24색 -->
        <div class="color-swatches" id="colorSwatches"></div>

        <!-- HEX 직접 입력 -->
        <div class="color-hex-row">
          <span style="font-size:13px;font-weight:600;color:var(--tx-sub)">#</span>
          <input class="color-hex-input" id="colorHexInput" maxlength="6" placeholder="1877f2" oninput="onColorHexInput(this.value)">
          <div class="color-hex-preview" id="colorHexPreview"></div>
        </div>
        <div style="margin-top:8px;font-size:11px;color:var(--tx-muted)">색상을 바꾸면 미리보기에 즉시 반영됩니다. 재생성 없이 색만 교체합니다.</div>

        <!-- 색상 초기화 -->
        <button onclick="resetColors()" style="margin-top:8px;font-size:12px;padding:5px 12px;border:1px solid var(--bdr);border-radius:6px;background:var(--panel-bg);color:var(--tx-sub);cursor:pointer">↺ 기본값으로 초기화</button>
      </div>
    </div>
```

- [ ] **Step 3: 컬러 커스터마이징 JS 추가**

`</script>` 바로 위에 삽입:

```javascript
// ─── 컬러 커스터마이징 ───
const COLOR_PALETTE = [
  // 다크 계열
  '#0a0a0a','#1a1a2e','#16213e','#0f3460','#1b1b2f','#2d2d2d',
  // 컬러 계열
  '#1877f2','#e84393','#00b140','#ff6b35','#7b2d8b','#f5a623',
  // 파스텔 계열
  '#a8d8ea','#aa96da','#fcbad3','#ffffd2','#b5ead7','#ffdac1',
  // 흰/회색 계열
  '#ffffff','#f5f5f5','#e0e0e0','#bdbdbd','#757575','#000000',
];

// 현재 색상 상태
let adColors = {
  accentColor:   null,
  ctaColor:      null,
  ctaTextColor:  null,
  headlineColor: null,
  subColor:      null,
};
let activeColorEl = 'accentColor';

// CSS 변수 매핑
const CSS_VAR_MAP = {
  accentColor:   '--accent',
  ctaColor:      '--cta-bg',
  ctaTextColor:  '--cta-text',
  headlineColor: '--headline-clr',
  subColor:      '--sub-clr',
};

function initColorPanel() {
  const swatchContainer = document.getElementById('colorSwatches');
  swatchContainer.innerHTML = COLOR_PALETTE.map(c =>
    `<div class="color-swatch-item" style="background:${c}" data-color="${c}" onclick="selectSwatch('${c}')"></div>`
  ).join('');
  updateHexInput(adColors[activeColorEl] || '');
}

function switchColorTab(btn) {
  document.querySelectorAll('.color-panel-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeColorEl = btn.dataset.colorEl;
  updateHexInput(adColors[activeColorEl] || '');
}

function selectSwatch(hex) {
  applyColor(activeColorEl, hex);
  updateHexInput(hex.replace('#',''));
  document.querySelectorAll('.color-swatch-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.color === hex);
  });
}

function onColorHexInput(val) {
  const clean = val.replace(/[^0-9a-fA-F]/g,'').slice(0,6);
  document.getElementById('colorHexInput').value = clean;
  if (clean.length === 6) {
    applyColor(activeColorEl, '#' + clean);
  }
}

function updateHexInput(hex) {
  const clean = (hex || '').replace('#','');
  document.getElementById('colorHexInput').value = clean;
  document.getElementById('colorHexPreview').style.background = clean.length === 6 ? '#' + clean : 'transparent';
}

function applyColor(element, hex) {
  adColors[element] = hex;
  document.getElementById('colorHexPreview').style.background = hex;
  // localStorage 저장
  localStorage.setItem('adcraft_colors', JSON.stringify(adColors));
  // 현재 표시 중인 모든 광고 iframe에 CSS 변수 주입
  const cssVar = CSS_VAR_MAP[element];
  if (!cssVar) return;
  document.querySelectorAll('.sc-preview-iframe, .sc-wrap iframe, iframe').forEach(iframe => {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc && doc.documentElement) doc.documentElement.style.setProperty(cssVar, hex);
    } catch {}
  });
}

function resetColors() {
  adColors = { accentColor:null, ctaColor:null, ctaTextColor:null, headlineColor:null, subColor:null };
  localStorage.removeItem('adcraft_colors');
  updateHexInput('');
  // iframe CSS 변수 제거 → 템플릿 기본값으로 복귀
  Object.values(CSS_VAR_MAP).forEach(cssVar => {
    document.querySelectorAll('iframe').forEach(iframe => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc && doc.documentElement) doc.documentElement.style.removeProperty(cssVar);
      } catch {}
    });
  });
}

// 페이지 로드 시 저장된 색상 복원
(function restoreColors() {
  const saved = localStorage.getItem('adcraft_colors');
  if (saved) {
    try { adColors = { ...adColors, ...JSON.parse(saved) }; } catch {}
  }
})();

// DOMContentLoaded 후 패널 초기화
document.addEventListener('DOMContentLoaded', initColorPanel);
```

- [ ] **Step 4: `generateAd()` 함수에 colors 파라미터 추가**

기존 `/api/generate-ad` fetch body JSON.stringify 안에 추가:

```javascript
colors: Object.fromEntries(Object.entries(adColors).filter(([,v]) => v !== null)),
```

그리고 서버에서 `assemblyAgent` 호출 시 colors를 전달하려면 Task 4 Step 9에서 이미 `colors = {}` 파라미터를 추가했으므로, `req.body`에서 받아오는 부분도 추가:

**server.js** `/api/generate-ad` req.body 구조분해에:
```javascript
colors = {},          // 프론트 컬러 커스터마이징 값
```

그리고 `assemblyAgent` 호출에:
```javascript
colors,
```

- [ ] **Step 5: 커밋**

```bash
git add public/index.html server.js
git commit -m "feat: 컬러 커스터마이징 패널 — 24색 스와치 + HEX 입력 + 실시간 iframe CSS 변수 주입"
```

---

## Task 7: Vercel 배포 + 최종 확인

**Files:**
- 없음 (git push만)

- [ ] **Step 1: 로컬 전체 플로우 테스트**

```bash
cd "C:\Users\SB_소수현\Documents\adcraft-hackathon"
npm start
```

브라우저에서 `http://localhost:3000` 접속:
1. 레이아웃 카드 9종 (기존 2 + 신규 7) 보이는지 확인
2. `강사강조형` 선택 → 인물이미지 섹션 표시 확인
3. `세미나형` 선택 → 세미나 입력 섹션 표시 확인
4. 컬러 탭에서 강조색 선택 → 생성 후 iframe에 즉시 반영 확인
5. URL 입력 후 `강사강조형` 선택 → 생성 → HTML에 `강사` 관련 컨텐츠 확인

- [ ] **Step 2: GitHub push (Vercel 자동 배포)**

```bash
cd "C:\Users\SB_소수현\Documents\adcraft-hackathon"
git push origin main
```

- [ ] **Step 3: Vercel 배포 완료 확인**

`https://adcraft-hackathon.vercel.app` 접속:
1. 레이아웃 카드 9종 보이는지 확인
2. 임의 URL (예: 패스트캠퍼스 강의 페이지) + `강사강조형` 선택 → 생성 → HTML에 instructor 관련 필드 출력 확인
3. 컬러 스와치 클릭 → 기존 광고 미리보기에 색상 즉시 반영 확인

---

## Self-Review

### Spec Coverage

| 스펙 항목 | 구현 Task |
|---|---|
| 강사강조형 HTML | Task 4 Step 1 |
| 세미나형 HTML | Task 4 Step 2 |
| SNS UI형 HTML (다크/라이트 자동) | Task 4 Step 3 |
| 비교형 HTML | Task 4 Step 4 |
| 이미지강조형 HTML | Task 4 Step 5 |
| 커리큘럼강조형 HTML | Task 4 Step 6 |
| 후기사례형 HTML | Task 4 Step 7 |
| 인물이미지 자동추출 | Task 1 Step 1-2 |
| /api/fetch-person-image | Task 1 Step 4 |
| 인물이미지 업로드 UI | Task 5 Step 2-4 |
| 세미나 날짜/뱃지 입력 | Task 5 Step 2 |
| Claude 레이아웃별 추가 필드 | Task 2 |
| 레이아웃 카드 7종 SVG 썸네일 | Task 5 Step 1 |
| CSS 변수 빌더 | Task 3 |
| 컬러 패널 UI | Task 6 Step 1-2 |
| 컬러 실시간 iframe 반영 | Task 6 Step 3 |
| 브랜드 중립 (하드코딩 없음) | 모든 HTML 생성 함수: 동적 필드만 사용 |
| colors 서버 전달 | Task 6 Step 4 |
| Vercel 배포 | Task 7 |

### Placeholder 없음 확인
- 모든 Task에 완전한 코드 포함됨 ✓
- "TBD", "TODO" 없음 ✓

### 타입 일관성 확인
- `generateAdHTML` 시그니처: `(d, bgColor, bgImageBase64, cssBackground, font, ctaColor, personImg, colors, eventDate, eventBadge)` — Task 4 Step 8, Task 4 Step 10 일치 ✓
- `assemblyAgent` `personImageBase64`, `personImageUrl`, `eventDate`, `eventBadge`, `colors` 파라미터 — Task 4 Step 9, Task 1 Step 3 일치 ✓
- `adColors` 객체 키: `accentColor`, `ctaColor`, `ctaTextColor`, `headlineColor`, `subColor` — Task 6 Step 3, 4 일치 ✓
- `CSS_VAR_MAP` 값: `--accent`, `--cta-bg`, `--cta-text`, `--headline-clr`, `--sub-clr` — Task 3 Step 1의 `buildCssVars` 출력과 일치 ✓
