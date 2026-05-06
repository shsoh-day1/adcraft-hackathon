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

// CORS — Figma 플러그인 (null origin / figma.com) + 로컬 개발 허용
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// index.html은 항상 최신 버전으로 (CDN/브라우저 캐시 방지)
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(join(__dirname, 'public', 'index.html'));
});
app.use(express.static(join(__dirname, 'public'), { maxAge: 0 }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── 🗄 Supabase REST API 헬퍼 ───
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

async function supabaseQuery(table, method = 'GET', body = null, queryParams = '') {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { data: null, error: 'Supabase not configured' };
  const url = `${SUPABASE_URL}/rest/v1/${table}${queryParams}`;
  const options = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : '',
    },
  };
  if (body) options.body = JSON.stringify(body);
  try {
    const res = await fetch(url, options);
    const data = await res.json();
    if (!res.ok) return { data: null, error: data.message || data.error || 'Supabase error' };
    return { data: Array.isArray(data) ? data : data, error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

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

// ─── 레이아웃 레퍼런스 저장소 (Vercel: 인메모리, 로컬: 파일) ───
const LAYOUTS_FILE = join(__dirname, 'layouts.json');
let _layoutsCache = null;
function readLayouts() {
  if (_layoutsCache !== null) return _layoutsCache;
  if (existsSync(LAYOUTS_FILE)) {
    try { _layoutsCache = JSON.parse(readFileSync(LAYOUTS_FILE, 'utf8')); return _layoutsCache; } catch {}
  }
  _layoutsCache = [];
  return _layoutsCache;
}
function writeLayouts(arr) {
  _layoutsCache = arr;
  try { writeFileSync(LAYOUTS_FILE, JSON.stringify(arr, null, 2), 'utf8'); } catch {}
}

// ─── 커스텀 카탈로그 저장소 (Vercel: 인메모리, 로컬: 파일) ───
const CATALOG_CUSTOM_FILE = join(__dirname, 'catalog-custom.json');
let _catalogCache = null;
function readCatalogCustom() {
  if (_catalogCache !== null) return _catalogCache;
  if (existsSync(CATALOG_CUSTOM_FILE)) {
    try { _catalogCache = JSON.parse(readFileSync(CATALOG_CUSTOM_FILE, 'utf8')); return _catalogCache; } catch {}
  }
  _catalogCache = [];
  return _catalogCache;
}
function writeCatalogCustom(arr) {
  _catalogCache = arr;
  try { writeFileSync(CATALOG_CUSTOM_FILE, JSON.stringify(arr, null, 2), 'utf8'); } catch {}
}

// GET /api/catalog-custom
app.get('/api/catalog-custom', (req, res) => {
  res.json(readCatalogCustom());
});

// POST /api/catalog-custom
app.post('/api/catalog-custom', (req, res) => {
  const { label, icon, description, type_hint } = req.body;
  if (!label) return res.status(400).json({ error: 'label 필요' });
  const items = readCatalogCustom();
  const newItem = { id: Date.now().toString(), label, icon: icon || '📌', description: description || '', type_hint: type_hint || '' };
  items.push(newItem);
  writeCatalogCustom(items);
  res.json(newItem);
});

// DELETE /api/catalog-custom/:id
app.delete('/api/catalog-custom/:id', (req, res) => {
  const { id } = req.params;
  const items = readCatalogCustom();
  const filtered = items.filter(item => item.id !== id);
  writeCatalogCustom(filtered);
  res.json({ ok: true });
});

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
    auto_bg_image = false,            // true일 때만 GPT 배경 자동생성 (선택사항)
    font = 'Pretendard',
    layout_types = ['photo-overlay'],  // 선택 레이아웃: 'photo-overlay' | 'twitter'
    user_id = null,
    user_email = null,
    user_name = null,
    person_image_base64 = null,
    person_image_url = null,
    event_date = '',
    event_badge = '무료 LIVE',
    colors = {},
    gdocs_url = '',
  } = req.body;

  if (!url) return res.status(400).json({ error: 'URL이 필요합니다' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되지 않았습니다.' });
  }

  try {
    console.log('\n' + '─'.repeat(50));
    console.log('[🚀 생성 시작]', url);
    console.log('─'.repeat(50));

    // ── STEP 1: 페이지 크롤링 + Google Docs 병렬 fetch ──
    const [{ text: rawPageContent, themeColor: pageThemeColor, ogImageUrl, personImageUrl: autoPersonImageUrl }, gdocsText] = await Promise.all([
      fetchPageContent(url),
      gdocs_url ? fetchGoogleDocsContent(gdocs_url).catch(err => { console.warn('[Google Docs 경고]', err.message); return ''; }) : Promise.resolve(''),
    ]);
    const pageContent = gdocsText
      ? `[CR 문서]\n${gdocsText}\n\n[상세페이지]\n${rawPageContent}`
      : rawPageContent;
    console.log('[크롤링 완료] 텍스트', pageContent.length, 'chars | 테마:', pageThemeColor || '없음', '| OG:', ogImageUrl ? 'O' : 'X', '| 인물:', autoPersonImageUrl ? 'O' : 'X', '| Docs:', gdocsText ? gdocsText.length + 'chars' : 'X');

    // ── STEP 2: 이미지 에이전트(레퍼런스 분석만) + 소재정보 추출 병렬 실행 ──
    // → 이미지 에이전트: 레퍼런스 스타일 분석만 (배경 생성은 카피 완료 후 STEP 4.5)
    // → 소재정보 추출: URL 자동 추출이 필요할 때만
    const detectedLang = detectLanguage(pageContent);
    const rawPageInfo = { language: detectedLang, target, usp1, usp2, usp3, ad_set_message, creative_message };
    const needsAutoExtract = !target && !usp1 && !usp2 && !usp3 && !ad_set_message && !creative_message;

    const [imageResult, resolvedPageInfo] = await Promise.all([
      imageAgent({ referenceImages: reference_images, customBgCss: custom_bg_css }),
      needsAutoExtract ? extractPageInfo(pageContent) : Promise.resolve(rawPageInfo),
    ]);
    if (!resolvedPageInfo.language) resolvedPageInfo.language = detectedLang;
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
    const effectiveLayouts = layout_types.length > 0 ? layout_types : ['photo-overlay'];

    const { adDataList } = await copyAgent({
      pageContent,
      pageInfo: resolvedPageInfo,
      styleAnalysis: imageResult.styleAnalysis,
      layoutTypes: effectiveLayouts,
    });

    // ── STEP 4.5: 배경 이미지 결정 ──
    // customBgImage: 유저가 직접 업로드/사전생성한 이미지 → 최우선
    // auto_bg_image=true: 카피 완료 후 GPT로 한국인 이미지 자동생성
    // 나머지: 컬러 배경만 사용 (이미지 없음)
    let bgImageBase64 = null;
    if (custom_bg_image) {
      bgImageBase64 = custom_bg_image;
      console.log('[배경 이미지] 커스텀 이미지 사용');
    } else if (auto_bg_image) {
      console.log('[배경 이미지] auto_bg_image=true → GPT 자동생성 시작');
      bgImageBase64 = await generateAutoBg({ parsedStyle: imageResult.parsedStyle, pageContent, adDataList, ogImageUrl });
    } else {
      console.log('[배경 이미지] 없음 (컬러 배경 사용)');
    }

    // ── STEP 5: 조합 에이전트 (카피 × 레이아웃 → HTML) ──

    // 인물 이미지 결정: 수동입력 > 자동감지
    const effectivePersonImageBase64 = person_image_base64 || null;
    const effectivePersonImageUrl = person_image_url || autoPersonImageUrl || null;

    const variations = assemblyAgent({
      adDataList,
      bgColor: effectiveBgColor,
      bgImageBase64,
      bgCss: imageResult.bgCss,
      font,
      layoutTypes: effectiveLayouts,
      personImageBase64: effectivePersonImageBase64,
      personImageUrl: effectivePersonImageUrl,
      eventDate: event_date,
      eventBadge: event_badge,
      colors,
    });

    console.log('─'.repeat(50));
    console.log('[✅ 생성 완료]', variations.length, '종 | 컬러:', effectiveBgColor, `(${colorSource})`);
    console.log('[🎨 레이아웃]', effectiveLayouts.join(', '));
    console.log('─'.repeat(50) + '\n');

    // 사용자 로그 기록 (비동기, 실패해도 생성은 영향 없음)
    if (user_id || user_email) {
      supabaseQuery('generations', 'POST', {
        user_id: (user_id && user_id !== 'local') ? user_id : null,
        user_email: user_email || null,
        user_name: user_name || null,
        source_url: url,
      }).catch(() => {});
    }

    res.json({
      variations,
      extractedInfo,
      effectiveBgColor,
      colorSource,
      detectedPersonImageUrl: autoPersonImageUrl || null,
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

// ─── 인물 이미지 URL 프록시 (일반 CDN, 상세페이지 이미지) ───
app.post('/api/fetch-person-image', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다' });

  let hostname;
  try { hostname = new URL(url).hostname; } catch {
    return res.status(400).json({ error: '잘못된 URL입니다' });
  }

  // 사설 IP / localhost 차단 (SSRF 방지)
  if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/i.test(hostname) ||
      hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fe80')) {
    return res.status(403).json({ error: '허용되지 않는 주소입니다' });
  }

  try {
    const imgRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!imgRes.ok) throw new Error(`다운로드 실패: HTTP ${imgRes.status}`);

    const rawCt = imgRes.headers.get('content-type') || 'image/jpeg';
    const contentType = rawCt.split(';')[0].trim();
    const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!ALLOWED_IMAGE_TYPES.includes(contentType)) throw new Error('허용되지 않는 이미지 형식입니다 (jpg/png/webp/gif만 허용)');

    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    res.json({ dataUrl: `data:${contentType};base64,${base64}` });
  } catch (err) {
    console.error('[인물이미지 프록시 오류]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  에이전트 (Agent) — 각자 독립적인 역할과 책임
// ══════════════════════════════════════════════════════

// ─── 🖼 이미지 에이전트 ───
// 역할: 레퍼런스 이미지 스타일 분석 + 배경 이미지 취득
async function generateImageWithGPT(prompt) {
  const openaiRes = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size: '1024x1024', quality: 'medium' }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await openaiRes.json();
  if (openaiRes.ok && data.data?.[0]?.b64_json) {
    return `data:image/png;base64,${data.data[0].b64_json}`;
  }
  throw new Error(data.error?.message || 'GPT image generation failed');
}

function buildAutoBgPrompt(parsedStyle, pageContent, copyCtx = '') {
  const mood = Array.isArray(parsedStyle?.style_mood)
    ? parsedStyle.style_mood.join(', ')
    : (parsedStyle?.style_mood || 'modern, cinematic, professional');
  const context = copyCtx || (pageContent ? pageContent.slice(0, 150) : '');
  return `Professional Korean advertising background photo for Instagram 1:1 (1080x1080px).

SUBJECT: A Korean person (20s-40s, East Asian features, Korean appearance) in a relatable, aspirational setting that fits this context: "${context}". The person should look natural and confident — not stock-photo stiff.

STYLE: ${mood}. Cinematic, high production value. Warm studio or lifestyle setting.

COMPOSITION (CRITICAL — Rule of Thirds copy space):
- LEFT 1/3 to CENTER: keep this area visually CLEAN — dark, low-contrast, slightly blurred — because ad copy text will overlay here.
- RIGHT 2/3 and UPPER portion: place the person and key visual elements here.

CONSTRAINTS:
- The person MUST have Korean/East Asian facial features. No Caucasian or other ethnicity.
- No text, no logos, no watermarks anywhere.
- Dark or muted tones preferred for contrast with white ad copy.
- Photorealistic, not illustrated.`;
}

// 독립성: 페이지 텍스트 불필요. 이미지 데이터만으로 동작.
// 병렬성: 카피 에이전트와 동시 실행 가능 (크롤링 후 바로 시작).
// ※ 배경 이미지 자동생성은 여기서 하지 않음 — 카피 완료 후 generateAutoBg()에서 수행
async function imageAgent({ referenceImages, customBgCss }) {
  // API 요청에 레퍼런스 없으면 reference_images/ 폴더 자동 사용
  const effectiveRefs = referenceImages.length > 0 ? referenceImages : AUTO_REF_IMAGES;
  console.log('[🖼 이미지 에이전트] 시작 | 레퍼런스:', effectiveRefs.length, '장', effectiveRefs.length > 0 && referenceImages.length === 0 ? '(폴더 자동로드)' : '');

  // 스타일 분석만 수행 (배경 생성은 카피 완료 후 별도 실행)
  const styleAnalysis = effectiveRefs.length > 0
    ? await analyzeReferenceImages(effectiveRefs)
    : null;

  let parsedStyle = null;
  if (styleAnalysis) {
    try {
      const m = styleAnalysis.match(/\{[\s\S]+\}/);
      if (m) parsedStyle = JSON.parse(m[0]);
    } catch (e) { console.warn('[이미지 에이전트] 스타일 파싱 실패', e.message); }
  }

  console.log('[🖼 이미지 에이전트] 완료 | 스타일 bg:', parsedStyle?.bg_hex || '없음', '| CSS배경:', customBgCss ? 'O' : 'X');
  return { styleAnalysis, parsedStyle, bgCss: customBgCss || null };
}

// ─── 🎨 배경 이미지 자동생성 (카피 완료 후 실행, 선택사항) ───
// auto_bg_image=true일 때만 호출. 카피 컨텍스트로 한국인 이미지 생성.
async function generateAutoBg({ parsedStyle, pageContent, adDataList, ogImageUrl }) {
  // 카피 첫 번째 배리에이션에서 맥락 추출
  const firstAd = adDataList?.[0];
  const copyCtx = firstAd
    ? `${firstAd.hook || ''} ${firstAd.headline_line1 || ''} ${firstAd.headline_line2 || ''}`.trim()
    : '';

  const bgPrompt = buildAutoBgPrompt(parsedStyle, pageContent, copyCtx);
  let bgImageBase64 = null;

  if (process.env.OPENAI_API_KEY) {
    try {
      console.log('[🎨 GPT 배경 자동생성] 시작:', bgPrompt.slice(0, 80) + '...');
      bgImageBase64 = await generateImageWithGPT(bgPrompt);
      console.log('[🎨 GPT 배경 자동생성] 성공');
    } catch (err) {
      console.warn('[GPT 실패] OG 이미지로 대체:', err.message);
    }
  }

  // GPT 실패 시 OG 이미지 폴백 (Pollinations 제거 — 한국인 보장 불가)
  if (!bgImageBase64 && ogImageUrl) {
    bgImageBase64 = await fetchOgImageBase64(ogImageUrl).catch(() => null);
  }

  console.log('[🎨 배경 자동생성] 결과:', bgImageBase64 ? 'O' : '없음(컬러 배경 사용)');
  return bgImageBase64;
}

// ─── ✍️ 카피 에이전트 ───
// 역할: 페이지 내용 + USP + 체크리스트 기준으로 카피 3종 생성
// 독립성: 이미지 데이터 없이도 동작. 스타일 분석은 선택적 입력.
// 병렬성: 이미지 에이전트와 동시 실행 가능 (소재정보 자동추출 포함).
async function copyAgent({ pageContent, pageInfo, styleAnalysis, layoutTypes = ['photo-overlay'] }) {
  console.log('[✍️ 카피 에이전트] 시작 | 타겟:', pageInfo.target ? pageInfo.target.slice(0, 30) : '자동추출됨', '| 레이아웃:', layoutTypes.join(','));

  let adDataList = await extractAdDataVariations(pageContent, styleAnalysis, pageInfo, 1, layoutTypes);

  // GPT-4o 검증 루프: 3초 후킹 기준 7/10 미달 시 최대 2회 재생성
  if (process.env.OPENAI_API_KEY) {
    for (let retry = 0; retry < 2; retry++) {
      const validations = await Promise.all(adDataList.map(ad => validateAdWithVision(ad)));
      const lowScores = validations.filter(v => v.score !== null && !v.passed);
      if (lowScores.length === 0) break;

      const feedbacks = lowScores.map(v => v.feedback).filter(Boolean);
      console.log(`[🔍 검증 루프] 3초 후킹 미달 (${lowScores.length}종) — 재생성 ${retry + 1}/2 | 피드백:`, feedbacks.join(' / '));

      // 피드백을 pageInfo에 힌트로 추가해 재생성
      const enhancedInfo = {
        ...pageInfo,
        creative_message: pageInfo.creative_message
          + (feedbacks.length ? ` [개선 필요: ${feedbacks.join('; ')}]` : ''),
      };
      adDataList = await extractAdDataVariations(pageContent, styleAnalysis, enhancedInfo, 1, layoutTypes);
    }
  }

  console.log('[✍️ 카피 에이전트] 완료 |', adDataList.map(v => `${v.variation_label}(${v.validation_score}/15)`).join(' · '));
  return { adDataList };
}

// ─── 🔧 조합 에이전트 ───
// 역할: 카피 데이터 + 배경 이미지 → 1080×1080 HTML 소재 3종 조립
// 독립성: 카피 에이전트 + 이미지 에이전트 결과만 있으면 즉시 실행.
// 특성: 동기(sync) 함수 — Claude API 호출 없이 순수 템플릿 렌더링.
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

// ─── 언어 감지 (문자 패턴 기반) ───
function detectLanguage(text) {
  const sample = text.slice(0, 2000);
  const korean = (sample.match(/[가-힣]/g) || []).length;
  const japanese = (sample.match(/[぀-ヿ]/g) || []).length;
  const chinese = (sample.match(/[一-鿿]/g) || []).length;
  const vietnamese = (sample.match(/[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) || []).length;
  const scores = { ko: korean, ja: japanese, zh: chinese - korean - japanese, vi: vietnamese * 3 };
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return top[1] > 5 ? top[0] : 'ko';
}

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
    const srcMatch = tag.match(/(?:data-src|data-lazy-src|src)=["']([^"']+)["']/i);
    if (srcMatch && srcMatch[1].startsWith('http')) return srcMatch[1];
  }

  return null;
}

// ─── Google Docs/Drive 텍스트 추출 ───
async function fetchGoogleDocsContent(gdocsUrl) {
  // Google Docs: /document/d/{ID}/...
  const docMatch = gdocsUrl.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (docMatch) {
    const exportUrl = `https://docs.google.com/document/d/${docMatch[1]}/export?format=txt`;
    const res = await fetch(exportUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`Google Docs 불러오기 실패 (HTTP ${res.status}) — 문서가 "링크가 있는 모든 사용자" 공유 상태인지 확인하세요`);
    const text = await res.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, 4000);
  }

  // Google Drive 파일: /file/d/{ID}/... (Google Docs 형식인 경우)
  const driveFileMatch = gdocsUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveFileMatch) {
    const exportUrl = `https://docs.google.com/document/d/${driveFileMatch[1]}/export?format=txt`;
    const res = await fetch(exportUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`Google Drive 파일 불러오기 실패 — Google Docs 형식 파일과 "링크가 있는 모든 사용자" 공유만 지원합니다`);
    const text = await res.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, 4000);
  }

  throw new Error('지원하지 않는 URL 형식입니다. Google Docs 링크를 사용해주세요.');
}

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
  const personImageUrl = extractPersonImageUrl(html) || null;
  return { text, themeColor, ogImageUrl, personImageUrl };
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
const ANALYZE_PROMPT = `아래 레퍼런스 광고 이미지들을 분석해서 디자인 스타일 정보를 JSON으로 반환하라.

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
{"bg_hex":"","accent_hex":"","headline_hex":"","cta_hex":"","style_mood":[],"font_style":"","layout_type":"","design_notes":""}`;

async function analyzeReferenceImages(images) {
  // GPT-4o Vision 우선, 없으면 Claude 폴백
  if (process.env.OPENAI_API_KEY) {
    try {
      const msgContent = [{ type: 'text', text: ANALYZE_PROMPT }];
      for (const imgData of images.slice(0, 4)) {
        if (/^data:image\//.test(imgData)) {
          msgContent.push({ type: 'image_url', image_url: { url: imgData, detail: 'high' } });
        }
      }
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o', max_tokens: 700, messages: [{ role: 'user', content: msgContent }] }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      if (res.ok && data.choices?.[0]?.message?.content) {
        console.log('[🔍 GPT-4o Vision] 이미지 분석 완료');
        return data.choices[0].message.content;
      }
      console.warn('[GPT-4o Vision 실패, Claude 폴백]', data.error?.message);
    } catch (e) {
      console.warn('[GPT-4o Vision 오류, Claude 폴백]', e.message);
    }
  }
  // Claude Vision 폴백
  try {
    const content = [{ type: 'text', text: ANALYZE_PROMPT }];
    for (const imgData of images.slice(0, 3)) {
      const match = imgData.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
      }
    }
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      messages: [{ role: 'user', content }],
    });
    console.log('[🔍 Claude Vision] 이미지 분석 완료');
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
- language: 페이지의 주요 언어 (예: "ko", "vi", "en", "ja" — ISO 639-1 코드)
- target: 이 과정/서비스의 핵심 타겟 고객 (1-2문장, 구체적으로, 페이지 언어로 작성)
- usp1: 서비스·콘텐츠·커리큘럼 자체의 핵심 차별화 강점 1 (한 줄, 페이지 언어로 작성)
  절대 제외: 결제 조건(무이자 할부, 카드 할인), 가격/할인율, 기간 한정 이벤트, 수강료 정보
  포함 대상: 커리큘럼 방식, 강사 역량, 학습 성과, 취업/전환 지원, 독점 콘텐츠, 업계 인지도
