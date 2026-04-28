import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { parse } from 'node-html-parser';
import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── reference_images/ 폴더 자동 로드 ───
const REF_IMAGES_DIR = join(__dirname, 'reference_images');
function loadReferenceImages() {
  if (!existsSync(REF_IMAGES_DIR)) return [];
  const files = readdirSync(REF_IMAGES_DIR)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort();
  if (!files.length) return [];
  const images = files.map(f => {
    const buf = readFileSync(join(REF_IMAGES_DIR, f));
    const ext = f.split('.').pop().toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  });
  console.log(`[reference_images] ${files.length}장 자동 로드:`, files.join(', '));
  return images;
}
const AUTO_REF_IMAGES = loadReferenceImages();

// ─── 주예진 체크리스트 로드 (CHECKLIST.md) ───
const CHECKLIST_FILE = join(__dirname, 'CHECKLIST.md');
let checklistContent = '';
try {
  checklistContent = readFileSync(CHECKLIST_FILE, 'utf8');
  console.log('[체크리스트 로드 완료] CHECKLIST.md');
} catch {
  console.warn('[체크리스트 없음] CHECKLIST.md 파일을 찾을 수 없어 기본 기준으로 동작합니다.');
}

// ─── 디자인 스펙 로드 (DESIGN_SPEC.md) ───
const DESIGN_SPEC_FILE = join(__dirname, 'DESIGN_SPEC.md');
let designSpecContent = '';
try {
  designSpecContent = readFileSync(DESIGN_SPEC_FILE, 'utf8');
  console.log('[디자인 스펙 로드 완료] DESIGN_SPEC.md');
} catch {
  console.warn('[디자인 스펙 없음] DESIGN_SPEC.md를 찾을 수 없어 기본 기준으로 동작합니다.');
}

// ─── Figma 레퍼런스 스타일 로드 (FIGMA_STYLES.md) ───
const FIGMA_STYLES_FILE = join(__dirname, 'FIGMA_STYLES.md');
let figmaStylesContent = '';
try {
  figmaStylesContent = readFileSync(FIGMA_STYLES_FILE, 'utf8');
  console.log('[Figma 스타일 로드 완료] FIGMA_STYLES.md');
} catch {
  console.warn('[Figma 스타일 없음] FIGMA_STYLES.md를 찾을 수 없습니다.');
}

// ─── 레이아웃 레퍼런스 저장소 ───
const LAYOUTS_FILE = join(__dirname, 'layouts.json');
function readLayouts() {
  if (!existsSync(LAYOUTS_FILE)) return [];
  try { return JSON.parse(readFileSync(LAYOUTS_FILE, 'utf8')); } catch { return []; }
}
function writeLayouts(arr) { writeFileSync(LAYOUTS_FILE, JSON.stringify(arr, null, 2), 'utf8'); }

// ─── 헬스체크 ───
app.get('/health', (req, res) => {
  res.json({ status: 'ok', api_key_set: !!process.env.ANTHROPIC_API_KEY });
});

// ─── 광고소재 생성 (메인) ───
app.post('/api/generate-ad', async (req, res) => {
  const {
    url,
    target = '',
    usp1 = '', usp2 = '', usp3 = '',
    ad_set_message = '',
    creative_message = '',
    reference_images = [],
    bg_color = '',
    layout_ref_id = '',
    custom_bg_image = null,
    custom_bg_css = null,
    font = 'Pretendard',
  } = req.body;

  if (!url) return res.status(400).json({ error: 'URL이 필요합니다' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되지 않았습니다.' });
  }

  try {
    console.log('\n' + '─'.repeat(50));
    console.log('[🚀 생성 시작]', url);
    console.log('─'.repeat(50));

    // ── STEP 1: 페이지 크롤링 (모든 에이전트의 기반 데이터) ──
    const { text: pageContent, themeColor: pageThemeColor, ogImageUrl } = await fetchPageContent(url);
    console.log('[크롤링 완료] 텍스트', pageContent.length, 'chars | 테마:', pageThemeColor || '없음', '| OG:', ogImageUrl ? 'O' : 'X');

    // ── STEP 2: 이미지 에이전트 + 소재정보 추출 병렬 실행 ──
    // → 이미지 에이전트: 레퍼런스 분석 + 배경 이미지 fetch (동시)
    // → 소재정보 추출: URL 자동 추출이 필요할 때만
    const rawPageInfo = { target, usp1, usp2, usp3, ad_set_message, creative_message };
    const needsAutoExtract = !target && !usp1 && !usp2 && !usp3 && !ad_set_message && !creative_message;

    const [imageResult, resolvedPageInfo] = await Promise.all([
      imageAgent({ referenceImages: reference_images, ogImageUrl, customBgImage: custom_bg_image, customBgCss: custom_bg_css }),
      needsAutoExtract ? extractPageInfo(pageContent) : Promise.resolve(rawPageInfo),
    ]);
    const extractedInfo = needsAutoExtract ? resolvedPageInfo : null;

    // ── STEP 3: 배경 컬러 결정 (이미지 에이전트 결과 활용) ──
    const { color: effectiveBgColor, source: colorSource } = await determineBgColor({
      bgColor: bg_color,
      parsedStyle: imageResult.parsedStyle,
      layoutRefId: layout_ref_id,
      pageThemeColor,
      pageContent,
    });

    // ── STEP 4: 카피 에이전트 (스타일 분석 결과 + 소재정보 활용) ──
    const { adDataList } = await copyAgent({
      pageContent,
      pageInfo: resolvedPageInfo,
      styleAnalysis: imageResult.styleAnalysis,
    });

    // ── STEP 5: 조합 에이전트 (카피 + 이미지 → HTML) ──
    const variations = assemblyAgent({
      adDataList,
      bgColor: effectiveBgColor,
      bgImageBase64: imageResult.bgImageBase64,
      bgCss: imageResult.bgCss,
      font,
    });

    console.log('─'.repeat(50));
    console.log('[✅ 생성 완료]', variations.length, '종 | 컬러:', effectiveBgColor, `(${colorSource})`);
    console.log('─'.repeat(50) + '\n');

    res.json({
      variations,
      extractedInfo,
      effectiveBgColor,
      colorSource,
    });
  } catch (err) {
    console.error('[오류]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 레이아웃 레퍼런스 CRUD ───
app.get('/api/layouts', (req, res) => {
  const layouts = readLayouts().map(({ id, name, imageData }) => ({ id, name, thumbnail: imageData }));
  res.json({ layouts });
});

app.post('/api/layouts', (req, res) => {
  const { name, imageData } = req.body;
  if (!name || !imageData) return res.status(400).json({ error: 'name, imageData 필요' });
  const layouts = readLayouts();
  const id = Date.now().toString();
  layouts.push({ id, name, imageData });
  writeLayouts(layouts);
  console.log('[레이아웃 저장]', name, 'id:', id);
  res.json({ id, name });
});

app.delete('/api/layouts/:id', (req, res) => {
  const before = readLayouts();
  const after = before.filter(l => l.id !== req.params.id);
  writeLayouts(after);
  console.log('[레이아웃 삭제]', req.params.id);
  res.json({ ok: true });
});

// ─── 이미지 URL 프록시 (Meta 광고 라이브러리 등 공개 이미지) ───
app.post('/api/fetch-image', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다' });

  const ALLOWED_HOSTS = [
    'fbcdn.net', 'facebook.com', 'fbsbx.com',
    'cdninstagram.com', 'instagram.com',
    'scontent', // fbcdn 서브도메인 패턴
    'images.unsplash.com', 'unsplash.com',
  ];
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return res.status(400).json({ error: '잘못된 URL입니다' }); }

  const isAllowed = ALLOWED_HOSTS.some(h => hostname.includes(h));
  if (!isAllowed) return res.status(403).json({ error: '허용되지 않은 도메인입니다. Meta 광고 라이브러리 이미지 URL만 사용하세요.' });

  try {
    const imgRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.facebook.com/' },
      signal: AbortSignal.timeout(10000),
    });
    if (!imgRes.ok) throw new Error(`이미지 다운로드 실패: HTTP ${imgRes.status}`);

    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) throw new Error('이미지 파일이 아닙니다');

    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    res.json({ dataUrl: `data:${contentType};base64,${base64}` });
  } catch (err) {
    console.error('[이미지 프록시 오류]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  에이전트 (Agent) — 각자 독립적인 역할과 책임
// ══════════════════════════════════════════════════════

// ─── 🖼 이미지 에이전트 ───
// 역할: 레퍼런스 이미지 스타일 분석 + 배경 이미지 취득
// 독립성: 페이지 텍스트 불필요. 이미지 데이터만으로 동작.
// 병렬성: 카피 에이전트와 동시 실행 가능 (크롤링 후 바로 시작).
async function imageAgent({ referenceImages, ogImageUrl, customBgImage, customBgCss }) {
  // API 요청에 레퍼런스 없으면 reference_images/ 폴더 자동 사용
  const effectiveRefs = referenceImages.length > 0 ? referenceImages : AUTO_REF_IMAGES;
  console.log('[🖼 이미지 에이전트] 시작 | 레퍼런스:', effectiveRefs.length, '장', effectiveRefs.length > 0 && referenceImages.length === 0 ? '(폴더 자동로드)' : '', '| OG:', ogImageUrl ? 'O' : 'X');

  // 스타일 분석과 배경 이미지 fetch 동시 실행
  const [styleAnalysis, bgImageBase64] = await Promise.all([
    effectiveRefs.length > 0
      ? analyzeReferenceImages(effectiveRefs)
      : Promise.resolve(null),
    customBgImage
      ? Promise.resolve(customBgImage)                             // Unsplash 선택 이미지 우선
      : (ogImageUrl ? fetchOgImageBase64(ogImageUrl) : Promise.resolve(null)),
  ]);

  let parsedStyle = null;
  if (styleAnalysis) {
    try {
      const m = styleAnalysis.match(/\{[\s\S]+\}/);
      if (m) parsedStyle = JSON.parse(m[0]);
    } catch (e) { console.warn('[이미지 에이전트] 스타일 파싱 실패', e.message); }
  }

  console.log('[🖼 이미지 에이전트] 완료 | 스타일 bg:', parsedStyle?.bg_hex || '없음', '| 배경이미지:', bgImageBase64 ? 'O' : 'X', '| CSS배경:', customBgCss ? 'O' : 'X');
  return { styleAnalysis, parsedStyle, bgImageBase64, bgCss: customBgCss || null };
}

// ─── ✍️ 카피 에이전트 ───
// 역할: 페이지 내용 + USP + 체크리스트 기준으로 카피 3종 생성
// 독립성: 이미지 데이터 없이도 동작. 스타일 분석은 선택적 입력.
// 병렬성: 이미지 에이전트와 동시 실행 가능 (소재정보 자동추출 포함).
async function copyAgent({ pageContent, pageInfo, styleAnalysis }) {
  console.log('[✍️ 카피 에이전트] 시작 | 타겟:', pageInfo.target ? pageInfo.target.slice(0, 30) : '자동추출됨');

  const adDataList = await extractAdDataVariations(pageContent, styleAnalysis, pageInfo);

  console.log('[✍️ 카피 에이전트] 완료 |', adDataList.map(v => `${v.variation_label}(${v.validation_score}/11)`).join(' · '));
  return { adDataList };
}

// ─── 🔧 조합 에이전트 ───
// 역할: 카피 데이터 + 배경 이미지 → 1080×1080 HTML 소재 3종 조립
// 독립성: 카피 에이전트 + 이미지 에이전트 결과만 있으면 즉시 실행.
// 특성: 동기(sync) 함수 — Claude API 호출 없이 순수 템플릿 렌더링.
function assemblyAgent({ adDataList, bgColor, bgImageBase64, bgCss, font = 'Pretendard' }) {
  console.log('[🔧 조합 에이전트] 시작 | 배경컬러:', bgColor, '| 이미지:', bgImageBase64 ? 'O' : 'X', '| CSS배경:', bgCss ? 'O' : 'X');

  const variations = adDataList.map(adData => ({
    adData,
    html: generateAdHTML(adData, bgColor, bgImageBase64, bgCss, font),
  }));

  console.log('[🔧 조합 에이전트] 완료 | HTML 소재', variations.length, '종 생성');
  return variations;
}

// ─── 배경 컬러 결정 (우선순위 체인) ───
// manual(직접입력) > style_ref > layout_ref > theme_color > ai_inferred > default
async function determineBgColor({ bgColor, parsedStyle, layoutRefId, pageThemeColor, pageContent }) {
  let color = '#1B5BD4';
  let source = 'default';

  if (bgColor && /^#[0-9A-Fa-f]{6}$/.test(bgColor)) {
    color = bgColor; source = 'manual';
  } else {
    const styleHex = parsedStyle?.bg_hex;
    if (styleHex && /^#[0-9A-Fa-f]{6}$/.test(styleHex)) {
      color = styleHex; source = 'style_ref';
    } else if (layoutRefId) {
      const refLayout = readLayouts().find(l => l.id === layoutRefId);
      if (refLayout) {
        const raw = await analyzeReferenceImages([refLayout.imageData]);
        const lm = raw?.match(/\{[\s\S]+\}/);
        if (lm) {
          try {
            const ls = JSON.parse(lm[0]);
            if (ls.bg_hex && /^#[0-9A-Fa-f]{6}$/.test(ls.bg_hex)) { color = ls.bg_hex; source = 'layout_ref'; }
          } catch {}
        }
      }
    }
    if (source === 'default' && pageThemeColor) { color = pageThemeColor; source = 'theme_color'; }
    if (source === 'default') {
      const aiColor = await extractKeyColorFromContent(pageContent);
      if (aiColor) { color = aiColor; source = 'ai_inferred'; }
    }
  }
  console.log('[배경컬러 결정]', color, `(${source})`);
  return { color, source };
}

// ══════════════════════════════════════════════════════

// ─── Claude CSS Art 배경 생성 (Gemini 폴백) ───

// ─── 페이지 크롤링 ───
async function fetchPageContent(url) {
  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  ];

  let html = '';
  for (const ua of USER_AGENTS) {
    const res = await fetch(url, {
      headers: { 'User-Agent': ua },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`크롤링 실패: HTTP ${res.status}`);
    html = await res.text();

    const root = parse(html);
    root.querySelectorAll('script, style, nav, footer, header').forEach(el => el.remove());
    const candidate = root.innerText.replace(/\s+/g, ' ').trim();
    if (candidate.length >= 200) break; // 콘텐츠 충분 — 이 UA로 확정
    console.log(`[크롤링] UA(${ua.slice(0,30)}...) 콘텐츠 부족(${candidate.length}자), 폴백 시도`);
  }

  // 페이지 테마컬러 추출 (theme-color / msapplication-TileColor)
  const tcPatterns = [
    /name=["']theme-color["'][^>]*content=["'](#[0-9A-Fa-f]{6})/i,
    /content=["'](#[0-9A-Fa-f]{6})["'][^>]*name=["']theme-color["']/i,
    /name=["']msapplication-TileColor["'][^>]*content=["'](#[0-9A-Fa-f]{6})/i,
  ];
  let themeColor = null;
  for (const p of tcPatterns) {
    const m = html.match(p);
    if (m) { themeColor = m[1]; break; }
  }

  // OG 이미지 추출
  const ogPatterns = [
    /property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
    /name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i,
  ];
  let ogImageUrl = null;
  for (const p of ogPatterns) {
    const m = html.match(p);
    if (m && m[1].startsWith('http')) { ogImageUrl = m[1]; break; }
  }

  const root = parse(html);
  root.querySelectorAll('script, style, nav, footer, header').forEach(el => el.remove());
  const text = root.innerText.replace(/\s+/g, ' ').trim().slice(0, 3000);
  return { text, themeColor, ogImageUrl };
}

// ─── OG 이미지 base64 변환 ───
async function fetchOgImageBase64(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || 'image/jpeg';
    if (!ct.startsWith('image/')) return null;
    const buf = await res.arrayBuffer();
    return `data:${ct};base64,${Buffer.from(buf).toString('base64')}`;
  } catch { return null; }
}

// ─── 페이지 내용에서 브랜드 키컬러 추론 ───
async function extractKeyColorFromContent(pageText) {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{
        role: 'user',
        content: `아래 상세페이지 내용으로 이 브랜드의 메인 키컬러를 추측하라.
브랜드명·업종·분위기를 고려해 광고 배경에 어울리는 색상 하나를 골라라.
${pageText.slice(0, 500)}
#RRGGBB 형식만 반환:`,
      }],
    });
    const m = msg.content[0].text.trim().match(/#[0-9A-Fa-f]{6}/);
    return m ? m[0] : null;
  } catch { return null; }
}

// ─── 레퍼런스 이미지 분석 ───
async function analyzeReferenceImages(images) {
  try {
    const content = [{
      type: 'text',
      text: `아래 레퍼런스 광고 이미지들을 분석해서 디자인 스타일 정보를 JSON으로 반환하라.

분석 항목:
- bg_hex: 배경 메인 컬러 (#RRGGBB 형식, 반드시 추출)
- accent_hex: 포인트/강조 컬러 (#RRGGBB 형식)
- headline_hex: 헤드라인 텍스트 컬러 (#RRGGBB 형식)
- cta_hex: CTA 버튼/바 컬러 (#RRGGBB 형식)
- style_mood: 전체 분위기 키워드 3개 (예: ["다이나믹","임팩트","직관적"])
- font_style: 폰트 무게감 (예: "heavy_bold", "medium_clean", "light_elegant")
- layout_type: 레이아웃 구조 설명 (예: "상단 훅+중앙 헤드라인+하단 수치카드+CTA바")
- design_notes: 카피 배치·시각 계층 특이사항 한 줄

JSON만 반환 (주석·설명 없이):
{"bg_hex":"","accent_hex":"","headline_hex":"","cta_hex":"","style_mood":[],"font_style":"","layout_type":"","design_notes":""}`,
    }];

    for (const imgData of images.slice(0, 3)) {
      const match = imgData.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
      }
    }

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content }],
    });
    return msg.content[0].text;
  } catch (e) {
    console.warn('[이미지 분석 실패]', e.message);
    return null;
  }
}