- usp2: 서비스 자체의 차별화 강점 2 (위 기준 동일 적용, 페이지 언어로 작성)
- usp3: 서비스 자체의 차별화 강점 3 (위 기준 동일 적용, 페이지 언어로 작성)
- ad_set_message: 이 캠페인의 전체 메시지 방향 (1문장, 페이지 언어로 작성)
- creative_message: 이 소재에서 강조할 핵심 포인트 (1문장, 페이지 언어로 작성)
- pain_point: 타겟이 현재 겪는 핵심 불만·결핍 (1문장, "~가 없어서 ~이 힘들다" 형태)
- agitation: pain_point를 방치했을 때 생기는 불안·손실 (1문장, "그냥 두면 ..." 형태)
- solution_angle: 이 서비스가 제공하는 Before→After 변화 각도 (1문장, "이 과정으로 ..." 형태)
- usp1_benefit: usp1을 고객 관점 베네핏으로 번역 (기능→가치, 예: "12개월 무제한" → "진도 늦어져도 끝까지 완주")
- usp2_benefit: usp2 베네핏 번역
- usp3_benefit: usp3 베네핏 번역

JSON만 반환:
{"language":"","target":"","usp1":"","usp2":"","usp3":"","ad_set_message":"","creative_message":"","pain_point":"","agitation":"","solution_angle":"","usp1_benefit":"","usp2_benefit":"","usp3_benefit":""}`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 900,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0].text.trim();
  const match = raw.match(/\{[\s\S]+\}/);
  if (!match) throw new Error('소재 정보 자동 추출 실패');
  return JSON.parse(match[0]);
}

// ─── 카피 배리에이션 3종 생성 ───
async function extractAdDataVariations(pageContent, styleAnalysis, info, _attempt = 1, layoutTypes = ['photo-overlay']) {
  const styleHint = styleAnalysis ? `\n\n## 레퍼런스 디자인 스타일 (반드시 참고)\n${styleAnalysis}\n→ 위 스타일 분위기에 맞는 카피 톤을 적용하라.` : '';
  const { language, target, usp1, usp2, usp3, ad_set_message, creative_message,
          pain_point, agitation, solution_angle,
          usp1_benefit, usp2_benefit, usp3_benefit } = info;
  const langMap = { ko: '한국어', vi: '베트남어', en: '영어', ja: '일본어', zh: '중국어', th: '태국어' };
  const langName = langMap[language] || language || '한국어';
  const langInstruction = language && language !== 'ko'
    ? `\n⚠️ 중요: 모든 카피(hook, headline_line1, headline_line2, cta_badge, cta_text, visual_stat1_label 등)는 반드시 ${langName}로 작성하라. 한국어 사용 절대 금지.\n`
    : '';

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

## 자기 검증 — 각 배리에이션 JSON에 반드시 포함 (15개 항목 평가)
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
- V4(메인카피2줄): 메인카피(headline_line1+line2)가 각 줄 20자 이내인가
- V5(서브카피2줄): hook이 20자 이내인가 (서브카피 기준)
- V6(시선흐름): 헤드라인→핵심숫자→서브카피→CTA 순서 구조인가
- V7(크기계층): 헤드라인이 서브카피보다 1.5배 이상 크게 표현되는 구조인가
- S1(구체수치): 수강생 수·조회수 등 구체적 수치로 소셜 증명 있는가
- P1(3초후킹): 3초 안에 혜택 파악 가능한 후킹 요소 있는가
→ "validation":{"C1":true/false,...15개...}, "validation_score":N(true 개수/15), "validation_fails":["C2: 이유"] 를 반드시 추가.
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

  // 레이아웃별 추가 필드 스펙
  const needsInstructor = layoutTypes.some(t => ['instructor', 'seminar', 'review'].includes(t));
  const needsCurriculum = layoutTypes.includes('curriculum');
  const needsSns       = layoutTypes.includes('sns-post');
  const needsComparison= layoutTypes.includes('comparison');
  const needsReview    = layoutTypes.includes('review');

  const extraFields = [];
  if (needsInstructor) {
    extraFields.push(`- instructor_name: 강사/발표자 이름 (페이지에서 추출, 없으면 "[강사명]" 플레이스홀더)
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

  const extraFieldsText = extraFields.length > 0
    ? `\n\n## 레이아웃 추가 필드 (선택된 레이아웃: ${layoutTypes.join(', ')})\n${extraFields.join('\n')}`
    : '';

  // 카피 1종 (레이아웃은 사용자가 별도 선택)
  const layoutSpec = `
## 카피 — 1종
레이아웃은 사용자가 별도 선택하므로 카피에만 집중하라. 가장 성과가 좋을 것 같은 최선의 카피 1개를 작성하라.

공통 필드:
- hook: 서브카피·상황공감 (최대 28자, 의문문 권장)
- headline_line1: 메인카피 1줄 (최대 14자, 임팩트 강하게)
- headline_line2: 메인카피 2줄 (최대 14자, 핵심 키워드)
- cta_badge: CTA 뱃지 (이모지+최대 12자)
- cta_text: CTA 문구 (최대 24자, "→"로 끝)
- visual_stat1_value: 핵심 수치 (예: "4만명+", "92%", "3일 남음")
- visual_stat1_label: 수치 설명 (예: "누적 수강생", "취업 성공률")

JSON 배열만 반환 (주석·설명 없이):
[
  {"variation_label":"광고 소재","brand":"","hook":"","headline_line1":"","headline_line2":"","cta_badge":"","cta_text":"","visual_stat1_value":"","visual_stat1_label":"","footnote":null${needsInstructor ? ',"instructor_name":"","instructor_title":"","instructor_career":"","instructor_bullet1":"","instructor_bullet2":"","instructor_bullet3":""' : ''}${layoutTypes.includes('instructor') ? ',"usp_module1":"","usp_module2":"","usp_module3":"","usp_module4":""' : ''}${layoutTypes.includes('seminar') ? ',"instructor_subtitle":""' : ''}${needsReview ? ',"review_body1":"","review_body2":"","review_body3":""' : ''}${needsCurriculum ? ',"curriculum_step1":"","curriculum_step2":"","curriculum_step3":"","curriculum_step4":"","curriculum_step5":"","curriculum_badge":""' : ''}${needsSns ? ',"post_username":"","post_body":""' : ''}${needsComparison ? ',"comparison_a_label":"","comparison_b_label":"","comparison_items":[]' : ''},"validation":{"C1":true,"C2":true,"C3":true,"C4":true,"C5":true,"C6":true,"V1":true,"V2":true,"V3":true,"V4":true,"V5":true,"V6":true,"V7":true,"S1":true,"P1":true},"validation_score":15,"validation_fails":[]}
]${extraFieldsText}`;

  // PAS 프레임워크 컨텍스트
  const pasCtx = (pain_point || agitation || solution_angle) ? `
## PAS 카피 프레임워크 (반드시 적용)
P — Problem (문제 공감): ${pain_point || ''}
A — Agitation (불안 자극): ${agitation || ''}
S — Solution (해결책 제시): ${solution_angle || ''}

→ hook은 P(문제 공감)로 시작해 독자가 "나 얘기네"를 느끼게 하라.
→ headline은 A→S 전환(Before→After 변화)을 압축해 표현하라.
→ CTA는 S의 결과를 행동으로 연결하라.
` : '';

  // USP → 베네핏 치환 컨텍스트
  const benefitCtx = (usp1_benefit || usp2_benefit || usp3_benefit) ? `
## USP → 고객 베네핏 치환 (기능 설명 금지, 반드시 가치 언어로 표현)
- USP1 베네핏: ${usp1_benefit || usp1}
- USP2 베네핏: ${usp2_benefit || usp2}
- USP3 베네핏: ${usp3_benefit || usp3}

→ 카피에 USP 기능 그대로 쓰지 말고, 위 베네핏 언어로 표현하라.
→ 예: "12개월 무제한 수강" → "진도 늦어져도 끝까지 완주" / "현업 강사진" → "실무 바로 쓰는 기술"
` : '';

  const prompt = `아래 정보를 바탕으로 META 인스타그램 1:1 광고소재 카피 1개를 작성하라.
${langInstruction}
## 소재 기본 정보
- 과정 타겟: ${target}
- USP 1: ${usp1}
- USP 2: ${usp2}
- USP 3: ${usp3}
- 광고세트 메시지: ${ad_set_message}
- 소재 메시지: ${creative_message}
${pasCtx}${benefitCtx}
## 상세페이지 내용 (참고)
${pageContent}${styleHint}
${checklistCtx}${designSpecCtx}${figmaCtx}
${layoutSpec}`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0].text.trim();
  // 코드블록(```json ... ```) 제거 후 배열 추출
  const stripped = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // ① 배열 직접 매칭
  let parsed = null;
  const arrMatch = stripped.match(/\[[\s\S]+?\]/);
  if (arrMatch) {
    try { parsed = JSON.parse(arrMatch[0]); } catch { parsed = null; }
  }
  // ② 배열 없고 객체만 있으면 배열로 감싸기
  if (!parsed) {
    const objMatch = stripped.match(/\{[\s\S]+\}/);
    if (objMatch) {
      try { parsed = [JSON.parse(objMatch[0])]; } catch { parsed = null; }
    }
  }
  // ③ 파싱 완전 실패 → 재시도 (최대 3회)
  if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
    if (_attempt < 3) {
      console.warn(`[파싱 실패 — 재시도 ${_attempt + 1}/3] Claude 응답:`, raw.slice(0, 200));
      return extractAdDataVariations(pageContent, styleAnalysis, info, _attempt + 1, layoutTypes);
    }
    console.error('[파싱 최종 실패] Claude 응답:', raw.slice(0, 500));
    throw new Error('카피 생성 실패 — Claude 응답을 파싱할 수 없습니다. 잠시 후 다시 시도해주세요.');
  }

  // 자동 재시도: validation_score < 8이면 1회 재생성
  if (_attempt === 1) {
    const hasLowScore = parsed.some(v => typeof v.validation_score === 'number' && v.validation_score < 11);
    if (hasLowScore) {
      const fails = [...new Set(parsed.flatMap(v => v.validation_fails || []))];
      console.log('[체크리스트 점수 미달 — 자동 재생성]', fails.join(', '));
      return extractAdDataVariations(pageContent, styleAnalysis, info, 2, layoutTypes);
    }
  }

  return parsed;
}