// ─── 소재 기본 정보 자동 추출 ───
async function extractPageInfo(pageContent) {
  const prompt = `아래 상세페이지 내용을 분석해서 META 광고 소재 기본 정보를 추출하라.

페이지 내용:
${pageContent}

추출 항목:
- target: 이 과정/서비스의 핵심 타겟 고객 (1-2문장, 구체적으로)
- usp1: 서비스·콘텐츠·커리큘럼 자체의 핵심 차별화 강점 1 (한 줄)
  절대 제외: 결제 조건(무이자 할부, 카드 할인), 가격/할인율, 기간 한정 이벤트, 수강료 정보
  포함 대상: 커리큘럼 방식, 강사 역량, 학습 성과, 취업/전환 지원, 독점 콘텐츠, 업계 인지도
- usp2: 서비스 자체의 차별화 강점 2 (위 기준 동일 적용)
- usp3: 서비스 자체의 차별화 강점 3 (위 기준 동일 적용)
- ad_set_message: 이 캠페인의 전체 메시지 방향 (1문장)
- creative_message: 이 소재에서 강조할 핵심 포인트 (1문장)

JSON만 반환:
{"target":"","usp1":"","usp2":"","usp3":"","ad_set_message":"","creative_message":""}`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0].text.trim();
  const match = raw.match(/\{[\s\S]+\}/);
  if (!match) throw new Error('소재 정보 자동 추출 실패');
  return JSON.parse(match[0]);
}

// ─── 카피 배리에이션 3종 생성 ───
async function extractAdDataVariations(pageContent, styleAnalysis, info, _attempt = 1) {
  const styleHint = styleAnalysis ? `\n\n## 레퍼런스 디자인 스타일 (반드시 참고)\n${styleAnalysis}\n→ 위 스타일 분위기에 맞는 카피 톤을 적용하라.` : '';
  const { target, usp1, usp2, usp3, ad_set_message, creative_message } = info;

  // 주예진 체크리스트 컨텍스트
  const checklistCtx = checklistContent ? `
## 주예진 콘텐츠 기준 — 광고 소재 필수 체크리스트 (모든 MUST 항목 충족 필수)
${checklistContent}

## 카피 작성 톤앤매너 (반드시 준수)
- 구어체·친근한 반말투 사용 / 딱딱한 문어체 완전 금지
- hook은 의문문·반문 형태 적극 활용 (예: "코딩 1도 몰라도 가능하다고?", "지금 안 하면 언제 해?")
- 타겟 공감 먼저 → 해결책/혜택 순서 (C6 필수)
- 숫자 혜택 반드시 포함 (C1 필수)
- 긴박감·희소성 트리거 포함 (C2: "선착순", "마감 임박", "지금 해야")
- 3초 후킹: 스크롤 중 멈추게 만드는 요소 필수
- 참고 패턴: "못 참지", "지금 해야 제일 싸요", "코딩 1도 모르던 문과생"

## 자기 검증 — 각 배리에이션 JSON에 반드시 포함 (11개 항목 평가)
카피 작성 후 아래 기준으로 스스로 평가해 각 배리에이션 JSON에 validation 필드를 추가하라:
- C1(숫자혜택): 할인율·가격·인원 등 숫자로 혜택 명시 여부
- C2(긴박감): "마감", "선착순", "지금 해야" 등 긴박감·희소성 트리거 포함 여부
- C3(짧은헤드): 헤드라인이 짧고 임팩트 있는가 (20자 이내 권장)
- C4(CTA): 행동 유도 문구 명시 여부
- C5(의문문): 의문문·반문으로 독자 호기심 자극 여부
- C6(공감먼저): 타겟 공감 먼저 → 해결책/혜택 순서 준수 여부
- V1(헤드강조): 헤드라인이 시각적으로 압도적으로 강조되는 구조인가
- V2(숫자강조): 핵심 숫자·키워드가 강조되는가
- V3(가독성): 배경-텍스트 가독성 확보 가능한가
- S1(구체수치): 수강생 수·조회수 등 구체적 수치로 소셜 증명 있는가
- P1(3초후킹): 3초 안에 혜택 파악 가능한 후킹 요소 있는가
→ "validation":{"C1":true/false,...11개...}, "validation_score":N(true 개수/11), "validation_fails":["C2: 이유"] 를 반드시 추가.
` : '';

  // 디자인 스펙 컨텍스트
  const designSpecCtx = designSpecContent ? `
## 디자인 스펙 — 시각 실행 기준 (반드시 준수)
${designSpecContent}
` : '';

  // Figma 검증 레이아웃 패턴 컨텍스트
  const figmaCtx = figmaStylesContent ? `
## Figma 검증 광고 레이아웃 패턴 (실제 집행 광고 기반 — 반드시 참고)
${figmaStylesContent}
→ 아래 JSON의 layout_type은 위 Figma 패턴명과 동일하게 지정할 것.
` : '';

  // 포토오버레이 3종 × 카피 앵글 3종 = 9가지 배리에이션
  const layoutSpec = `
## 배리에이션 — 총 9종 (포토오버레이 3종 × 카피 앵글 3종)
모든 배리에이션은 포토오버레이 계열이다. 배경 이미지 + 오버레이 + 텍스트 구조.

### 공통 필드 (9종 전부 동일)
hook(최대28자, 서브카피·상황공감), headline_line1(최대14자, 메인카피1줄),
headline_line2(최대14자, 메인카피2줄), cta_badge(이모지+최대12자), cta_text(최대24자, "→"로 끝)

### 포토오버레이-시네마틱형 (A1·A2·A3): 하단 다크 그라디언트 + 대형 헤드라인
배경이미지 하단 60%에 강한 다크 오버레이. 헤드라인이 80px 이상으로 화면 하단 압도.
- A1(혜택강조형): 구체적 혜택·수강생 성과·수치 전면 부각
- A2(공감형): 타겟 고민 먼저 공감 → 해결책으로 이어지는 흐름
- A3(소셜증명형): 수강생 수·후기·누적 성과로 사회적 증거 강조

### 포토오버레이-센터패널형 (B1·B2·B3): 중앙 반투명 패널 + 비네팅
배경 전체 비네팅(어두운 엣지) + 중앙 글래스모픽 패널 안에 카피. 중심감 강함.
- B1(변화동기형): 수강 전→후 변화·성장 스토리
- B2(마감긴박형): 선착순·마감·지금 해야 하는 긴박감
- B3(기회비용형): 지금 안 하면 놓치는 것·미래 손해

### 포토오버레이-사이드형 (C1·C2·C3): 좌측 다크 그라디언트 + 세로 레이아웃
배경 좌측 70%에 다크 사이드 그라디언트. 텍스트 좌정렬, 상단→하단 흐름.
- C1(호기심자극형): 의외성·반전·질문으로 스크롤 멈추게
- C2(결단촉구형): 결심·다짐·지금 시작하는 결단 응원
- C3(긴박행동형): 즉각 행동을 끌어내는 강한 CTA

JSON 배열만 반환 (주석·설명 없이):
[
  {"variation_label":"A1 - 혜택강조형","brand":"","hook":"","headline_line1":"","headline_line2":"","cta_badge":"","cta_text":"","footnote":null,"layout_type":"포토오버레이-시네마틱형","validation":{"C1":true,"C2":true,"C3":true,"C4":true,"C5":true,"C6":true,"V1":true,"V2":true,"V3":true,"S1":true,"P1":true},"validation_score":11,"validation_fails":[]},
  {"variation_label":"A2 - 공감형","brand":"","hook":"","headline_line1":"","headline_line2":"","cta_badge":"","cta_text":"","footnote":null,"layout_type":"포토오버레이-시네마틱형","validation":{"C1":true,"C2":true,"C3":true,"C4":true,"C5":true,"C6":true,"V1":true,"V2":true,"V3":true,"S1":true,"P1":true},"validation_score":11,"validation_fails":[]},
  {"variation_label":"A3 - 소셜증명형","brand":"","hook":"","headline_line1":"","headline_line2":"","cta_badge":"","cta_text":"","footnote":null,"layout_type":"포토오버레이-시네마틱형","validation":{"C1":true,"C2":true,"C3":true,"C4":true,"C5":true,"C6":true,"V1":true,"V2":true,"V3":true,"S1":true,"P1":true},"validation_score":11,"validation_fails":[]},
  {"variation_label":"B1 - 변화동기형","brand":"","hook":"","headline_line1":"","headline_line2":"","cta_badge":"","cta_text":"","footnote":null,"layout_type":"포토오버레이-센터패널형","validation":{"C1":true,"C2":true,"C3":true,"C4":true,"C5":true,"C6":true,"V1":true,"V2":true,"V3":true,"S1":true,"P1":true},"validation_score":11,"validation_fails":[]},
  {"variation_label":"B2 - 마감긴박형","brand":"","hook":"","headline_line1":"","headline_line2":"","cta_badge":"","cta_text":"","footnote":null,"layout_type":"포토오버레이-센터패널형","validation":{"C1":true,"C2":true,"C3":true,"C4":true,"C5":true,"C6":true,"V1":true,"V2":true,"V3":true,"S1":true,"P1":true},"validation_score":11,"validation_fails":[]},
  {"variation_label":"B3 - 기회비용형","brand":"","hook":"","headline_line1":"","headline_line2":"","cta_badge":"","cta_text":"","footnote":null,"layout_type":"포토오버레이-센터패널형","validation":{"C1":true,"C2":true,"C3":true,"C4":true,"C5":true,"C6":true,"V1":true,"V2":true,"V3":true,"S1":true,"P1":true},"validation_score":11,"validation_fails":[]},
  {"variation_label":"C1 - 호기심자극형","brand":"","hook":"","headline_line1":"","headline_line2":"","cta_badge":"","cta_text":"","footnote":null,"layout_type":"포토오버레이-사이드형","validation":{"C1":true,"C2":true,"C3":true,"C4":true,"C5":true,"C6":true,"V1":true,"V2":true,"V3":true,"S1":true,"P1":true},"validation_score":11,"validation_fails":[]},
  {"variation_label":"C2 - 결단촉구형","brand":"","hook":"","headline_line1":"","headline_line2":"","cta_badge":"","cta_text":"","footnote":null,"layout_type":"포토오버레이-사이드형","validation":{"C1":true,"C2":true,"C3":true,"C4":true,"C5":true,"C6":true,"V1":true,"V2":true,"V3":true,"S1":true,"P1":true},"validation_score":11,"validation_fails":[]},
  {"variation_label":"C3 - 긴박행동형","brand":"","hook":"","headline_line1":"","headline_line2":"","cta_badge":"","cta_text":"","footnote":null,"layout_type":"포토오버레이-사이드형","validation":{"C1":true,"C2":true,"C3":true,"C4":true,"C5":true,"C6":true,"V1":true,"V2":true,"V3":true,"S1":true,"P1":true},"validation_score":11,"validation_fails":[]}
]`;

  const prompt = `아래 정보를 바탕으로 META 인스타그램 1:1 광고소재 카피를 9가지 배리에이션으로 작성하라.

## 소재 기본 정보
- 과정 타겟: ${target}
- USP 1: ${usp1}
- USP 2: ${usp2}
- USP 3: ${usp3}
- 광고세트 메시지: ${ad_set_message}
- 소재 메시지: ${creative_message}

## 상세페이지 내용 (참고)
${pageContent}${styleHint}
${checklistCtx}${designSpecCtx}${figmaCtx}
${layoutSpec}`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 6000,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0].text.trim();
  // 코드블록(```json ... ```) 안의 배열 또는 raw 배열 모두 허용
  const stripped = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  const match = stripped.match(/\[[\s\S]+\]/);
  if (!match) {
    console.error('[파싱 실패] Claude 응답:', raw.slice(0, 500));
    throw new Error('배리에이션 데이터 파싱 실패 — 페이지 콘텐츠를 불러올 수 없거나 Claude 응답이 예상 형식과 다릅니다.');
  }
  const parsed = JSON.parse(match[0]);

  // 자동 재시도: validation_score < 8인 배리에이션이 있으면 1회 재생성
  if (_attempt === 1) {
    const hasLowScore = parsed.some(v => typeof v.validation_score === 'number' && v.validation_score < 8);
    if (hasLowScore) {
      const fails = [...new Set(parsed.flatMap(v => v.validation_fails || []))];
      console.log('[체크리스트 점수 미달 — 자동 재생성]', fails.join(', '));
      return extractAdDataVariations(pageContent, styleAnalysis, info, 2);
    }
  }

  return parsed;
}

// ─── 폰트 CDN/패밀리 헬퍼 ───
function getAdFontCSS(font = 'Pretendard') {
  const map = {
    'Pretendard': {
      link: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css',
      family: "'Pretendard','Apple SD Gothic Neo',sans-serif",
    },
    'Noto Sans KR': {
      link: 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;800;900&display=swap',
      family: "'Noto Sans KR',sans-serif",
    },
    'Nanum Gothic': {
      link: 'https://fonts.googleapis.com/css2?family=Nanum+Gothic:wght@400;700;800&display=swap',
      family: "'Nanum Gothic',sans-serif",
    },
    'Black Han Sans': {
      link: 'https://fonts.googleapis.com/css2?family=Black+Han+Sans&display=swap',
      family: "'Black Han Sans',sans-serif",
    },
  };
  return map[font] || map['Pretendard'];
}

// ─── HEX 유틸 ───
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function lighten(hex, amt) {
  const { r, g, b } = hexToRgb(hex);
  const clamp = v => Math.min(255, Math.max(0, v));
  const toHex = v => v.toString(16).padStart(2, '0');
  return `#${toHex(clamp(r + amt))}${toHex(clamp(g + amt))}${toHex(clamp(b + amt))}`;
}
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// ─── HTML 생성 (레이아웃 dispatcher) ───
function generateAdHTML(d, bgColor = '#1B5BD4', bgImageBase64 = null, cssBackground = null, font = 'Pretendard') {
  // 포토오버레이 3종 (메인)
  if (d.layout_type === '포토오버레이-시네마틱형') return generatePhotoOverlayHTML(d, bgColor, bgImageBase64, cssBackground, font);
  if (d.layout_type === '포토오버레이-센터패널형') return generatePhotoCenterPanelHTML(d, bgColor, bgImageBase64, cssBackground, font);
  if (d.layout_type === '포토오버레이-사이드형')   return generatePhotoSideHTML(d, bgColor, bgImageBase64, cssBackground, font);
  // 레거시 폴백
  if (d.layout_type === '포토오버레이형') return generatePhotoOverlayHTML(d, bgColor, bgImageBase64, cssBackground, font);
  if (d.layout_type === '헤드라인밴드형') return generateHeadlineBandHTML(d, bgColor, font);
  if (d.layout_type === '다크스플릿형')   return generateDarkSplitHTML(d, bgColor, font);
  if (d.layout_type === '이미지모자이크형') return generateImageMosaicHTML(d, bgColor, bgImageBase64, cssBackground, font);
  if (d.layout_type === '헤드카피형')    return generateHeadlineCopyHTML(d, bgColor, font);
  if (d.layout_type === '커뮤니티형')    return generateCommunityHTML(d, bgColor, font);
  return generatePhotoOverlayHTML(d, bgColor, bgImageBase64, cssBackground, font);
}