// ─── GPT-4o 3초 후킹 검증 루프 ───
// 카피를 GPT-4o가 객관적으로 평가, 7/10 미달 시 재생성 트리거
async function validateAdWithVision(adData) {
  if (!process.env.OPENAI_API_KEY) return { score: null, passed: true, feedback: null };

  const prompt = `META 인스타그램 광고 카피를 "3초 후킹" 기준으로 평가하라.

## 광고 카피
- hook: "${adData.hook}"
- headline_line1: "${adData.headline_line1}"
- headline_line2: "${adData.headline_line2}"
- cta_badge: "${adData.cta_badge}"
- cta_text: "${adData.cta_text}"
- visual_stat1_value: "${adData.visual_stat1_value}"
- visual_stat1_label: "${adData.visual_stat1_label}"

## 평가 기준 (10점 만점)
1. 즉각적 공감 (0-3점): 타겟이 "나 얘기네"라고 3초 안에 느끼는가?
2. 혜택 명확성 (0-3점): 핵심 혜택·가치가 즉시 파악되는가?
3. 긴박감·행동유도 (0-2점): 지금 클릭해야 한다는 느낌인가?
4. 가독성·간결성 (0-2점): 카피가 짧고 임팩트 있는가?

7점 이상이면 통과. JSON만 반환 (설명 없이):
{"score":N,"passed":true,"feedback":"개선 포인트 1문장 (한국어)"}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`GPT ${res.status}`);
    const data = await res.json();
    const text = data.choices[0].message.content.trim();
    const m = text.match(/\{[\s\S]+\}/);
    if (m) return JSON.parse(m[0]);
  } catch (e) {
    console.warn('[검증 루프 실패]', e.message);
  }
  return { score: null, passed: true, feedback: null };
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

// ─── 줄바꿈 → <br> 변환 헬퍼 ───
function nl2br(str) {
  return (str || '').replace(/\n/g, '<br>');
}

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
// luminance() 함수가 이미 존재하므로 활용
function isColorDark(hex) {
  return luminance(hex) < 128;
}

// ─── 후기 본문 **굵게** 마크 → <strong> 변환 ───
function boldMark(str = '') {
  return str.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--accent)">$1</strong>');
}

// ─── HTML 생성 (레이아웃 dispatcher) ───
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
  // 기존
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

// ─── 강사강조형 ───
function generateInstructorHTML(d, bgColor = '#f5a623', personImg = null, font = 'Pretendard', colors = {}) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
  const accent = colors.accentColor || bgColor;

  // 4개 모듈 카드 — 마지막 카드에 배지
  const uspCards = [1,2,3,4].map(i => {
    const mod = d[`usp_module${i}`] || `모듈 ${i}`;
    const isLast = i === 4;
    return `<div style="flex:1;min-width:0;background:#fff;border-radius:14px;border:${isLast ? `2px solid ${accent}` : '1.5px solid #e8e8e8'};padding:16px 12px 14px;display:flex;flex-direction:column;align-items:center;gap:10px;position:relative">
      ${isLast ? `<div style="position:absolute;top:-13px;right:8px;background:${accent};color:#fff;font-size:11px;font-weight:900;padding:3px 10px;border-radius:20px;white-space:nowrap;letter-spacing:-.2px">패캠 Only</div>` : ''}
      <div style="width:28px;height:28px;border-radius:50%;background:${accent};color:#fff;font-size:14px;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0">${i}</div>
      <div style="width:100%;height:90px;background:repeating-conic-gradient(#e0e0e0 0% 25%,#f5f5f5 0% 50%) 0 0/20px 20px;border-radius:8px"></div>
      <div style="font-size:14px;font-weight:700;color:#222;text-align:center;line-height:1.4">${mod}</div>
    </div>`;
  }).join('');

  // 강사 프로필
  const personSection = personImg
    ? `<div style="width:90px;height:90px;border-radius:50%;overflow:hidden;border:3px solid ${accent};flex-shrink:0"><img src="${personImg}" style="width:100%;height:100%;object-fit:cover;object-position:top"></div>`
    : `<div style="width:90px;height:90px;border-radius:50%;background:#e8e8e8;flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden">
        <svg width="54" height="54" viewBox="0 0 24 24" fill="#999"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
       </div>`;

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative;background:#fafafa;background-image:radial-gradient(circle,#d8d8d8 1.2px,transparent 1.2px);background-size:26px 26px">

  <!-- 헤드라인 영역 -->
  <div style="padding:48px 52px 0">
    <div style="font-size:34px;font-weight:700;color:#222;line-height:1.35;margin-bottom:6px">${nl2br(d.hook || '')}</div>
    <div style="font-size:52px;font-weight:900;color:${accent};line-height:1.1;letter-spacing:-1.5px">${d.headline_line1 || ''}</div>
    <div style="font-size:52px;font-weight:900;color:${accent};line-height:1.1;letter-spacing:-1.5px;margin-bottom:2px">${d.headline_line2 || ''}</div>
  </div>

  <!-- 4개 모듈 카드 -->
  <div style="padding:22px 52px 0;display:flex;gap:14px">
    ${uspCards}
  </div>

  <!-- 강사 섹션 -->
  <div style="position:absolute;bottom:108px;left:52px;right:52px;display:flex;align-items:center;gap:22px;background:rgba(255,255,255,.8);border-radius:16px;padding:18px 22px;border:1px solid #ebebeb">
    ${personSection}
    <div style="flex:1;min-width:0">
      <div style="font-size:24px;font-weight:900;color:#111;margin-bottom:3px">${d.instructor_name || '[강사명]'}</div>
      <div style="font-size:15px;color:#444;margin-bottom:1px">${d.instructor_title || '현) -'}</div>
      <div style="font-size:14px;color:#666;margin-bottom:8px">${d.instructor_career || '전) -'}</div>
      <div style="display:flex;flex-direction:column;gap:3px">
        ${[1,2,3].map(i => d[`instructor_bullet${i}`] ? `<div style="font-size:13px;color:#444;line-height:1.4">• ${d[`instructor_bullet${i}`]}</div>` : '').join('')}
      </div>
    </div>
  </div>

  <!-- CTA 바 -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:${accent};display:flex;align-items:center;justify-content:center;gap:12px">
    <div style="font-size:26px;font-weight:900;color:#fff">${d.cta_text || '지금 바로 신청하기 ›'}</div>
  </div>

</div></body></html>`;
}

// ─── 세미나형 (인물강조) ───
function generateSeminarHTML(d, bgColor = '#7c3aed', personImg = null, font = 'Pretendard', colors = {}, eventDate = '', eventBadge = '무료 LIVE') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
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

  <div style="padding:52px 52px 0;display:flex;align-items:center;gap:18px">
    <div style="background:#e11d48;color:#fff;font-size:20px;font-weight:900;padding:8px 20px;border-radius:6px">${eventBadge}</div>
    ${eventDate ? `<div style="color:rgba(255,255,255,0.85);font-size:22px;font-weight:600">${eventDate}</div>` : ''}
  </div>

  <div style="padding:32px 52px 0">
    <div style="font-size:66px;font-weight:900;color:#fff;line-height:1.1;letter-spacing:-2px">${d.headline_line1 || ''}</div>
    <div style="font-size:66px;font-weight:900;color:#fff;line-height:1.1;letter-spacing:-2px">${d.headline_line2 || ''}</div>
    <div style="margin-top:16px;font-size:24px;color:rgba(255,255,255,0.72)">${d.hook || ''}</div>
  </div>

  ${personBlock}

  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:var(--cta-bg);display:flex;align-items:center;justify-content:center">
    <div style="font-size:26px;font-weight:800;color:var(--cta-text)">${d.cta_text || '무료로 신청하기 →'}</div>
  </div>

</div></body></html>`;
}

// ─── SNS UI형 ───
function generateSnsPostHTML(d, bgColor = '#1877f2', font = 'Pretendard', colors = {}) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
  const navColor = bgColor;
  const postTitle = [d.headline_line1, d.headline_line2].filter(Boolean).join(' ');
  const rawBody = d.post_body || d.hook || '';
  const paragraphs = rawBody.replace(/\\n/g, '\n').split('\n').filter(s => s.trim()).slice(0, 4);
  const username = d.post_username || '익명의수강생';
  const initChar = username[0] || 'K';

  const bodyHtml = paragraphs.map(p =>
    `<p style="font-size:22px;color:#65676b;line-height:1.75;margin-bottom:18px">${p}</p>`
  ).join('');

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative;background:#f0f2f5">

  <!-- 네비게이션 바 -->
  <div style="background:${navColor};height:72px;display:flex;align-items:center;padding:0 44px;gap:36px;flex-shrink:0">
    <span style="color:#fff;font-size:20px;font-weight:800">Q&A</span>
    <span style="color:rgba(255,255,255,.65);font-size:20px">지식</span>
    <span style="color:rgba(255,255,255,.65);font-size:20px">커뮤니티</span>
    <span style="color:rgba(255,255,255,.65);font-size:20px">이벤트</span>
    <span style="color:rgba(255,255,255,.65);font-size:20px">JOBS</span>
    <div style="margin-left:auto;border:2px solid rgba(255,255,255,.85);color:#fff;font-size:17px;font-weight:700;padding:9px 26px;border-radius:24px;flex-shrink:0">질문하기</div>
  </div>

  <!-- 포스트 카드 — nav 아래부터 바닥까지 꽉 채움 -->
  <div style="position:absolute;top:72px;left:44px;right:44px;bottom:0;background:#fff;border-radius:18px 18px 0 0;padding:40px 48px;display:flex;flex-direction:column;overflow:hidden">
    <!-- 작성자 -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;flex-shrink:0">
      <div style="display:flex;align-items:center;gap:16px">
        <div style="width:64px;height:64px;border-radius:50%;background:${navColor};display:flex;align-items:center;justify-content:center;color:#fff;font-size:26px;font-weight:900;flex-shrink:0">${initChar}</div>
        <div>
          <div style="font-size:22px;font-weight:700;color:#1c1e21;margin-bottom:3px">${username}</div>
          <div style="font-size:17px;color:#65676b">❤ 2.5k &nbsp;·&nbsp; 1개월 전</div>
        </div>
      </div>
      <div style="display:flex;gap:22px;font-size:26px;color:#8a8d91"><span>⤴</span><span>🔖</span></div>
    </div>
    <!-- 포스트 제목 -->
    <div style="font-size:32px;font-weight:900;color:#1c1e21;line-height:1.35;margin-bottom:22px;flex-shrink:0">${postTitle}</div>
    <!-- 본문 -->
    <div style="flex:1;overflow:hidden">${bodyHtml}</div>
    <!-- CTA 버튼 -->
    <div style="flex-shrink:0;margin-top:20px;background:${navColor};border-radius:18px;height:88px;display:flex;align-items:center;justify-content:center">
      <span style="font-size:26px;font-weight:800;color:#fff">${d.cta_text || '이에 대한 전문가의 답은? ›'}</span>
    </div>
  </div>

</div></body></html>`;
}