// ─── 헤드라인밴드형 (Figma 패턴 A) ───
// 검정 가로 밴드 + 시안 초대형 텍스트 / 크림→앰버 배경 / 하단 검정 CTA 바
function generateHeadlineBandHTML(d, bgColor = '#FFB300', font = 'Pretendard') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const hl1 = d.headline_line1 || '';
  const hl2 = d.headline_line2 || '';
  const hl1Size = hl1.length > 8 ? 78 : 96;
  const hl2Size = hl2.length > 8 ? 78 : 96;
  const band2Top = hl1Size === 96 ? 252 : 238;

  const statCards = (() => {
    if (!d.visual_stat1_value && !d.visual_stat2_value) return '';
    let html = '';
    if (d.visual_stat1_value) html += `
      <div style="background:rgba(0,0,0,0.09);border-radius:22px;padding:24px 32px;text-align:center;border:1.5px solid rgba(0,0,0,0.13);min-width:200px">
        <div data-field="visual_stat1_value" style="font-size:${d.visual_stat1_value.length > 4 ? 46 : 56}px;font-weight:900;color:#000;letter-spacing:-2px;line-height:1">${d.visual_stat1_value}</div>
        ${d.visual_stat1_label ? `<div data-field="visual_stat1_label" style="font-size:20px;font-weight:600;color:rgba(0,0,0,0.5);margin-top:6px">${d.visual_stat1_label}</div>` : ''}
      </div>`;
    if (d.visual_stat2_value) html += `
      <div style="background:rgba(0,0,0,0.09);border-radius:22px;padding:22px 30px;text-align:center;border:1.5px solid rgba(0,0,0,0.13)">
        <div data-field="visual_stat2_value" style="font-size:${d.visual_stat2_value.length > 4 ? 40 : 50}px;font-weight:900;color:#000;letter-spacing:-2px;line-height:1">${d.visual_stat2_value}</div>
        ${d.visual_stat2_label ? `<div data-field="visual_stat2_label" style="font-size:18px;font-weight:600;color:rgba(0,0,0,0.5);margin-top:6px">${d.visual_stat2_label}</div>` : ''}
      </div>`;
    return html;
  })();

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}</style>
</head>
<body>
<div style="width:1080px;height:1080px;position:relative;overflow:hidden;background:linear-gradient(168deg,#F0E8D5 0%,#F0E8D5 36%,#FFBE00 58%,#FF9500 100%)">

  <!-- 브랜드 태그 -->
  <div style="position:absolute;left:52px;top:42px;display:flex;align-items:center;gap:12px;z-index:10">
    <div style="width:30px;height:30px;background:#1a1a1a;border-radius:6px"></div>
    <span data-field="brand" style="font-size:26px;font-weight:700;color:#1a1a1a;letter-spacing:-0.5px">${d.brand || '브랜드'}</span>
  </div>

  <!-- 헤드라인 밴드 1 (검정 + 시안) -->
  <div style="position:absolute;left:0;top:110px;width:100%;background:#000;padding:12px 52px;z-index:5">
    <div data-field="headline_line1" style="font-size:${hl1Size}px;font-weight:900;color:#00E5FF;letter-spacing:-2.5px;line-height:1.06;white-space:nowrap;overflow:hidden;text-overflow:clip">${hl1}</div>
  </div>

  <!-- 헤드라인 밴드 2 (검정 + 시안) -->
  <div style="position:absolute;left:0;top:${band2Top}px;width:100%;background:#000;padding:12px 52px;z-index:5">
    <div data-field="headline_line2" style="font-size:${hl2Size}px;font-weight:900;color:#00E5FF;letter-spacing:-2.5px;line-height:1.06;white-space:nowrap;overflow:hidden;text-overflow:clip">${hl2}</div>
  </div>

  <!-- 훅 텍스트 (비주얼 영역 좌측) -->
  <div style="position:absolute;left:52px;top:460px;max-width:540px;z-index:6">
    <div data-field="hook" style="font-size:34px;font-weight:600;color:rgba(0,0,0,0.65);line-height:1.5;letter-spacing:-0.5px">${d.hook || ''}</div>
  </div>

  <!-- 수치 카드 (우측 중단) -->
  ${statCards ? `
  <div style="position:absolute;right:52px;top:430px;display:flex;flex-direction:column;gap:18px;z-index:6">
    ${statCards}
  </div>` : ''}

  <!-- 하단 검정 CTA 바 -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:130px;background:#000;display:flex;align-items:center;padding:0 52px;gap:20px;z-index:10">
    ${d.cta_badge ? `<span data-field="cta_badge" style="font-size:21px;font-weight:800;color:#00E5FF;background:rgba(0,229,255,0.15);border:1px solid rgba(0,229,255,0.35);padding:8px 20px;border-radius:28px;white-space:nowrap">${d.cta_badge}</span>` : ''}
    <span data-field="cta_text" style="font-size:28px;font-weight:700;color:#fff;letter-spacing:-0.5px;flex:1">${d.cta_text || '지금 바로 시작하기 →'}</span>
  </div>

</div>
</body>
</html>`;
}

// ─── 다크스플릿형 (Figma 패턴 B) ───
// 초록 그라디언트 상단 + 순검정 하단 / 노란 USP 하이라이트 바 / 흰색 헤드라인
function generateDarkSplitHTML(d, bgColor = '#00B140', font = 'Pretendard') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const hl1 = d.headline_line1 || d.headline || '';
  const hl2 = d.headline_line2 || d.sub_copy1 || '';
  const hlSize = Math.max(hl1.length, hl2.length) > 12 ? 46 : 56;
  const uspText = d.hook || 'USP 핵심 문구';
  const uspSize = uspText.length > 8 ? 36 : 44;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily};background:#000}</style>
</head>
<body>
<div style="width:1080px;height:1080px;position:relative;overflow:hidden;background:#000">

  <!-- 상단 초록 그라디언트 (55%) -->
  <div style="position:absolute;top:0;left:0;right:0;height:594px;background:linear-gradient(145deg,#00C853 0%,#00B140 28%,#004D20 62%,#001200 100%)"></div>

  <!-- 코드/UI 반투명 오버레이 -->
  <div style="position:absolute;top:0;left:0;right:0;height:594px;overflow:hidden;z-index:1;pointer-events:none">
    <div style="position:absolute;top:30px;right:30px;width:520px;height:210px;border-radius:14px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12)">
      <div style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;gap:8px">
        <div style="width:10px;height:10px;border-radius:50%;background:#ff5f57;opacity:0.7"></div>
        <div style="width:10px;height:10px;border-radius:50%;background:#febc2e;opacity:0.7"></div>
        <div style="width:10px;height:10px;border-radius:50%;background:#28c840;opacity:0.7"></div>
      </div>
      <div style="padding:16px 20px;font-family:monospace;font-size:15px;color:rgba(255,255,255,0.2);line-height:1.7">
        <div>const ad = await generate({</div>
        <div>&nbsp;&nbsp;target: <span style="color:rgba(0,229,255,0.4)">'${(d.brand||'Brand').slice(0,20)}'</span>,</div>
        <div>&nbsp;&nbsp;usp: <span style="color:rgba(255,243,0,0.4)">'${uspText.slice(0,18)}'</span></div>
        <div>});</div>
      </div>
    </div>
    <div style="position:absolute;top:260px;right:30px;width:520px;height:100px;border-radius:14px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08)"></div>
  </div>

  <!-- 제품/브랜드 아이콘 (좌상단) -->
  <div style="position:absolute;left:52px;top:44px;z-index:10">
    <div style="width:110px;height:110px;background:#fff;border-radius:24px;box-shadow:0 8px 36px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-size:56px;font-weight:900;color:#00B140">
      ${(d.brand || 'A').charAt(0)}
    </div>
  </div>

  <!-- 브랜드명 -->
  <div style="position:absolute;left:180px;top:64px;z-index:10">
    <div data-field="brand" style="font-size:26px;font-weight:700;color:#fff;letter-spacing:-0.5px">${d.brand || '브랜드'}</div>
    <div style="font-size:18px;color:rgba(255,255,255,0.55);margin-top:3px">AI 광고 자동화</div>
  </div>

  <!-- USP 노란 하이라이트 바 (경계 구역) -->
  <div style="position:absolute;left:52px;top:510px;z-index:10">
    <div style="background:#F5FF00;padding:11px 22px;display:inline-block;border-radius:7px">
      <div data-field="hook" style="font-size:${uspSize}px;font-weight:900;color:#000;letter-spacing:-1px;line-height:1;white-space:nowrap">${uspText}</div>
    </div>
  </div>

  <!-- 흰색 헤드라인 (하단 블랙 영역) -->
  <div style="position:absolute;left:52px;top:630px;right:52px;z-index:10">
    <div style="font-size:${hlSize}px;font-weight:800;color:#fff;letter-spacing:-1.5px;line-height:1.18">
      <span data-field="headline_line1">${hl1}</span>${hl2 ? `<br><span data-field="headline_line2">${hl2}</span>` : ''}
    </div>
  </div>

  <!-- CTA (우하단) -->
  <div style="position:absolute;bottom:52px;right:52px;left:52px;z-index:10;display:flex;justify-content:space-between;align-items:center">
    ${d.cta_badge ? `<span data-field="cta_badge" style="font-size:20px;font-weight:700;color:rgba(255,255,255,0.45)">${d.cta_badge}</span>` : '<span></span>'}
    <div data-field="cta_text" style="font-size:26px;font-weight:700;color:#00E676;letter-spacing:-0.5px">${d.cta_text || '지금 바로 시작하기 →'}</div>
  </div>

</div>
</body>
</html>`;
}

// ─── 이미지모자이크형 (Figma 패턴 C) ───
// 다크 네이비 + 도트 그리드 / 핫핑크 USP 뱃지 / 비주얼 모자이크 그리드
function generateImageMosaicHTML(d, bgColor = '#1A1A2E', bgImageBase64 = null, cssBackground = null, font = 'Pretendard') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const hl1 = d.headline_line1 || '';
  const hl2 = d.headline_line2 || '';
  const hlSize = Math.max(hl1.length, hl2.length) > 12 ? 58 : 70;

  // 모자이크 타일 색상 세트 (다크 계열 그라디언트)
  const tileStyles = [
    'background:linear-gradient(135deg,#2D1B4E,#1a1a3e)',
    'background:linear-gradient(135deg,#1B3A4E,#0d2030)',
    'background:linear-gradient(135deg,#2E1B1B,#1a0d0d)',
    'background:linear-gradient(135deg,#1B2E1B,#0d1a0d)',
    'background:linear-gradient(135deg,#2E2B1B,#1a180d)',
    'background:linear-gradient(135deg,#1B1B2E,#0d0d1a)',
  ];
  const tileLabels = ['모델샷', '제품샷', '컨셉 포토', '근접샷', '일상샷', '화보'];
  const tileEmojis = ['👩', '📦', '✨', '🔬', '🌿', '📸'];

  const gridHTML = tileStyles.map((style, i) => `
    <div style="flex:1;border-radius:12px;overflow:hidden;position:relative;min-height:180px;${style}">
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:42px;opacity:0.35">${tileEmojis[i]}</div>
      <div style="position:absolute;bottom:0;left:0;right:0;padding:8px 12px;background:rgba(0,0,0,0.4)">
        <span style="font-size:17px;font-weight:600;color:rgba(255,255,255,0.7)">${tileLabels[i]}</span>
      </div>
    </div>`).join('');

  // bgImageBase64 있으면 첫 타일에 실제 이미지 표시
  const firstTile = bgImageBase64
    ? `<div style="flex:1;border-radius:12px;overflow:hidden;position:relative;min-height:180px">
        <img src="${bgImageBase64}" style="width:100%;height:100%;object-fit:cover;object-position:center">
        <div style="position:absolute;bottom:0;left:0;right:0;padding:8px 12px;background:rgba(0,0,0,0.4)">
          <span style="font-size:17px;font-weight:600;color:rgba(255,255,255,0.7)">상세 이미지</span>
        </div>
      </div>`
    : tileStyles.map((style, i) => i === 0 ? `
    <div style="flex:1;border-radius:12px;overflow:hidden;position:relative;min-height:180px;${style}">
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:42px;opacity:0.35">${tileEmojis[0]}</div>
      <div style="position:absolute;bottom:0;left:0;right:0;padding:8px 12px;background:rgba(0,0,0,0.4)">
        <span style="font-size:17px;font-weight:600;color:rgba(255,255,255,0.7)">${tileLabels[0]}</span>
      </div>
    </div>` : '').join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}</style>
</head>
<body>
<div style="width:1080px;height:1080px;position:relative;overflow:hidden;background:${cssBackground || '#13132B'}">

  <!-- 도트 그리드 배경 패턴 -->
  <div style="position:absolute;inset:0;background-image:radial-gradient(circle,rgba(255,255,255,0.08) 1px,transparent 1px);background-size:32px 32px;z-index:0;pointer-events:none"></div>

  <!-- 브랜드 태그 -->
  <div style="position:absolute;left:52px;top:36px;display:flex;align-items:center;gap:12px;z-index:10">
    <div style="width:28px;height:28px;background:rgba(255,255,255,0.85);border-radius:6px"></div>
    <span data-field="brand" style="font-size:24px;font-weight:700;color:rgba(255,255,255,0.7);letter-spacing:-0.3px">${d.brand || '브랜드'}</span>
  </div>

  <!-- 상단 텍스트 영역 (35%) -->
  <div style="position:absolute;top:80px;left:52px;right:52px;z-index:10">

    <!-- 헤드라인 -->
    <div style="font-size:${hlSize}px;font-weight:900;color:#fff;letter-spacing:-2px;line-height:1.1;margin-bottom:24px">
      <span data-field="headline_line1">${hl1}</span>${hl2 ? `<br><span data-field="headline_line2">${hl2}</span>` : ''}
    </div>

    <!-- 훅 서브텍스트 -->
    ${d.hook ? `<div data-field="hook" style="font-size:24px;font-weight:500;color:rgba(255,255,255,0.55);margin-bottom:20px;letter-spacing:-0.3px">${d.hook}</div>` : ''}

    <!-- USP 핫핑크 뱃지들 -->
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      ${d.cta_badge ? `<span data-field="cta_badge" style="background:#FF00DD;color:#fff;font-size:24px;font-weight:700;padding:8px 22px;border-radius:30px;letter-spacing:-0.3px">${d.cta_badge}</span>` : ''}
      <span data-field="cta_text" style="background:#FF00DD;color:#fff;font-size:24px;font-weight:700;padding:8px 22px;border-radius:30px;letter-spacing:-0.3px">${d.cta_text ? d.cta_text.replace(' →','').slice(0,12) : '지금 시작'}</span>
    </div>
  </div>

  <!-- 이미지 그리드 (하단 65%) -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:630px;padding:16px 20px 20px;display:flex;flex-direction:column;gap:10px;z-index:5">
    <div style="display:flex;gap:10px;flex:1">
      ${bgImageBase64
        ? `<div style="flex:1.2;border-radius:12px;overflow:hidden;position:relative"><img src="${bgImageBase64}" style="width:100%;height:100%;object-fit:cover"><div style="position:absolute;bottom:0;left:0;right:0;padding:8px 12px;background:rgba(0,0,0,0.4)"><span style="font-size:17px;font-weight:600;color:rgba(255,255,255,0.8)">메인 이미지</span></div></div>`
        : `<div style="flex:1.2;border-radius:12px;overflow:hidden;position:relative;background:linear-gradient(135deg,#2D1B4E,#1a1a3e)"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:56px;opacity:0.3">👩</div><div style="position:absolute;bottom:0;left:0;right:0;padding:8px 12px;background:rgba(0,0,0,0.4)"><span style="font-size:17px;font-weight:600;color:rgba(255,255,255,0.7)">모델샷</span></div></div>`
      }
      <div style="flex:1;display:flex;flex-direction:column;gap:10px">
        <div style="flex:1;border-radius:12px;overflow:hidden;position:relative;background:linear-gradient(135deg,#1B3A4E,#0d2030)"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:44px;opacity:0.3">📦</div><div style="position:absolute;bottom:0;left:0;right:0;padding:6px 12px;background:rgba(0,0,0,0.4)"><span style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.7)">제품샷</span></div></div>
        <div style="flex:1;border-radius:12px;overflow:hidden;position:relative;background:linear-gradient(135deg,#2E1B1B,#1a0d0d)"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:44px;opacity:0.3">✨</div><div style="position:absolute;bottom:0;left:0;right:0;padding:6px 12px;background:rgba(0,0,0,0.4)"><span style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.7)">컨셉 포토</span></div></div>
      </div>
    </div>
    <div style="display:flex;gap:10px;height:170px">
      <div style="flex:1;border-radius:12px;overflow:hidden;position:relative;background:linear-gradient(135deg,#1B2E1B,#0d1a0d)"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:40px;opacity:0.3">🔬</div><div style="position:absolute;bottom:0;left:0;right:0;padding:6px 12px;background:rgba(0,0,0,0.4)"><span style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.7)">근접샷</span></div></div>
      <div style="flex:1;border-radius:12px;overflow:hidden;position:relative;background:linear-gradient(135deg,#2E2B1B,#1a180d)"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:40px;opacity:0.3">🌿</div><div style="position:absolute;bottom:0;left:0;right:0;padding:6px 12px;background:rgba(0,0,0,0.4)"><span style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.7)">일상샷</span></div></div>
      <div style="flex:1;border-radius:12px;overflow:hidden;position:relative;background:linear-gradient(135deg,#1B1B2E,#0d0d1a)"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:40px;opacity:0.3">📸</div><div style="position:absolute;bottom:0;left:0;right:0;padding:6px 12px;background:rgba(0,0,0,0.4)"><span style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.7)">화보</span></div></div>
    </div>
  </div>

</div>
</body>
</html>`;
}

// ─── 포토오버레이형 (피그마 템플릿 기반) ───
// 레이아웃: 피그마 node 3658:147 — 배경 이미지 + 하단 다크 오버레이 + 서브카피 + 메인카피
// 서브카피: Pretendard Bold 42px, left:62, top:~640
// 메인카피: Pretendard Bold 80px, 2줄 15자 이내, left:62, top:~740
function generatePhotoOverlayHTML(d, bgColor = '#1a1a1a', bgImageBase64 = null, cssBackground = null, font = 'Pretendard') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const lum = luminance(bgColor);
  const isDark = lum < 140;
  // 배경이 없으면 다크 시네마틱 그라디언트
  const bgBase = isDark ? bgColor : '#1a1a1a';
  const bgStyle = bgImageBase64
    ? `background:#000`
    : cssBackground
    ? `background:${cssBackground}`
    : `background:linear-gradient(155deg,${bgBase} 0%,#060606 100%)`;

  const ctaBadgeHtml = d.cta_badge
    ? `<span data-field="cta_badge" style="font-size:22px;font-weight:800;color:#fff;background:rgba(255,255,255,0.18);padding:5px 16px;border-radius:30px;white-space:nowrap;flex-shrink:0">${d.cta_badge}</span>`
    : '';

  const footHtml = d.footnote
    ? `<div style="position:absolute;bottom:96px;right:64px;font-size:20px;color:rgba(255,255,255,0.35);z-index:10">${d.footnote}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}</style>
</head>
<body>
<div style="width:1080px;height:1080px;position:relative;overflow:hidden;${bgStyle}">

  ${bgImageBase64 ? `
  <!-- OG 배경 이미지 -->
  <img src="${bgImageBase64}" style="position:absolute;inset:0;width:1080px;height:1080px;object-fit:cover;object-position:center top;z-index:0;pointer-events:none" />
  ` : cssBackground ? `` : `
  <!-- 다크 그라디언트 (OG 이미지 없을 때) -->
  <div style="position:absolute;top:180px;left:-40px;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle,${bgColor}55 0%,transparent 70%);z-index:0;pointer-events:none"></div>
  <div style="position:absolute;top:60px;right:-80px;width:440px;height:440px;border-radius:50%;background:radial-gradient(circle,${bgColor}33 0%,transparent 70%);z-index:0;pointer-events:none"></div>
  `}

  <!-- 하단 다크 오버레이 (텍스트 가독성 — 피그마 디자인 핵심) -->
  <div style="position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,0.08) 0%,rgba(0,0,0,0.12) 35%,rgba(0,0,0,0.62) 52%,rgba(0,0,0,0.90) 68%,rgba(0,0,0,0.97) 82%,#000 100%);z-index:1;pointer-events:none"></div>

  <!-- 브랜드 태그 (상단) -->
  <div style="position:absolute;left:62px;top:52px;display:flex;align-items:center;gap:10px;z-index:10">
    <div style="width:26px;height:26px;background:rgba(255,255,255,0.92);border-radius:5px;flex-shrink:0"></div>
    <span data-field="brand" style="font-size:23px;font-weight:700;color:#fff;letter-spacing:-0.3px;text-shadow:0 1px 4px rgba(0,0,0,0.5)">${d.brand || '브랜드'}</span>
  </div>

  <!-- 서브카피 (피그마: 42px, top≈688 비율 기준) -->
  <div data-field="hook" style="position:absolute;left:62px;top:634px;right:80px;z-index:10;font-size:40px;font-weight:700;color:rgba(255,255,255,0.82);letter-spacing:-0.84px;line-height:1.28;text-shadow:0 2px 8px rgba(0,0,0,0.6)">
    ${d.hook || ''}
  </div>

  <!-- 메인카피 (피그마: 80px Bold, 2줄 15자 이내, top≈786 비율) -->
  <div style="position:absolute;left:62px;top:736px;right:60px;z-index:10;font-size:80px;font-weight:900;color:#fff;letter-spacing:-2px;line-height:1.08;text-shadow:0 3px 12px rgba(0,0,0,0.7)">
    <span data-field="headline_line1">${d.headline_line1 || ''}</span><br><span data-field="headline_line2">${d.headline_line2 || ''}</span>
  </div>

  ${footHtml}

  <!-- CTA 바 -->
  <div style="position:absolute;bottom:0;left:0;right:0;padding:24px 62px;background:linear-gradient(90deg,#FF4B6E,#FF7040);display:flex;align-items:center;gap:14px;z-index:10;flex-shrink:0">
    ${ctaBadgeHtml}
    <span data-field="cta_text" style="font-size:26px;font-weight:700;color:#fff;letter-spacing:-0.5px;white-space:nowrap">${d.cta_text || '지금 바로 시작하기 →'}</span>
  </div>

</div>
</body>
</html>`;
}