// ─── 비교형 ───
function generateComparisonHTML(d, bgColor = '#111111', bgImageBase64 = null, bgCss = null, font = 'Pretendard', colors = {}) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
  const accent = colors.accentColor || bgColor;
  const topBg = bgImageBase64
    ? `url('${bgImageBase64}') center/cover no-repeat`
    : bgCss || bgColor;
  const items = Array.isArray(d.comparison_items) && d.comparison_items.length > 0
    ? d.comparison_items.slice(0, 6)
    : [{ stage:'단계1', a_state:'–', b_state:'✓' }, { stage:'단계2', a_state:'–', b_state:'✓' }, { stage:'단계3', a_state:'–', b_state:'✓' }, { stage:'단계4', a_state:'–', b_state:'✓' }, { stage:'단계5', a_state:'–', b_state:'✓' }];

  const aLabel = d.comparison_a_label || '기존 방식';
  const bLabel = d.comparison_b_label || '수강 후';
  const colCount = items.length;
  const labelColW = 100;
  const tableW = 1080 - 52 - 52;
  const colW = Math.floor((tableW - labelColW) / colCount);

  // 헤더 행
  const headerCells = items.map(it =>
    `<div style="width:${colW}px;text-align:center;font-size:16px;font-weight:700;color:#888;padding:8px 4px;flex-shrink:0">${it.stage || ''}</div>`
  ).join('');

  // A행 — 회색 마크/빈칸
  const aCells = items.map(it => {
    const val = it.a_state || '';
    const isEmpty = val === '–' || val === '' || val === null;
    return `<div style="width:${colW}px;text-align:center;padding:10px 4px;flex-shrink:0">
      ${isEmpty
        ? `<div style="display:inline-block;width:32px;height:20px;background:#e0e0e0;border-radius:4px"></div>`
        : `<div style="display:inline-block;background:#f0f0f0;border-radius:16px;padding:5px 12px;font-size:13px;color:#666;font-weight:600;max-width:${colW-8}px;overflow:hidden;white-space:nowrap">${val}</div>`
      }
    </div>`;
  }).join('');

  // B행 — 강조 마크 + 핵심 포인트에 "심사" 배지
  const bCells = items.map((it, i) => {
    const val = it.b_state || '✓';
    const isKey = val !== '–' && val !== '';
    return `<div style="width:${colW}px;text-align:center;padding:10px 4px;flex-shrink:0;position:relative">
      ${isKey
        ? `<div style="display:inline-block;background:${accent};border-radius:16px;padding:5px 12px;font-size:13px;font-weight:800;color:#fff;max-width:${colW-8}px;overflow:hidden;white-space:nowrap">${val}</div>`
        : `<div style="display:inline-block;width:32px;height:20px;background:#e0e0e0;border-radius:4px"></div>`
      }
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative;background:#fff">

  <!-- 상단 다크 섹션 (450px) -->
  <div style="position:relative;height:450px;background:${topBg};overflow:hidden">
    ${bgImageBase64 ? '<div style="position:absolute;inset:0;background:rgba(0,0,0,0.55)"></div>' : ''}
    <!-- 장식 이미지 — 배경 없을 때 추상 그래픽 -->
    ${!bgImageBase64 ? `<div style="position:absolute;right:-60px;top:-60px;width:400px;height:400px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.08) 0%,transparent 70%)"></div>
    <div style="position:absolute;right:60px;top:40px;width:220px;height:220px;border-radius:50%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1)"></div>` : ''}
    <div style="position:absolute;bottom:60px;left:52px;right:52px;z-index:2">
      <div style="font-size:26px;color:rgba(255,255,255,.7);margin-bottom:14px;font-weight:500">${d.hook || ''}</div>
      <div style="font-size:66px;font-weight:900;color:#fff;line-height:1.05;letter-spacing:-2.5px">${d.headline_line1 || ''}</div>
      <div style="font-size:66px;font-weight:900;color:${accent};line-height:1.05;letter-spacing:-2.5px">${d.headline_line2 || ''}</div>
    </div>
  </div>

  <!-- 찢어진 종이 구분선 -->
  <svg viewBox="0 0 1080 52" width="1080" height="52" style="display:block;margin-top:-2px" preserveAspectRatio="none">
    <path d="M0,0 C180,52 280,12 420,36 C560,58 680,8 820,30 C920,46 1000,16 1080,28 L1080,52 L0,52 Z" fill="#fff"/>
  </svg>

  <!-- 비교표 -->
  <div style="background:#fff;padding:4px 52px 0">
    <!-- 헤더 -->
    <div style="display:flex;margin-left:${labelColW}px;margin-bottom:4px">${headerCells}</div>
    <!-- A행 -->
    <div style="display:flex;align-items:center;background:#fafafa;border-radius:12px;padding:6px 0;margin-bottom:8px">
      <div style="width:${labelColW}px;flex-shrink:0;padding:0 0 0 12px;font-size:17px;font-weight:700;color:#aaa">${aLabel}</div>
      ${aCells}
    </div>
    <!-- B행 -->
    <div style="display:flex;align-items:center;background:${accent}14;border-radius:12px;border:1.5px solid ${accent}30;padding:6px 0">
      <div style="width:${labelColW}px;flex-shrink:0;padding:0 0 0 12px;font-size:17px;font-weight:900;color:${accent}">${bLabel}</div>
      ${bCells}
    </div>
    <!-- 결론 텍스트 -->
    <div style="margin-top:28px">
      <div style="font-size:34px;font-weight:900;color:#111;line-height:1.4">${d.headline_line1 || ''} <span style="color:${accent}">${d.visual_stat1_value || ''}</span></div>
      <div style="font-size:32px;font-weight:800;color:#333">${d.headline_line2 || ''} <span style="color:${accent}">${d.visual_stat1_label || ''}</span></div>
    </div>
  </div>

  <!-- CTA 바 -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:var(--cta-bg);display:flex;align-items:center;justify-content:center">
    <div style="font-size:26px;font-weight:800;color:var(--cta-text)">${d.cta_text || '지금 바로 시작하기 →'}</div>
  </div>

</div></body></html>`;
}

// ─── 이미지강조형 (풀블리드) ───
function generateImageHeroHTML(d, bgColor = '#111', bgImageBase64 = null, bgCss = null, font = 'Pretendard', colors = {}) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
  const bg = bgImageBase64 ? `url('${bgImageBase64}') center/cover no-repeat` : bgCss || bgColor;
  const ctaBg = colors.ctaColor || (isColorDark(bgColor) ? '#00c470' : bgColor);

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative;background:${bg}">

  <!-- 그라디언트 오버레이 — 상단 투명, 하단 어둡게 -->
  <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,0.1) 30%,rgba(0,0,0,0.55) 62%,rgba(0,0,0,0.85) 82%,rgba(0,0,0,.95) 100%);z-index:1"></div>

  <!-- 상단 훅 텍스트 -->
  <div style="position:absolute;top:40px;left:52px;right:52px;z-index:10;text-align:center">
    <div style="font-size:22px;color:rgba(255,255,255,0.85);font-weight:500;letter-spacing:.3px">${d.hook || ''}</div>
  </div>

  <!-- 우측 배지 -->
  ${d.cta_badge ? `<div style="position:absolute;top:50%;right:40px;transform:translateY(-50%);z-index:10;background:var(--cta-bg);color:var(--cta-text);font-size:17px;font-weight:900;padding:12px 20px;border-radius:28px;text-align:center;max-width:130px;line-height:1.3">${d.cta_badge}</div>` : ''}

  <!-- 중앙-하단 헤드라인 -->
  <div style="position:absolute;bottom:128px;left:52px;right:${d.cta_badge ? '180px' : '52px'};z-index:10">
    <div style="font-size:82px;font-weight:900;color:#fff;line-height:1.05;letter-spacing:-3px;text-shadow:0 6px 28px rgba(0,0,0,0.6)">${d.headline_line1 || ''}</div>
    <div style="font-size:82px;font-weight:900;color:var(--accent);line-height:1.05;letter-spacing:-3px;text-shadow:0 6px 28px rgba(0,0,0,0.4)">${d.headline_line2 || ''}</div>
  </div>

  <!-- 하단 CTA 바 (배경색과 대비되는 색) -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:110px;background:${ctaBg};display:flex;align-items:center;justify-content:center;z-index:10">
    <div style="font-size:26px;font-weight:900;color:#fff">${d.cta_text || '지금 시작하기 ›'}</div>
  </div>

</div></body></html>`;
}

// ─── 커리큘럼강조형 ───
function generateCurriculumHTML(d, bgColor = '#0a0e1a', font = 'Pretendard', colors = {}) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
  const accent = colors.accentColor || '#4a9eff';
  const steps = [1,2,3,4,5].map(i => d[`curriculum_step${i}`] || `단계 ${i}`);

  // 커리큘럼 카드 내 타임라인 — 5개 컬럼
  const cardInnerW = 920; // 카드 내부 너비
  const stepColW = Math.floor(cardInnerW / 5);
  const timelineSteps = steps.map((s, i) => `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;position:relative">
      <div style="width:20px;height:20px;border-radius:50%;background:${accent};border:3px solid rgba(255,255,255,.6);z-index:1;flex-shrink:0"></div>
      <div style="font-size:14px;font-weight:700;color:#222;text-align:center;line-height:1.35;max-width:140px">${s}</div>
    </div>`).join('');

  // 커리큘럼 카드 내 섬네일 그리드 (5열 × 4행 = 20개)
  const thumbRows = [0,1,2,3].map(row =>
    `<div style="display:flex;gap:10px">` +
    [0,1,2,3,4].map(() =>
      `<div style="flex:1;height:72px;background:rgba(180,200,230,.18);border-radius:6px;border:1px solid rgba(180,200,230,.25)"></div>`
    ).join('') +
    `</div>`
  ).join('');

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative;overflow:hidden;background:${bgColor}">

  <!-- 배경 -->
  <div style="position:absolute;inset:0;background:${bgColor}"></div>
  <!-- 헥스 패턴 오버레이 -->
  <div style="position:absolute;inset:0;opacity:.07;background-image:url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2260%22 height=%2252%22><polygon points=%2230,1 56,15 56,45 30,59 4,45 4,15%22 fill=%22none%22 stroke=%22white%22 stroke-width=%221%22/></svg>');background-size:60px 52px"></div>

  <!-- 헤드라인 -->
  <div style="position:relative;z-index:2;padding:52px 80px 0;text-align:center">
    <div style="font-size:62px;font-weight:900;color:#fff;line-height:1.1;letter-spacing:-2px">${d.headline_line1 || ''}</div>
    <div style="font-size:62px;font-weight:900;color:${accent};line-height:1.1;letter-spacing:-2px;margin-bottom:32px">${d.headline_line2 || ''}</div>
  </div>

  <!-- 커리큘럼 카드 -->
  <div style="position:relative;z-index:2;margin:0 52px;background:rgba(200,220,255,.12);border:1.5px solid rgba(160,200,255,.25);border-radius:20px;padding:28px 32px 24px">
    <!-- 타임라인 -->
    <div style="display:flex;align-items:flex-start;position:relative;margin-bottom:20px">
      <!-- 연결선 -->
      <div style="position:absolute;top:9px;left:10%;right:10%;height:2px;background:linear-gradient(90deg,${accent}88,${accent}44);z-index:0"></div>
      ${timelineSteps}
    </div>
    <!-- 섬네일 그리드 -->
    <div style="display:flex;flex-direction:column;gap:10px">
      ${thumbRows}
    </div>
  </div>

  <!-- 하단 배지 + 설명 -->
  <div style="position:absolute;bottom:108px;left:52px;right:52px;z-index:2;display:flex;align-items:center;gap:20px">
    ${d.curriculum_badge
      ? `<div style="background:${accent};color:#fff;font-size:13px;font-weight:900;border-radius:50%;width:96px;height:96px;display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.3;flex-shrink:0;padding:8px">${d.curriculum_badge}</div>`
      : ''}
    <div style="font-size:22px;color:rgba(255,255,255,.8);line-height:1.6">
      ${d.hook || ''}
      ${d.visual_stat1_value ? `<span style="color:${accent};font-weight:800"> ${d.visual_stat1_value}</span>` : ''}
    </div>
  </div>

  <!-- CTA 바 -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:var(--cta-bg);z-index:2;display:flex;align-items:center;justify-content:center">
    <div style="font-size:26px;font-weight:800;color:var(--cta-text)">${d.cta_text || '전체 커리큘럼 보기 →'}</div>
  </div>

</div></body></html>`;
}