// ─── 포토오버레이-센터패널형 ───
// 레이아웃: 배경이미지 전체 + 비네팅 + 중앙 글래스모픽 패널에 카피
function generatePhotoCenterPanelHTML(d, bgColor = '#1a1a1a', bgImageBase64 = null, cssBackground = null, font = 'Pretendard') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const bgBase = bgColor || '#1a1a1a';
  const bgStyle = bgImageBase64
    ? `background:#000`
    : cssBackground
    ? `background:${cssBackground}`
    : `background:linear-gradient(155deg,${bgBase} 0%,#050505 100%)`;

  const ctaBadgeHtml = d.cta_badge
    ? `<span data-field="cta_badge" style="display:inline-block;font-size:21px;font-weight:800;color:#fff;background:rgba(255,255,255,0.2);padding:5px 18px;border-radius:30px;white-space:nowrap;margin-bottom:20px">${d.cta_badge}</span>`
    : '';

  const hl1 = d.headline_line1 || '';
  const hl2 = d.headline_line2 || '';
  const hlSize = (hl1.length > 10 || hl2.length > 10) ? 72 : 84;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}</style>
</head>
<body>
<div style="width:1080px;height:1080px;position:relative;overflow:hidden;${bgStyle}">

  ${bgImageBase64 ? `
  <img src="${bgImageBase64}" style="position:absolute;inset:0;width:1080px;height:1080px;object-fit:cover;object-position:center;z-index:0;pointer-events:none" />
  ` : cssBackground ? `` : `
  <div style="position:absolute;top:0;left:0;right:0;bottom:0;background:radial-gradient(ellipse at 70% 30%,${bgBase}66 0%,transparent 65%);z-index:0"></div>
  `}

  <!-- 비네팅 오버레이 (엣지 전체 다크) -->
  <div style="position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 28%,rgba(0,0,0,0.55) 62%,rgba(0,0,0,0.88) 100%);z-index:1;pointer-events:none"></div>
  <!-- 상단 추가 어둠 -->
  <div style="position:absolute;top:0;left:0;right:0;height:200px;background:linear-gradient(to bottom,rgba(0,0,0,0.6),transparent);z-index:1;pointer-events:none"></div>

  <!-- 브랜드 태그 (상단) -->
  <div style="position:absolute;left:64px;top:54px;display:flex;align-items:center;gap:10px;z-index:10">
    <div style="width:26px;height:26px;background:rgba(255,255,255,0.92);border-radius:5px;flex-shrink:0"></div>
    <span data-field="brand" style="font-size:23px;font-weight:700;color:#fff;letter-spacing:-0.3px;text-shadow:0 1px 6px rgba(0,0,0,0.6)">${d.brand || '브랜드'}</span>
  </div>

  <!-- 중앙 글래스모픽 패널 -->
  <div style="position:absolute;left:64px;right:64px;top:50%;transform:translateY(-54%);z-index:10;
    background:rgba(10,10,10,0.62);
    border:1px solid rgba(255,255,255,0.13);
    border-radius:24px;
    padding:52px 60px 48px">

    <!-- 훅 (서브카피) -->
    <div data-field="hook" style="font-size:32px;font-weight:600;color:rgba(255,255,255,0.7);letter-spacing:-0.5px;line-height:1.4;margin-bottom:22px">${d.hook || ''}</div>

    <!-- 메인카피 -->
    <div style="font-size:${hlSize}px;font-weight:900;color:#fff;letter-spacing:-2.5px;line-height:1.06;margin-bottom:36px">
      <span data-field="headline_line1">${hl1}</span><br>
      <span data-field="headline_line2">${hl2}</span>
    </div>

    <!-- CTA 뱃지 + 텍스트 -->
    ${ctaBadgeHtml}
    <div style="display:flex;align-items:center;gap:12px">
      <span data-field="cta_text" style="font-size:26px;font-weight:700;color:#fff;letter-spacing:-0.3px">${d.cta_text || '지금 바로 시작하기 →'}</span>
    </div>
  </div>

</div>
</body>
</html>`;
}

// ─── 포토오버레이-사이드형 ───
// 레이아웃: 배경이미지 + 좌측 다크 그라디언트 + 상단→하단 세로 흐름 텍스트
function generatePhotoSideHTML(d, bgColor = '#1a1a1a', bgImageBase64 = null, cssBackground = null, font = 'Pretendard') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const bgBase = bgColor || '#1a1a1a';
  const bgStyle = bgImageBase64
    ? `background:#000`
    : cssBackground
    ? `background:${cssBackground}`
    : `background:linear-gradient(135deg,${bgBase} 0%,#080808 100%)`;

  const ctaBadgeHtml = d.cta_badge
    ? `<span data-field="cta_badge" style="font-size:20px;font-weight:800;color:#fff;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.25);padding:6px 18px;border-radius:30px;white-space:nowrap;flex-shrink:0">${d.cta_badge}</span>`
    : '';

  const hl1 = d.headline_line1 || '';
  const hl2 = d.headline_line2 || '';
  const hlSize = (hl1.length > 10 || hl2.length > 10) ? 74 : 88;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}</style>
</head>
<body>
<div style="width:1080px;height:1080px;position:relative;overflow:hidden;${bgStyle}">

  ${bgImageBase64 ? `
  <img src="${bgImageBase64}" style="position:absolute;inset:0;width:1080px;height:1080px;object-fit:cover;object-position:right center;z-index:0;pointer-events:none" />
  ` : cssBackground ? `` : `
  <div style="position:absolute;top:0;right:0;width:500px;height:100%;background:radial-gradient(ellipse at 80% 50%,${bgBase}44 0%,transparent 70%);z-index:0"></div>
  `}

  <!-- 좌측 사이드 다크 그라디언트 -->
  <div style="position:absolute;inset:0;background:linear-gradient(to right,rgba(0,0,0,0.94) 0%,rgba(0,0,0,0.82) 38%,rgba(0,0,0,0.48) 62%,rgba(0,0,0,0.1) 80%,transparent 100%);z-index:1;pointer-events:none"></div>
  <!-- 하단 어둠 (CTA 영역) -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:160px;background:linear-gradient(to bottom,transparent,rgba(0,0,0,0.85));z-index:1;pointer-events:none"></div>

  <!-- 브랜드 태그 (상단 좌) -->
  <div style="position:absolute;left:64px;top:56px;display:flex;align-items:center;gap:10px;z-index:10">
    <div style="width:24px;height:24px;background:rgba(255,255,255,0.9);border-radius:4px;flex-shrink:0"></div>
    <span data-field="brand" style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-0.3px">${d.brand || '브랜드'}</span>
  </div>

  <!-- 훅 (중상단) -->
  <div data-field="hook" style="position:absolute;left:64px;top:200px;right:420px;z-index:10;
    font-size:36px;font-weight:600;color:rgba(255,255,255,0.72);letter-spacing:-0.8px;line-height:1.4">${d.hook || ''}</div>

  <!-- 메인카피 (중앙 좌) -->
  <div style="position:absolute;left:64px;top:380px;right:380px;z-index:10;
    font-size:${hlSize}px;font-weight:900;color:#fff;letter-spacing:-2.5px;line-height:1.06">
    <span data-field="headline_line1">${hl1}</span><br>
    <span data-field="headline_line2">${hl2}</span>
  </div>

  <!-- 구분선 -->
  <div style="position:absolute;left:64px;bottom:140px;width:280px;height:2px;background:rgba(255,255,255,0.25);z-index:10"></div>

  <!-- CTA 영역 (하단 좌) -->
  <div style="position:absolute;left:64px;bottom:52px;display:flex;align-items:center;gap:14px;z-index:10">
    ${ctaBadgeHtml}
    <span data-field="cta_text" style="font-size:24px;font-weight:700;color:#fff;letter-spacing:-0.3px;white-space:nowrap">${d.cta_text || '지금 바로 시작하기 →'}</span>
  </div>

</div>
</body>
</html>`;
}

// ─── 수치카드형 ───
function generateStatCardHTML(d, bgColor = '#1B5BD4', cssBackground = null, font = 'Pretendard') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  // 밝기에 따라 텍스트/카드 색상 결정
  const lum = luminance(bgColor);
  const isDark = lum < 140;
  const lightEnd = lighten(bgColor, isDark ? 40 : -30);
  const pal = {
    bg:       cssBackground || `linear-gradient(160deg,${bgColor},${lightEnd})`,
    burst:    'rgba(255,255,255,0.15)',
    headline: isDark ? '#FFD0A0' : '#1a1a1a',
    hook:     isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.7)',
    card_bg:  isDark ? '#fff' : 'rgba(255,255,255,0.9)',
    card_text: bgColor,
    cta:      'linear-gradient(90deg,#FF4B6E,#FF7040)',
  };

  const visualCards = (() => {
    if (!d.visual_stat1_value && !d.visual_stat2_value) {
      return `<div style="flex:1;height:220px;border-radius:20px;background:rgba(255,255,255,0.1);border:1.5px solid rgba(255,255,255,0.25)"></div>`;
    }
    let cards = '';
    if (d.visual_stat1_value) {
      cards += `<div style="flex:1;height:220px;border-radius:20px;background:${pal.card_bg};box-shadow:0 20px 50px rgba(0,0,0,0.25);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px">
        <div data-field="visual_stat1_value" style="font-size:${d.visual_stat1_value.length > 4 ? 52 : 64}px;font-weight:900;letter-spacing:-3px;color:${pal.card_text};line-height:1">${d.visual_stat1_value}</div>
        ${d.visual_stat1_label ? `<div data-field="visual_stat1_label" style="font-size:18px;font-weight:600;color:${pal.card_text};opacity:0.6">${d.visual_stat1_label}</div>` : ''}
      </div>`;
    }
    if (d.visual_stat2_value) {
      cards += `<div style="flex:0.7;height:220px;border-radius:20px;background:${pal.card_bg};box-shadow:0 20px 50px rgba(0,0,0,0.25);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px">
        <div data-field="visual_stat2_value" style="font-size:${d.visual_stat2_value.length > 4 ? 44 : 56}px;font-weight:900;letter-spacing:-3px;color:${pal.card_text};line-height:1">${d.visual_stat2_value}</div>
        ${d.visual_stat2_label ? `<div data-field="visual_stat2_label" style="font-size:16px;font-weight:600;color:${pal.card_text};opacity:0.6">${d.visual_stat2_label}</div>` : ''}
      </div>`;
    }
    return cards;
  })();

  const footnoteHtml = d.footnote
    ? `<div style="font-size:22px;color:rgba(255,255,255,0.5);text-align:right;padding:0 64px 12px">${d.footnote}</div>`
    : '';

  const ctaBadgeHtml = d.cta_badge
    ? `<div data-field="cta_badge" style="font-size:24px;font-weight:800;color:#fff;background:rgba(0,0,0,0.18);padding:6px 18px;border-radius:30px;white-space:nowrap">${d.cta_badge}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
</style>
</head>
<body>
<div style="width:1080px;height:1080px;background:${pal.bg};position:relative;display:flex;flex-direction:column;overflow:hidden">

  <!-- 버스트 -->
  <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%,${pal.burst} 0%,transparent 65%);pointer-events:none"></div>

  <!-- 컨페티 도트 -->
  <div style="position:absolute;width:14px;height:14px;background:#4ADE80;border-radius:50%;top:48%;left:8%"></div>
  <div style="position:absolute;width:10px;height:10px;background:#FACC15;border-radius:50%;top:55%;left:14%"></div>
  <div style="position:absolute;width:16px;height:16px;background:#FB923C;border-radius:50%;top:42%;right:10%"></div>
  <div style="position:absolute;width:10px;height:10px;background:#A78BFA;border-radius:50%;top:60%;right:16%"></div>

  <!-- 콘텐츠 -->
  <div style="flex:1;display:flex;flex-direction:column;padding:56px 64px 24px;position:relative;z-index:1">

    <!-- 브랜드 -->
    <div style="font-size:26px;font-weight:700;color:#fff;margin-bottom:32px;display:flex;align-items:center;gap:10px">
      <div style="width:28px;height:28px;background:rgba(255,255,255,0.9);border-radius:6px;flex-shrink:0"></div>
      <span data-field="brand">${d.brand || '브랜드'}</span>
    </div>

    <!-- 훅 -->
    <div data-field="hook" style="font-size:30px;font-weight:500;color:${pal.hook};margin-bottom:14px;letter-spacing:-0.5px">${d.hook || ''}</div>

    <!-- 헤드라인 -->
    <div style="font-size:80px;font-weight:900;line-height:1.08;color:${pal.headline};letter-spacing:-2px">
      <span data-field="headline_line1">${d.headline_line1 || ''}</span><br><span data-field="headline_line2">${d.headline_line2 || ''}</span>
    </div>

    <!-- 비주얼 카드 -->
    <div style="flex:1;display:flex;align-items:center;gap:24px;padding:20px 0">
      ${visualCards}
    </div>
  </div>

  ${footnoteHtml}

  <!-- CTA 바 -->
  <div style="width:100%;padding:26px 64px;background:${pal.cta};display:flex;align-items:center;gap:12px;flex-shrink:0">
    ${ctaBadgeHtml}
    <div data-field="cta_text" style="font-size:27px;font-weight:700;color:#fff;letter-spacing:-0.5px;white-space:nowrap">${d.cta_text || '지금 바로 시작하기 →'}</div>
  </div>

</div>
</body>
</html>`;
}

// ─── 레퍼런스 이미지 기반 HTML 생성 (Claude Vision) ───
async function generateVariationsHTMLFromRef(adDataList, refImageBase64, bgColor) {
  try {
    const match = refImageBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('이미지 형식 오류');

    const varsText = adDataList.slice(0, 3).map((d, i) =>
      `[버전 ${['A','B','C'][i]} - ${d.variation_label}]\n${JSON.stringify(d)}`
    ).join('\n\n');

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } },
          {
            type: 'text',
            text: `이 레퍼런스 광고 이미지의 레이아웃 구조(요소 위치·크기 비율·여백·시각 계층)를 최대한 유지하면서,
아래 카피 데이터 3종으로 1080×1080 HTML 광고소재 3개를 생성하라.

## 카피 데이터 3종
${varsText}

## 생성 규칙
- 캔버스: width:1080px; height:1080px; overflow:hidden 고정
- 반드시 포함: <link href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css" rel="stylesheet">
- 배경 메인 컬러: ${bgColor} (레퍼런스 색상 대신 이 컬러 기반으로 적용)
- 이미지·사진 영역은 반투명 색상 블록 또는 그라디언트로 대체
- 인라인 CSS만 사용 (외부 파일 없이)
- 각 HTML은 완전한 독립 문서 (<!DOCTYPE html>~</html>)

## 출력 형식 (이 구분자를 정확히 사용)
===A===
[A 버전 전체 HTML]
===B===
[B 버전 전체 HTML]
===C===
[C 버전 전체 HTML]`,
          },
        ],
      }],
    });

    const text = msg.content[0].text;
    const extract = (marker, next) => {
      const re = new RegExp(`===${marker}===([\\s\\S]*?)(?=====${next}===|$)`);
      const m = text.match(re);
      if (!m) return null;
      const h = m[1].match(/<!DOCTYPE html[\s\S]*?<\/html>/i);
      return h ? h[0] : m[1].trim() || null;
    };

    // 레퍼런스 기반 HTML (앞 3개) + 나머지는 표준 생성
    const refHtmls = [
      extract('A', 'B') || generateAdHTML(adDataList[0], bgColor),
      extract('B', 'C') || generateAdHTML(adDataList[1], bgColor),
      extract('C', 'ZZZEND') || generateAdHTML(adDataList[2], bgColor),
    ];
    const extraHtmls = adDataList.slice(3).map(d => generateAdHTML(d, bgColor));
    return [...refHtmls, ...extraHtmls];
  } catch (e) {
    console.warn('[레퍼런스 HTML 생성 실패, 폴백]', e.message);
    return adDataList.map(d => generateAdHTML(d, bgColor));
  }
}

// ─── 헤드카피+서브카피형 ───
function generateHeadlineCopyHTML(d, bgColor = '#1B5BD4', font = 'Pretendard') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const lum = luminance(bgColor);
  const isDark = lum < 140;
  const lightEnd = lighten(bgColor, isDark ? 45 : -35);
  const pal = {
    bg:       `linear-gradient(150deg,${bgColor},${lightEnd})`,
    burst:    'rgba(255,255,255,0.12)',
    headline: isDark ? '#FFFFFF' : '#1a1a1a',
    hook:     isDark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.6)',
    sub:      isDark ? 'rgba(255,255,255,0.88)' : 'rgba(20,20,20,0.82)',
    check:    '#4ADE80',
    cta:      'linear-gradient(90deg,#FF4B6E,#FF7040)',
  };

  const ctaBadgeHtml = d.cta_badge
    ? `<div data-field="cta_badge" style="font-size:24px;font-weight:800;color:#fff;background:rgba(0,0,0,0.18);padding:6px 18px;border-radius:30px;white-space:nowrap">${d.cta_badge}</div>`
    : '';
  const footnoteHtml = d.footnote
    ? `<div style="font-size:20px;color:rgba(255,255,255,0.4);text-align:right;padding:0 64px 10px">${d.footnote}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}</style>
</head>
<body>
<div style="width:1080px;height:1080px;background:${pal.bg};position:relative;display:flex;flex-direction:column;overflow:hidden">
  <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 30% 40%,${pal.burst} 0%,transparent 60%);pointer-events:none"></div>
  <div style="flex:1;display:flex;flex-direction:column;padding:68px 80px 24px;position:relative;z-index:1">
    <div style="font-size:26px;font-weight:700;color:#fff;margin-bottom:40px;display:flex;align-items:center;gap:10px">
      <div style="width:28px;height:28px;background:rgba(255,255,255,0.9);border-radius:6px;flex-shrink:0"></div>
      <span data-field="brand">${d.brand || '브랜드'}</span>
    </div>
    <div data-field="hook" style="font-size:28px;font-weight:500;color:${pal.hook};margin-bottom:18px;letter-spacing:-0.3px">${d.hook || ''}</div>
    <div data-field="headline" style="font-size:96px;font-weight:900;line-height:1.02;color:${pal.headline};letter-spacing:-4px;margin-bottom:56px">${d.headline || ''}</div>
    <div style="display:flex;flex-direction:column;gap:22px">
      ${[d.sub_copy1, d.sub_copy2, d.sub_copy3].filter(Boolean).map((copy, idx) => `
      <div style="display:flex;align-items:center;gap:18px">
        <div style="width:30px;height:30px;border-radius:50%;background:${pal.check};flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;font-weight:900">✓</div>
        <div data-field="sub_copy${idx+1}" style="font-size:34px;font-weight:600;color:${pal.sub};letter-spacing:-0.5px">${copy}</div>
      </div>`).join('')}
    </div>
  </div>
  ${footnoteHtml}
  <div style="width:100%;padding:26px 64px;background:${pal.cta};display:flex;align-items:center;gap:12px;flex-shrink:0">
    ${ctaBadgeHtml}
    <div data-field="cta_text" style="font-size:27px;font-weight:700;color:#fff;letter-spacing:-0.5px;white-space:nowrap">${d.cta_text || '지금 바로 시작하기 →'}</div>
  </div>
</div>
</body>
</html>`;
}

// ─── 커뮤니티/X형 ───
function generateCommunityHTML(d, bgColor = '#1B5BD4', font = 'Pretendard') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const lum = luminance(bgColor);
  const isDark = lum < 140;
  const lightEnd = lighten(bgColor, isDark ? 35 : -25);
  const textMain = '#0f1923';
  const textSub  = '#536471';

  const bodyLines = [d.body_line1, d.body_line2, d.body_line3, d.body_line4]
    .filter(Boolean)
    .map(line => `<div style="font-size:30px;font-weight:500;color:${textMain};line-height:1.5">${line}</div>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}</style>