// ─── 후기사례형 ───
function generateReviewHTML(d, bgColor = '#1B5BD4', personImg = null, font = 'Pretendard', colors = {}) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const cssVars = buildCssVars(bgColor, colors);
  const accent = colors.accentColor || bgColor;

  // 회사 로고 플레이스홀더 카드 (3행 × 4열)
  const logoTexts = ['삼성전자','NAVER','LG전자','SK하이닉스','현대자동차','카카오','쿠팡','KT','Google','NVIDIA','Meta','Tesla'];
  const logoCards = logoTexts.map(name =>
    `<div style="background:#fff;border-radius:10px;display:flex;align-items:center;justify-content:center;padding:12px 8px;min-width:0">
      <span style="font-size:17px;font-weight:800;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</span>
    </div>`
  ).join('');

  // 강사/인물 사진
  const personSection = personImg
    ? `<img src="${personImg}" style="position:absolute;right:0;bottom:108px;width:320px;height:380px;object-fit:cover;object-position:top;mask-image:linear-gradient(to left,rgba(0,0,0,1) 60%,rgba(0,0,0,0))">`
    : '';

  const searchText = d.visual_stat1_label || d.brand || '강의명을 검색해보세요';

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}
:root{${cssVars}}</style></head>
<body><div style="width:1080px;height:1080px;position:relative;background:#fff">

  <!-- 상단 블루 섹션 -->
  <div style="height:490px;background:linear-gradient(170deg,${accent} 0%,${accent}dd 60%,${accent}aa 100%);padding:32px 36px 0;position:relative;overflow:hidden">
    <!-- 빛 효과 -->
    <div style="position:absolute;top:-80px;right:-80px;width:400px;height:400px;border-radius:50%;background:rgba(255,255,255,.1);pointer-events:none"></div>
    <!-- 로고 그리드 (3×4) -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;height:360px">
      ${logoCards}
    </div>
  </div>

  <!-- 검색 바 (블루 섹션과 화이트 사이 오버랩) -->
  <div style="margin:0 48px;position:relative;top:-28px;background:#fff;border-radius:40px;padding:16px 28px;display:flex;align-items:center;gap:12px;box-shadow:0 6px 28px rgba(0,0,0,.15);z-index:2">
    <span style="font-size:22px;color:#aaa">🔍</span>
    <span style="font-size:19px;color:#333;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${searchText}</span>
  </div>

  <!-- 하단 텍스트 영역 -->
  <div style="padding:0 52px;position:relative;z-index:1">
    <div style="font-size:20px;font-weight:800;color:${accent};margin-bottom:10px;letter-spacing:-.3px">${d.hook || ''}</div>
    <div style="font-size:56px;font-weight:900;color:#111;line-height:1.1;letter-spacing:-2px">${d.headline_line1 || ''}</div>
    <div style="font-size:56px;font-weight:900;color:#111;line-height:1.1;letter-spacing:-2px">${d.headline_line2 || ''}</div>
  </div>

  <!-- 강사/인물 사진 -->
  ${personSection}

  <!-- CTA 바 -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:var(--cta-bg);display:flex;align-items:center;justify-content:center;z-index:3">
    <div style="font-size:26px;font-weight:800;color:var(--cta-text)">${d.cta_text || '수강 사례 더 보기 →'}</div>
  </div>

</div></body></html>`;
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
  <div data-brand-block style="position:absolute;left:52px;top:42px;display:flex;align-items:center;gap:12px;z-index:10">
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
    <div data-field="hook" style="font-size:34px;font-weight:600;color:rgba(0,0,0,0.65);line-height:1.5;letter-spacing:-0.5px">${nl2br(d.hook)}</div>
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
  <div data-brand-block style="position:absolute;left:52px;top:36px;display:flex;align-items:center;gap:12px;z-index:10">
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
function generatePhotoOverlayHTML(d, bgColor = '#1a1a1a', bgImageBase64 = null, cssBackground = null, font = 'Pretendard', ctaColor = null) {
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

  const ctaBg = ctaColor || 'linear-gradient(90deg,#FF4B6E,#FF7040)';

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
  <div data-brand-block style="position:absolute;left:62px;top:52px;display:flex;align-items:center;gap:10px;z-index:10">
    <div style="width:26px;height:26px;background:rgba(255,255,255,0.92);border-radius:5px;flex-shrink:0"></div>
    <span data-field="brand" style="font-size:23px;font-weight:700;color:#fff;letter-spacing:-0.3px;text-shadow:0 1px 4px rgba(0,0,0,0.5)">${d.brand || '브랜드'}</span>
  </div>

  <!-- 서브카피 (피그마: 42px, top≈688 비율 기준) -->
  <div data-field="hook" style="position:absolute;left:62px;top:634px;right:80px;z-index:10;font-size:40px;font-weight:700;color:rgba(255,255,255,0.82);letter-spacing:-0.84px;line-height:1.28;text-shadow:0 2px 8px rgba(0,0,0,0.6)">
    ${nl2br(d.hook)}
  </div>

  <!-- 메인카피 (피그마: 80px Bold, 2줄 15자 이내, top≈786 비율) -->
  <div style="position:absolute;left:62px;top:736px;right:60px;z-index:10;font-size:80px;font-weight:900;color:#fff;letter-spacing:-2px;line-height:1.08;text-shadow:0 3px 12px rgba(0,0,0,0.7)">
    <span data-field="headline_line1">${d.headline_line1 || ''}</span><br><span data-field="headline_line2">${d.headline_line2 || ''}</span>
  </div>

  ${footHtml}

  <!-- CTA 바 -->
  <div style="position:absolute;bottom:0;left:0;right:0;padding:24px 62px;background:${ctaBg};display:flex;align-items:center;gap:14px;z-index:10;flex-shrink:0">
    ${ctaBadgeHtml}
    <span data-field="cta_text" style="font-size:26px;font-weight:700;color:#fff;letter-spacing:-0.5px;white-space:nowrap">${d.cta_text || '지금 바로 시작하기 →'}</span>
  </div>

</div>
</body>
</html>`;
}

// ─── 포토오버레이-센터패널형 ───
// 레이아웃: 배경이미지 전체 + 비네팅 + 중앙 글래스모픽 패널에 카피
function generatePhotoCenterPanelHTML(d, bgColor = '#1a1a1a', bgImageBase64 = null, cssBackground = null, font = 'Pretendard', ctaColor = null) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const bgBase = bgColor || '#1a1a1a';
  const bgStyle = bgImageBase64
    ? `background:#000`
    : cssBackground
    ? `background:${cssBackground}`
    : `background:linear-gradient(155deg,${bgBase} 0%,#050505 100%)`;

  const ctaBg = ctaColor || 'linear-gradient(90deg,#FF4B6E,#FF7040)';

  const ctaBadgeHtml = d.cta_badge
    ? `<span data-field="cta_badge" style="font-size:21px;font-weight:800;color:#fff;background:rgba(255,255,255,0.2);padding:5px 18px;border-radius:30px;white-space:nowrap;flex-shrink:0">${d.cta_badge}</span>`
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
  <div data-brand-block style="position:absolute;left:64px;top:54px;display:flex;align-items:center;gap:10px;z-index:10">
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
    <div data-field="hook" style="font-size:32px;font-weight:600;color:rgba(255,255,255,0.7);letter-spacing:-0.5px;line-height:1.4;margin-bottom:22px">${nl2br(d.hook)}</div>

    <!-- 메인카피 -->
    <div style="font-size:${hlSize}px;font-weight:900;color:#fff;letter-spacing:-2.5px;line-height:1.06">
      <span data-field="headline_line1">${hl1}</span><br>
      <span data-field="headline_line2">${hl2}</span>
    </div>
  </div>

  <!-- CTA 바 (하단) -->
  <div style="position:absolute;bottom:0;left:0;right:0;padding:22px 64px;background:${ctaBg};display:flex;align-items:center;gap:14px;z-index:10">
    ${ctaBadgeHtml}
    <span data-field="cta_text" style="font-size:26px;font-weight:700;color:#fff;letter-spacing:-0.5px;white-space:nowrap">${d.cta_text || '지금 바로 시작하기 →'}</span>
  </div>