</head>
<body>
<div style="width:1080px;height:1080px;background:linear-gradient(150deg,${bgColor},${lightEnd});position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden">
  <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 50%,rgba(255,255,255,0.13) 0%,transparent 65%);pointer-events:none"></div>
  <div style="width:900px;background:rgba(255,255,255,0.97);border-radius:28px;box-shadow:0 48px 96px rgba(0,0,0,0.35);padding:60px 68px;position:relative;z-index:1">
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:36px">
      <div style="width:68px;height:68px;border-radius:50%;background:${bgColor};flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:900;color:#fff">${(d.brand || 'B').charAt(0)}</div>
      <div>
        <div data-field="brand" style="font-size:27px;font-weight:800;color:${textMain}">${d.brand || '브랜드'}</div>
        <div style="font-size:22px;color:${textSub}">${d.account_handle || '@brand'}</div>
      </div>
      <div style="margin-left:auto;background:${bgColor};color:#fff;border-radius:30px;padding:10px 30px;font-size:22px;font-weight:700">팔로우</div>
    </div>
    <div data-field="hook" style="font-size:40px;font-weight:800;color:${textMain};line-height:1.3;margin-bottom:28px;border-left:5px solid ${bgColor};padding-left:22px;letter-spacing:-1px">"${d.quote_hook || ''}"</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:36px">${bodyLines}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding-top:24px;border-top:1.5px solid #e7e9ea">
      <div style="display:flex;gap:28px;color:${textSub};font-size:22px">
        <span>🔁 <strong style="color:${textMain}">2.4K</strong></span>
        <span>❤️ <strong style="color:${textMain}">8.1K</strong></span>
        <span>💬 <strong style="color:${textMain}">342</strong></span>
      </div>
      <div data-field="cta_text" style="background:${bgColor};color:#fff;border-radius:30px;padding:12px 32px;font-size:22px;font-weight:700;white-space:nowrap">${d.cta_text || '지금 확인하기 →'}</div>
    </div>
  </div>
</div>
</body>
</html>`;
}

// ─── AI 디자인 제안 ───
app.post('/api/suggest-design', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다' });
  try {
    const { text: pageContent, themeColor } = await fetchPageContent(url);
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `아래 상세페이지 내용을 분석해서 META 인스타그램 광고소재 디자인 제안을 JSON으로 반환하라.

페이지 내용:
${pageContent.slice(0, 1500)}
${themeColor ? `\n페이지 테마컬러: ${themeColor}` : ''}

JSON만 반환 (설명 없이):
{
  "bg_keywords_ko": "배경 이미지 검색어 한국어 3단어 콤마 구분",
  "bg_keywords_en": "background image search query English 3-4 words",
  "copy_tone": "카피 톤앤매너 짧게 (예: 친근한 공감형)",
  "copy_tone_desc": "이 톤으로 작성할 때 핵심 포인트 1문장",
  "color_direction": "배경 컬러 방향 설명 (예: 딥 네이비 계열 — 신뢰·전문성)",
  "color_hex": "#RRGGBB",
  "target": "핵심 타겟 1-2문장",
  "hook_suggestion": "추천 훅 문구 의문문 또는 반문형 25자 이내"
}`,
      }],
    });
    const raw = msg.content[0].text.trim();
    const match = raw.match(/\{[\s\S]+\}/);
    if (!match) throw new Error('AI 제안 파싱 실패');
    const suggestion = JSON.parse(match[0]);
    if (themeColor && !suggestion.color_hex) suggestion.color_hex = themeColor;
    console.log('[AI 제안 완료]', suggestion.copy_tone, suggestion.color_hex);
    res.json(suggestion);
  } catch (err) {
    console.error('[AI 제안 오류]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Unsplash 이미지 검색 ───
app.get('/api/search-unsplash', async (req, res) => {
  const { q, per_page = 12 } = req.query;
  if (!q) return res.status(400).json({ error: '검색어가 필요합니다' });
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) {
    return res.status(503).json({
      error: 'UNSPLASH_ACCESS_KEY가 설정되지 않았습니다.',
      setup_required: true,
    });
  }
  try {
    const apiUrl = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=${per_page}&orientation=squarish`;
    const r = await fetch(apiUrl, {
      headers: { Authorization: `Client-ID ${accessKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Unsplash API HTTP ${r.status}`);
    const data = await r.json();
    const photos = (data.results || []).map(p => ({
      id: p.id,
      thumb: p.urls.small,
      regular: p.urls.regular,
      alt: p.alt_description || p.description || '',
      credit: p.user.name,
    }));
    res.json({ photos });
  } catch (err) {
    console.error('[Unsplash 오류]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── 광고 HTML 임시 프리뷰 저장소 (메모리) ───
const previewStore = new Map();

app.post('/api/preview', (req, res) => {
  const { html } = req.body;
  if (!html) return res.status(400).json({ error: 'HTML이 필요합니다' });
  const id = Math.random().toString(36).slice(2, 12);
  previewStore.set(id, { html, ts: Date.now() });
  setTimeout(() => previewStore.delete(id), 60 * 60 * 1000); // 1시간 후 삭제
  console.log('[프리뷰 저장]', id);
  res.json({ previewUrl: `${req.protocol}://${req.get('host')}/preview/${id}` });
});

app.get('/preview/:id', (req, res) => {
  const id = req.params.id;
  const entry = previewStore.get(id);
  if (!entry) return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>만료됨</title></head><body style="font-family:sans-serif;text-align:center;padding:80px;color:#666"><h2>⏰ 프리뷰가 만료됐습니다</h2><p>AdCraft에서 다시 생성해주세요</p></body></html>`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(entry.html);
});

// ══════════════════════════════════════════════════════
//  AI 이미지 생성 기능 (Pollinations.ai + Unsplash 폴백)
// ══════════════════════════════════════════════════════

// ─── Claude → 이미지 프롬프트 생성 ───
app.post('/api/generate-image-prompt', async (req, res) => {
  const { adData, formInputs, userHint } = req.body;
  if (!adData && !formInputs && !userHint) return res.status(400).json({ error: 'adData, formInputs, 또는 userHint 필요' });

  // userHint만 있는 경우 빠른 발전 모드 (Haiku 사용)
  if (userHint && !adData && !formInputs) {
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: `사용자 입력 "${userHint}"을 Instagram 1:1 광고 배경 이미지 생성용 영어 프롬프트로 발전시켜라. 어두운 톤, 텍스트 가독성 확보, 추상적 배경. 마크다운 금지, 제목 금지, 2-3문장 순수 텍스트만:` }],
      });
      // 마크다운 헤더/불필요한 줄 제거
      const raw = msg.content[0].text.trim().replace(/^#+\s+[^\n]*\n*/g, '').trim();
      return res.json({ prompt: raw });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // adData(결과 기반) 또는 formInputs(입력 필드 기반) 양쪽 지원
  let brand, hook, headline, contextDesc;
  if (adData) {
    brand = adData.brand || '브랜드';
    hook = adData.hook || '';
    headline = [adData.headline_line1, adData.headline_line2, adData.headline].filter(Boolean).join(' ');
    contextDesc = `배리에이션: ${adData.variation_label || ''}, 훅: ${hook}, 헤드라인: ${headline}`;
  } else {
    const hostname = formInputs.url ? (() => { try { return new URL(formInputs.url).hostname.replace('www.', ''); } catch { return '브랜드'; } })() : '브랜드';
    brand = hostname;
    const usps = [formInputs.usp1, formInputs.usp2, formInputs.usp3].filter(Boolean).join(', ');
    contextDesc = [
      formInputs.target && `타겟: ${formInputs.target}`,
      usps && `USP: ${usps}`,
      formInputs.ad_set_message && `캠페인 메시지: ${formInputs.ad_set_message}`,
    ].filter(Boolean).join(' | ');
  }

  const hintLine = userHint ? `\n- 사용자 추가 힌트: ${userHint}` : '';
  const claudePrompt = `아래 META 인스타그램 광고소재를 위한 AI 이미지 생성 프롬프트를 영어로 작성하라.

광고 정보:
- 브랜드/도메인: ${brand}
- 광고 컨텍스트: ${contextDesc || '프리미엄 교육/서비스 광고'}${hintLine}

요구사항:
1. 텍스트가 올라갈 배경 이미지이므로 복잡하지 않고 깔끔하게
2. 어두운 톤 필수 (검정/네이비/진한 퍼플 계열 그라디언트) — 흰 카피 가독성 우선
3. 추상적 디자인: 빛 효과, 기하학 패턴, 부드러운 bokeh, 그라디언트 등 활용
4. 1:1 비율, 1080×1080 Instagram 광고 배경
5. 브랜드/서비스 특성에 맞는 시각적 모티프 활용

이미지 프롬프트 (영어, 2-3문장만, 기호 없이 순수 텍스트):`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: claudePrompt }],
    });
    res.json({ prompt: msg.content[0].text.trim() });
  } catch (err) {
    console.error('[프롬프트 생성 실패]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Pollinations.ai + Unsplash 폴백으로 이미지 생성 ───
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt 필요' });

  console.log('[🎨 이미지 생성] 시작 | 프롬프트:', prompt.slice(0, 80) + '...');

  // 1순위: Pollinations.ai (무료, API 키 불필요, FLUX 모델)
  try {
    const seed = Math.floor(Math.random() * 99999);
    const encoded = encodeURIComponent(prompt);
    const polUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1080&height=1080&nologo=true&seed=${seed}&model=flux`;

    console.log('[🌸 Pollinations] 요청 중...');
    const polRes = await fetch(polUrl, { signal: AbortSignal.timeout(60000) });

    if (polRes.ok) {
      const contentType = polRes.headers.get('content-type') || 'image/jpeg';
      const arrayBuffer = await polRes.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      console.log('[🌸 Pollinations] 성공 | 크기:', Math.round(arrayBuffer.byteLength / 1024) + 'KB');
      return res.json({
        imageData: `data:${contentType};base64,${base64}`,
        model: 'Pollinations (FLUX)',
        type: 'image',
      });
    } else {
      console.warn('[Pollinations 실패]', polRes.status, polRes.statusText);
    }
  } catch (err) {
    console.warn('[Pollinations 오류]', err.message);
  }

  // Pollinations 실패 시 에러 반환
  return res.status(500).json({ error: 'Pollinations 이미지 생성에 실패했습니다. 잠시 후 다시 시도해주세요.' });
});

// ─── 배경 이미지 적용 후 HTML 재생성 ───
app.post('/api/regenerate-with-bg', (req, res) => {
  const { adData, bgColor, bgImageBase64, cssBackground, font } = req.body;
  if (!adData) return res.status(400).json({ error: 'adData 필요' });
  try {
    const html = generateAdHTML(adData, bgColor || '#1B5BD4', bgImageBase64 || null, cssBackground || null, font || 'Pretendard');
    res.json({ html });
  } catch (err) {
    console.error('[HTML 재생성 실패]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('  AI 광고소재 자동화');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✅ 설정됨' : '❌ ANTHROPIC_API_KEY 필요'}`);
  console.log(`  Gemini:    ${process.env.GEMINI_API_KEY ? '✅ 설정됨' : '⚠️  GEMINI_API_KEY 없음 (이미지 생성 비활성)'}`);
  console.log('='.repeat(50));
});