</div>
</body>
</html>`;
}

// ─── 포토오버레이-사이드형 ───
// 레이아웃: 배경이미지 + 좌측 다크 그라디언트 + 상단→하단 세로 흐름 텍스트
function generatePhotoSideHTML(d, bgColor = '#1a1a1a', bgImageBase64 = null, cssBackground = null, font = 'Pretendard', ctaColor = null) {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);
  const bgBase = bgColor || '#1a1a1a';
  const bgStyle = bgImageBase64
    ? `background:#000`
    : cssBackground
    ? `background:${cssBackground}`
    : `background:linear-gradient(135deg,${bgBase} 0%,#080808 100%)`;

  const ctaBg = ctaColor || 'linear-gradient(90deg,#FF4B6E,#FF7040)';

  const ctaBadgeHtml = d.cta_badge
    ? `<span data-field="cta_badge" style="font-size:20px;font-weight:800;color:#fff;background:rgba(255,255,255,0.2);padding:6px 18px;border-radius:30px;white-space:nowrap;flex-shrink:0">${d.cta_badge}</span>`
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
  <div style="position:absolute;bottom:0;left:0;right:0;height:100px;background:linear-gradient(to bottom,transparent,rgba(0,0,0,0.6));z-index:1;pointer-events:none"></div>

  <!-- 브랜드 태그 (상단 좌) -->
  <div data-brand-block style="position:absolute;left:64px;top:56px;display:flex;align-items:center;gap:10px;z-index:10">
    <div style="width:24px;height:24px;background:rgba(255,255,255,0.9);border-radius:4px;flex-shrink:0"></div>
    <span data-field="brand" style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-0.3px">${d.brand || '브랜드'}</span>
  </div>

  <!-- 훅 (중상단) -->
  <div data-field="hook" style="position:absolute;left:64px;top:200px;right:420px;z-index:10;
    font-size:36px;font-weight:600;color:rgba(255,255,255,0.72);letter-spacing:-0.8px;line-height:1.4">${nl2br(d.hook)}</div>

  <!-- 메인카피 (중앙 좌) -->
  <div style="position:absolute;left:64px;top:380px;right:380px;z-index:10;
    font-size:${hlSize}px;font-weight:900;color:#fff;letter-spacing:-2.5px;line-height:1.06">
    <span data-field="headline_line1">${hl1}</span><br>
    <span data-field="headline_line2">${hl2}</span>
  </div>

  <!-- CTA 바 (하단) -->
  <div style="position:absolute;bottom:0;left:0;right:0;padding:24px 64px;background:${ctaBg};display:flex;align-items:center;gap:14px;z-index:10">
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
    <div data-brand-block style="font-size:26px;font-weight:700;color:#fff;margin-bottom:32px;display:flex;align-items:center;gap:10px">
      <div style="width:28px;height:28px;background:rgba(255,255,255,0.9);border-radius:6px;flex-shrink:0"></div>
      <span data-field="brand">${d.brand || '브랜드'}</span>
    </div>

    <!-- 훅 -->
    <div data-field="hook" style="font-size:30px;font-weight:500;color:${pal.hook};margin-bottom:14px;letter-spacing:-0.5px">${nl2br(d.hook)}</div>

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
    <div data-brand-block style="font-size:26px;font-weight:700;color:#fff;margin-bottom:40px;display:flex;align-items:center;gap:10px">
      <div style="width:28px;height:28px;background:rgba(255,255,255,0.9);border-radius:6px;flex-shrink:0"></div>
      <span data-field="brand">${d.brand || '브랜드'}</span>
    </div>
    <div data-field="hook" style="font-size:28px;font-weight:500;color:${pal.hook};margin-bottom:18px;letter-spacing:-0.3px">${nl2br(d.hook)}</div>
    <div data-field="headline" style="font-size:96px;font-weight:900;line-height:1.02;color:${pal.headline};letter-spacing:-4px;margin-bottom:56px">${d.headline || ''}</div>
    <div style="display:flex;flex-direction:column;gap:22px">
      ${[d.sub_copy1, d.sub_copy2, d.sub_copy3].filter(Boolean).map((copy, idx) => `
      <div style="display:flex;align-items:center;gap:18px">
        <div style="width:30px;height:30px;border-radius:50%;background:${pal.check};flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;font-weight:900">✓</div>
        <div data-field="sub_copy${idx+1}" style="font-size:34px;font-weight:600;color:${pal.sub};letter-spacing:-0.5px;white-space:pre-wrap">${nl2br(copy)}</div>
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

// ─────────────────────────────────────────────────────────────────
// ─── [FIGMA] 기본형 포토오버레이 — 피그마 6461:516 그대로 ───
// ─────────────────────────────────────────────────────────────────
function generateFigmaPhotoHTML(d, bgColor = '#1a1a1a', bgImageBase64 = null, cssBackground = null, font = 'Pretendard') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);

  // 배경: 이미지 우선, 없으면 다크 그라디언트
  const hasBg = !!bgImageBase64;
  const bgStyle = hasBg
    ? `background:#000`
    : cssBackground
    ? `background:${cssBackground}`
    : `background:linear-gradient(150deg,${bgColor} 0%,#060606 100%)`;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}</style>
</head>
<body>
<div style="width:1080px;height:1080px;position:relative;overflow:hidden;${bgStyle}">

  ${hasBg ? `
  <!-- 배경 사진 (full-bleed) -->
  <img src="${bgImageBase64}" style="position:absolute;inset:0;width:1080px;height:1080px;object-fit:cover;object-position:center top;z-index:0;pointer-events:none" />` : ''}

  <!-- 피그마 그라디언트 오버레이 레이어 (하단→중앙 다크) -->
  <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.97) 0%,rgba(0,0,0,0.92) 12%,rgba(0,0,0,0.72) 38%,rgba(0,0,0,0.30) 58%,rgba(0,0,0,0.05) 75%,transparent 100%);z-index:1;pointer-events:none"></div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:560px;background:linear-gradient(to top,rgba(0,0,0,0.95) 0%,rgba(0,0,0,0.6) 40%,transparent 100%);z-index:1;pointer-events:none"></div>

  <!-- 브랜드 태그 (상단 좌) -->
  <div data-brand-block style="position:absolute;left:62px;top:52px;display:flex;align-items:center;gap:10px;z-index:10">
    <div style="width:26px;height:26px;background:rgba(255,255,255,0.92);border-radius:5px;flex-shrink:0"></div>
    <span data-field="brand" style="font-size:23px;font-weight:700;color:#fff;letter-spacing:-0.3px;text-shadow:0 1px 6px rgba(0,0,0,0.6)">${d.brand || '브랜드'}</span>
  </div>

  <!-- 훅 문구 (피그마 top≈502px, 50px Regular) -->
  <div data-field="hook" style="position:absolute;left:75px;top:502px;right:80px;z-index:10;font-size:42px;font-weight:400;color:rgba(255,255,255,0.88);letter-spacing:-0.84px;line-height:1.4;text-shadow:0 2px 8px rgba(0,0,0,0.5)">
    ${nl2br(d.hook)}
  </div>

  <!-- 메인 헤드라인 (피그마 top≈589px, 80px Bold) -->
  <!-- line1: 흰색 / line2: 시안(#01f7ff) — 피그마 accent 색상 -->
  <div style="position:absolute;left:75px;top:600px;right:60px;z-index:10;font-size:80px;font-weight:900;letter-spacing:-2px;line-height:1.08;text-shadow:0 3px 14px rgba(0,0,0,0.7)">
    <span data-field="headline_line1" style="color:#fff">${d.headline_line1 || ''}</span><br>
    <span data-field="headline_line2" style="color:#01f7ff">${d.headline_line2 || ''}</span>
  </div>

  <!-- CTA 바 (피그마: #20f4f4 배경, 검정 텍스트, height 120px) -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:120px;background:#20f4f4;display:flex;align-items:center;justify-content:center;gap:16px;z-index:10;padding:0 62px">
    ${d.cta_badge ? `<span data-field="cta_badge" style="font-size:22px;font-weight:800;color:#000;background:rgba(0,0,0,0.1);padding:5px 16px;border-radius:30px;white-space:nowrap;flex-shrink:0">${d.cta_badge}</span>` : ''}
    <span data-field="cta_text" style="font-size:40px;font-weight:900;color:#000;letter-spacing:-1.5px;white-space:nowrap">${d.cta_text || '지금 바로 시작하기 →'}</span>
  </div>

</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────
// ─── [FIGMA] 커뮤니티형 트위터 — 피그마 6461:170 그대로 ───
// ─────────────────────────────────────────────────────────────────
function generateFigmaTwitterHTML(d, bgColor = '#1B5BD4', font = 'Pretendard') {
  const { link: fontLink, family: fontFamily } = getAdFontCSS(font);

  // 아바타 색: bgColor 기준 (브랜드 컬러)
  const avatarColor = bgColor || '#1B5BD4';
  const brandInitial = (d.brand || 'B').charAt(0).toUpperCase();
  const twitterHandle = '@' + (d.brand || 'brand').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  // 조회수: visual_stat1_value 재활용, 없으면 기본값
  const views = d.visual_stat1_value || '24만';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<link href="${fontLink}" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;font-family:${fontFamily}}</style>
</head>
<body>
<div style="width:1080px;height:1080px;position:relative;overflow:hidden;background:#171f2a">

  <!-- 브랜드 블록 표시 여부 토글 영역 (상단 프로필) -->
  <div data-brand-block>
    <!-- 프로필 원형 아바타 (피그마 left:47, top:49, 190px) -->
    <div style="position:absolute;left:47px;top:49px;width:190px;height:190px;border-radius:50%;background:${avatarColor};display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0">
      <span style="font-size:84px;font-weight:900;color:#fff">${brandInitial}</span>
    </div>
    <!-- 유저명 (피그마: 60px, top≈66px) -->
    <div data-field="brand" style="position:absolute;left:264px;top:56px;font-size:52px;font-weight:600;color:rgba(255,255,255,0.92);letter-spacing:-0.5px;white-space:nowrap;line-height:1.2">${d.brand || '브랜드'}</div>
    <!-- @핸들 (피그마: 60px gray, top≈142px) -->
    <div style="position:absolute;left:264px;top:134px;font-size:46px;font-weight:400;color:#858d98;white-space:nowrap;line-height:1.2">${twitterHandle}</div>
  </div>

  <!-- 더보기 점 (우상단, 피그마 right:159px top:33px) -->
  <div style="position:absolute;right:47px;top:52px;font-size:40px;color:#858d98;letter-spacing:5px">···</div>

  <!-- 메인 트윗 본문 (피그마 left:53, top:286, 63px, line-height:100px) -->
  <div style="position:absolute;left:53px;top:286px;right:53px;z-index:10;line-height:100px;letter-spacing:-1.26px">
    <div data-field="hook" style="font-size:57px;font-weight:400;color:#fff">${nl2br(d.hook)}</div>
    <div data-field="headline_line1" style="font-size:57px;font-weight:400;color:#fff">${d.headline_line1 || ''}</div>
    <div data-field="headline_line2" style="font-size:57px;font-weight:700;color:#fff">${d.headline_line2 || ''}</div>
  </div>

  <!-- 조회수 + 시간 (피그마 left:53, top:633) -->
  <div style="position:absolute;left:53px;top:608px;font-size:40px;color:#858d98;line-height:1;white-space:nowrap">
    오후 7:35 · 2025. 12. 18. · 조회 <strong style="color:#fff">${views}</strong>회
  </div>

  <!-- 구분선 (피그마 top:733, left:72) -->
  <div style="position:absolute;top:693px;left:72px;right:83px;height:1px;background:rgba(255,255,255,0.15)"></div>

  <!-- 리플 프로필 (피그마 left:51, top:800, 185px) -->
  <div style="position:absolute;left:51px;top:728px;width:148px;height:148px;border-radius:50%;background:${avatarColor};display:flex;align-items:center;justify-content:center;flex-shrink:0">
    <span style="font-size:60px;font-weight:900;color:#fff">${brandInitial}</span>
  </div>

  <!-- 리플 유저명 + 핸들 + 날짜 (피그마 left:264, top:771) -->
  <div style="position:absolute;left:220px;top:744px;font-size:34px;color:rgba(255,255,255,0.88);white-space:nowrap;line-height:1.2">
    ${d.brand || '브랜드'} <span style="color:#858d98">${twitterHandle} · 2025. 12. 18</span>
  </div>

  <!-- 리플 CTA 텍스트 (피그마 left:266, top:849, 45px) -->
  <div data-field="cta_text" style="position:absolute;left:220px;top:802px;right:53px;font-size:40px;font-weight:400;color:#fff;line-height:68px">
    ${d.cta_text || '지금 신청하기 →'}
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
        messages: [{ role: 'user', content: `사용자 입력 "${userHint}"을 Instagram 1:1 광고 배경 이미지 생성용 영어 프롬프트로 발전시켜라. 어두운 톤, 텍스트 가독성 확보, 추상적 배경. 인물이 포함될 경우 한국인/동아시아인 외모(Korean/East Asian appearance)로 명시할 것. 마크다운 금지, 제목 금지, 2-3문장 순수 텍스트만:` }],
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
  const claudePrompt = `아래 META 인스타그램 광고소재를 위한 gpt-image-1 이미지 생성 프롬프트를 한국어와 영어 두 가지로 작성하라.

광고 정보:
- 브랜드/도메인: ${brand}
- 광고 컨텍스트: ${contextDesc || '프리미엄 교육/서비스 광고'}${hintLine}

요구사항:
1. 텍스트(흰색 카피)가 올라갈 배경 이미지 — 복잡하지 않고 깔끔하게
2. 어두운 톤 (검정/네이비/딥퍼플 계열) 또는 브랜드 특성에 맞는 무드
3. 추상적/시네마틱 스타일: 빛 줄기, 보케, 그라디언트, 기하학적 패턴 등 활용
4. 1:1 정사각형, 1080×1080px Instagram 광고 배경
5. 브랜드/서비스 특성에 맞는 시각적 모티프 (교육이면 집중/성장, 테크면 미래/네트워크 등)
6. 이미지 안에 텍스트 없음
7. 인물이 포함될 경우 반드시 한국인/동아시아인 외모로 (Korean/East Asian appearance, not Western)

출력 형식 (아래 형식 그대로, 레이블 포함):
[한국어]
(한국어 프롬프트 3-4문장)

[English]
(영어 프롬프트 3-4문장)`;

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

// ─── 카탈로그 미리보기 (샘플 광고소재 9종 HTML 반환) ───
app.get('/api/catalog-preview', (req, res) => {
  const SAMPLE = {
    brand: 'AdCraft',
    hook: 'AI가 만드는 퍼포먼스 광고',
    headline_line1: '3분 만에',
    headline_line2: '광고 완성',
    visual_stat1_value: '9종',
    visual_stat1_label: 'AI 광고소재 자동화 플랫폼',
    visual_stat2_value: '3분',
    visual_stat2_label: '평균 생성',
    cta_badge: '✨ 무료 시작',
    cta_text: '지금 바로 시작하기 →',
    footnote: null,
    // 강사강조형
    instructor_name: '김지현',
    instructor_title: '현) AI 마케팅 랩 대표',
    instructor_career: '전) 패스트캠퍼스 콘텐츠 디렉터',
    instructor_bullet1: '광고소재 200+ 직접 제작',
    instructor_bullet2: 'AI 캠페인 ROAS 4.2× 달성',
    instructor_bullet3: '누적 수강생 3,200명+',
    usp_module1: 'AI 카피 생성', usp_module2: '레이아웃 9종',
    usp_module3: '이미지 자동화', usp_module4: '즉시 다운로드',
    // 세미나형
    instructor_subtitle: 'AI 마케팅의 모든 것',
    // SNS형
    post_username: '마케터_지현',
    post_body: 'AI로 만든 광고가 수작업보다 더 높은 ROAS가 나왔어요.\n3분이면 9종 레이아웃이 다 나오니까 A/B 테스트도 훨씬 편해졌습니다.',
    // 비교형
    comparison_a_label: '수작업',
    comparison_b_label: 'AdCraft',
    comparison_items: [
      { stage:'카피작성', a_state:'2시간', b_state:'AI 30초' },
      { stage:'디자인', a_state:'외주 필요', b_state:'자동 생성' },
      { stage:'이미지', a_state:'별도 구매', b_state:'AI 생성' },
      { stage:'배리에이션', a_state:'1개', b_state:'9종 선택' },
      { stage:'비용', a_state:'30만원+', b_state:'월정액' },
    ],
    // 커리큘럼형
    curriculum_step1: 'URL 입력',
    curriculum_step2: '카피 생성',
    curriculum_step3: '레이아웃',
    curriculum_step4: '이미지 AI',
    curriculum_step5: '다운로드',
    curriculum_badge: '5단계\nAll-in-One',
    // 후기사례형
    review_body1: '**하루 2시간** 걸리던 광고가 3분으로!',
    review_body2: '**ROAS 4.2×** 달성, 놀라운 결과',
    review_body3: '팀 전체가 쓰는 **필수 툴**이 됐어요',
  };

  const LAYOUTS = [
    { type: 'photo-overlay', name: '기본형',       desc: '포토 오버레이 기본',         bgColor: '#1B3B6F' },
    { type: 'twitter',       name: '커뮤니티형',   desc: '소셜 피드 스타일',           bgColor: '#15202b' },
    { type: 'instructor',    name: '강사강조형',   desc: '강사 프로필 + USP 카드',     bgColor: '#f59e0b' },
    { type: 'seminar',       name: '세미나형',     desc: '라이브·이벤트 유도',         bgColor: '#7c3aed' },
    { type: 'sns-post',      name: 'SNS UI형',    desc: '커뮤니티 Q&A 포스트',        bgColor: '#1877f2' },
    { type: 'comparison',    name: '비교형',       desc: 'Before / After 비교표',     bgColor: '#1a1a2e' },
    { type: 'image-hero',    name: '이미지강조형', desc: '풀블리드 드라마틱 비주얼',    bgColor: '#0f172a' },
    { type: 'curriculum',    name: '커리큘럼형',   desc: '로드맵 타임라인 + 섬네일',   bgColor: '#0a0e1a' },
    { type: 'review',        name: '후기사례형',   desc: '기업 로고 그리드 소셜 증명', bgColor: '#1B5BD4' },
  ];

  const previews = LAYOUTS.map(({ type, name, desc, bgColor }) => {
    const adData = { ...SAMPLE, layout_type: type, variation_label: name };
    try {
      const html = generateAdHTML(adData, bgColor, null, null, 'Pretendard', null, null, {}, '2026.06.01', '무료 LIVE');
      return { type, name, desc, bgColor, html };
    } catch (e) {
      return { type, name, desc, bgColor, html: `<p style="color:red">Error: ${e.message}</p>` };
    }
  });

  res.json({ previews });
});

// ─── 페이지 정보 추출 (Figma 플러그인용: URL → brand/target/USP 빠르게 반환) ───
app.post('/api/extract-info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL 필요' });
  try {
    const { text: pageContent } = await fetchPageContent(url);
    const info = await extractPageInfo(pageContent);
    res.json({ info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── URL 기반 배경 이미지 자동생성 (Figma 플러그인용: URL → 한국인 이미지) ───
app.post('/api/generate-bg-image', async (req, res) => {
  const { url, hint = '' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL 필요' });
  if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY 미설정 — 프로덕션 환경에서 사용해주세요' });
  try {
    const { text: pageContent } = await fetchPageContent(url);
    const prompt = buildAutoBgPrompt(null, pageContent, hint);
    console.log('[🎨 Figma 배경 생성] 시작:', prompt.slice(0, 80) + '...');
    const imageData = await generateImageWithGPT(prompt);
    res.json({ imageData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI 레이어 자동 매핑 (Figma 플러그인: 레이어 목록 + 카피 → 매핑 반환) ───
app.post('/api/match-layers', async (req, res) => {
  const { layers, adCopy } = req.body;
  if (!layers?.length || !adCopy) return res.status(400).json({ error: '필수 파라미터 없음' });
  if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY 미설정' });

  const FIELD_LABELS = {
    hook: '서브카피(Hook)',
    headline_line1: '헤드라인 1',
    headline_line2: '헤드라인 2',
    cta_text: 'CTA 버튼 텍스트',
    visual_stat1_value: '수치 값',
    visual_stat1_label: '수치 라벨',
    brand: '브랜드명',
  };

  try {
    const layerDesc = layers.map(l =>
      `id="${l.id}" | 이름="${l.name}" | 현재텍스트="${l.chars}" | fontSize=${l.fontSize ?? '?'}`
    ).join('\n');

    const copyDesc = Object.entries(FIELD_LABELS)
      .filter(([k]) => adCopy[k])
      .map(([k, label]) => `${k} (${label}): "${adCopy[k]}"`)
      .join('\n');

    const prompt = `Figma 광고 프레임의 텍스트 레이어를 광고 카피 필드에 매핑해줘.

## 텍스트 레이어 목록
${layerDesc}

## 삽입할 광고 카피
${copyDesc}

## 판단 기준
- hook: 서브카피/아이캐처, 문장형, 작은~중간 폰트, 상단 위치
- headline_line1 / headline_line2: 핵심 메시지, 크고 굵음, 1줄씩 나뉨
- cta_text: 버튼 안 텍스트, 매우 짧고 행동 유도
- visual_stat1_value: 숫자/퍼센트만 들어가는 자리 (예: "5,000+" "98%")
- visual_stat1_label: 수치 옆 설명 (예: "누적 수강생" "만족도")
- brand: 브랜드명/로고 텍스트
- 매핑 제외: 날짜, 아이콘(★✓→►), 빈 레이어, 장식 텍스트

레이어 이름 + 현재 텍스트 + fontSize를 종합해서 판단.
동일 field에 여러 레이어 매핑 불가 (1:1).

JSON만 출력 (코드블록 없이):
{"matches":[{"layerId":"...","field":"hook","reason":"한 줄 근거"},...]}`;

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 600,
      temperature: 0,
    });

    const parsed = JSON.parse(resp.choices[0].message.content);
    // 각 field 중복 매핑 방지
    const seen = new Set();
    const deduped = (parsed.matches || []).filter(m => {
      if (seen.has(m.field)) return false;
      seen.add(m.field);
      return true;
    });
    console.log('[🗺️ 레이어 매핑]', deduped.map(m => `${m.field}→"${m.layerId.slice(-6)}"`).join(' | '));
    res.json({ matches: deduped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 이미지 생성 (1순위: gpt-image-1 / 폴백: Pollinations FLUX) ───
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt 필요' });

  console.log('[🎨 이미지 생성] 시작 | 프롬프트:', prompt.slice(0, 80) + '...');

  // 1순위: gpt-image-1 (OpenAI)
  if (process.env.OPENAI_API_KEY) {
    try {
      console.log('[🖼 gpt-image-1] 요청 중...');
      const imageData = await generateImageWithGPT(prompt);
      console.log('[🖼 gpt-image-1] 성공');
      return res.json({ imageData, model: 'gpt-image-1', type: 'image' });
    } catch (err) {
      console.warn('[gpt-image-1 오류]', err.message);
    }
  }

  // 2순위 폴백: Pollinations.ai (무료, API 키 불필요)
  try {
    const seed = Math.floor(Math.random() * 99999);
    const encoded = encodeURIComponent(prompt);
    const polUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1080&height=1080&nologo=true&seed=${seed}&model=flux`;

    console.log('[🌸 Pollinations 폴백] 요청 중...');
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

  return res.status(500).json({ error: '이미지 생성에 실패했습니다. 잠시 후 다시 시도해주세요.' });
});

// ─── 👤 회원가입 ───
app.post('/api/auth/signup', async (req, res) => {
  const { email, name } = req.body;
  if (!email || !name) return res.status(400).json({ error: '이름과 이메일을 입력해주세요.' });

  // Supabase 미설정 시 개발 모드
  if (!SUPABASE_URL) return res.json({ user: { id: 'local', email, name } });

  // 이미 가입된 이메일이면 해당 사용자 반환
  const { data: existing } = await supabaseQuery('users', 'GET', null, `?email=eq.${encodeURIComponent(email)}&limit=1`);
  if (existing && existing.length > 0) return res.json({ user: existing[0] });

  const { data, error } = await supabaseQuery('users', 'POST', { email, name });
  if (error) return res.status(500).json({ error });
  const user = Array.isArray(data) ? data[0] : data;
  res.json({ user });
});

// ─── 👤 로그인 (이메일 조회) ───
app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '이메일을 입력해주세요.' });

  if (!SUPABASE_URL) return res.json({ user: { id: 'local', email, name: '테스트' } });

  const { data, error } = await supabaseQuery('users', 'GET', null, `?email=eq.${encodeURIComponent(email)}&limit=1`);
  if (error) return res.status(500).json({ error });
  if (!data || data.length === 0) return res.status(404).json({ error: '가입된 이메일이 없습니다. 먼저 회원가입해주세요.' });
  res.json({ user: data[0] });
});

// ─── 배경 이미지 적용 후 HTML 재생성 ───
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

// 로컬 개발 환경에서만 listen (Vercel 서버리스는 export default 사용)
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('  AI 광고소재 자동화');
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✅ 설정됨' : '❌ ANTHROPIC_API_KEY 필요'}`);
    console.log(`  OpenAI:    ${process.env.OPENAI_API_KEY ? '✅ 설정됨 (gpt-image-1 활성)' : '⚠️  OPENAI_API_KEY 없음 (Pollinations 폴백)'}`);
    console.log('='.repeat(50));
  });
}

export default app;
