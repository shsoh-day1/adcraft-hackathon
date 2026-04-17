import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parse } from 'node-html-parser';
import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    bg_color = '#1B5BD4'
  } = req.body;

  if (!url) return res.status(400).json({ error: 'URL이 필요합니다' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되지 않았습니다.' });
  }

  try {
    // Step 1: 페이지 크롤링
    const pageContent = await fetchPageContent(url);
    console.log('[크롤링 완료]', pageContent.slice(0, 80));

    // Step 2: 레퍼런스 이미지 분석 (선택)
    const styleAnalysis = reference_images.length > 0
      ? await analyzeReferenceImages(reference_images)
      : null;
    if (styleAnalysis) console.log('[이미지 분석 완료]', styleAnalysis.slice(0, 80));

    // Step 3: 카피 배리에이션 3종 생성
    const adDataList = await extractAdDataVariations(pageContent, styleAnalysis, {
      target, usp1, usp2, usp3, ad_set_message, creative_message
    });
    console.log('[배리에이션 생성 완료]', adDataList.length, '종');

    // Step 4: 각 배리에이션 HTML 생성
    const variations = adDataList.map(adData => ({
      adData,
      html: generateAdHTML(adData, bg_color)
    }));

    res.json({ variations });
  } catch (err) {
    console.error('[오류]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 이미지 URL 프록시 (Meta 광고 라이브러리 등 공개 이미지) ───
app.post('/api/fetch-image', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다' });

  const ALLOWED_HOSTS = [
    'fbcdn.net', 'facebook.com', 'fbsbx.com',
    'cdninstagram.com', 'instagram.com',
    'scontent', // fbcdn 서브도메인 패턴
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

// ─── 페이지 크롤링 ───
async function fetchPageContent(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`크롤링 실패: HTTP ${res.status}`);
  const html = await res.text();
  const root = parse(html);
  root.querySelectorAll('script, style, nav, footer, header').forEach(el => el.remove());
  return root.innerText.replace(/\s+/g, ' ').trim().slice(0, 3000);
}

// ─── 레퍼런스 이미지 분석 ───
async function analyzeReferenceImages(images) {
  try {
    const content = [{
      type: 'text',
      text: `아래 레퍼런스 광고 이미지들을 분석해서 공통 디자인 패턴을 JSON으로 반환하라.
분석 항목: bg_hex(배경색), headline_hex(헤드라인 색), cta_hex(CTA 색), style_mood(분위기 키워드 3개), layout_note(레이아웃 특징 1줄)
JSON만 반환.`,
    }];

    for (const imgData of images.slice(0, 3)) {
      const match = imgData.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
      }
    }

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content }],
    });
    return msg.content[0].text;
  } catch (e) {
    console.warn('[이미지 분석 실패]', e.message);
    return null;
  }
}

// ─── 카피 배리에이션 3종 생성 ───
async function extractAdDataVariations(pageContent, styleAnalysis, info) {
  const styleHint = styleAnalysis ? `\n\n레퍼런스 스타일 분석:\n${styleAnalysis}` : '';
  const { target, usp1, usp2, usp3, ad_set_message, creative_message } = info;

  const prompt = `아래 정보를 바탕으로 META 인스타그램 1:1 광고소재 카피를 3가지 배리에이션으로 작성하라.

## 소재 기본 정보
- 과정 타겟: ${target}
- USP 1: ${usp1}
- USP 2: ${usp2}
- USP 3: ${usp3}
- 광고세트 메시지: ${ad_set_message}
- 소재 메시지: ${creative_message}

## 상세페이지 내용 (참고)
${pageContent}${styleHint}

## 배리에이션 앵글 (반드시 각 앵글에 맞게 작성)
- A (혜택형): 구체적 수치·성과·혜택을 직접적으로 강조. 숫자가 있다면 적극 활용.
- B (공감형): 타겟의 고민·상황에 공감하며 감성적으로 접근.
- C (긴박형): 지금 행동해야 하는 이유, 한정성·기회비용을 강조.

## 각 필드 규칙
- hook: 훅 텍스트. 최대 25자.
- headline_line1, headline_line2: 각 줄 최대 12자. 임팩트 있는 2줄 헤드라인.
- visual_stat1_value: 카드에 표시할 수치 (예: "3,200+"). 없으면 null.
- visual_stat1_label: 수치 설명 (예: "누적 수강생"). 없으면 null.
- visual_stat2_value: 두 번째 수치. 없으면 null.
- visual_stat2_label: 두 번째 수치 설명. 없으면 null.
- cta_badge: 이모지 포함 최대 12자 (예: "📊 데이터 역량 UP")
- cta_text: 행동 유도 최대 24자. "→"로 끝내기.
- footnote: 주석(*로 시작). 없으면 null.

JSON 배열만 반환 (주석·설명 없이):
[
  {"variation_label":"A - 혜택형","brand":"","hook":"","headline_line1":"","headline_line2":"","visual_stat1_value":null,"visual_stat1_label":null,"visual_stat2_value":null,"visual_stat2_label":null,"cta_badge":"","cta_text":"","footnote":null},
  {"variation_label":"B - 공감형","brand":"","hook":"","headline_line1":"","headline_line2":"","visual_stat1_value":null,"visual_stat1_label":null,"visual_stat2_value":null,"visual_stat2_label":null,"cta_badge":"","cta_text":"","footnote":null},
  {"variation_label":"C - 긴박형","brand":"","hook":"","headline_line1":"","headline_line2":"","visual_stat1_value":null,"visual_stat1_label":null,"visual_stat2_value":null,"visual_stat2_label":null,"cta_badge":"","cta_text":"","footnote":null}
]`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0].text.trim();
  const match = raw.match(/\[[\s\S]+\]/);
  if (!match) throw new Error('배리에이션 데이터 파싱 실패');
  return JSON.parse(match[0]);
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

// ─── HTML 생성 ───
function generateAdHTML(d, bgColor = '#1B5BD4') {
  // 밝기에 따라 텍스트/카드 색상 결정
  const lum = luminance(bgColor);
  const isDark = lum < 140;
  const lightEnd = lighten(bgColor, isDark ? 40 : -30);
  const pal = {
    bg:       `linear-gradient(160deg,${bgColor},${lightEnd})`,
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
        <div style="font-size:${d.visual_stat1_value.length > 4 ? 52 : 64}px;font-weight:900;letter-spacing:-3px;color:${pal.card_text};line-height:1">${d.visual_stat1_value}</div>
        ${d.visual_stat1_label ? `<div style="font-size:18px;font-weight:600;color:${pal.card_text};opacity:0.6">${d.visual_stat1_label}</div>` : ''}
      </div>`;
    }
    if (d.visual_stat2_value) {
      cards += `<div style="flex:0.7;height:220px;border-radius:20px;background:${pal.card_bg};box-shadow:0 20px 50px rgba(0,0,0,0.25);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px">
        <div style="font-size:${d.visual_stat2_value.length > 4 ? 44 : 56}px;font-weight:900;letter-spacing:-3px;color:${pal.card_text};line-height:1">${d.visual_stat2_value}</div>
        ${d.visual_stat2_label ? `<div style="font-size:16px;font-weight:600;color:${pal.card_text};opacity:0.6">${d.visual_stat2_label}</div>` : ''}
      </div>`;
    }
    return cards;
  })();

  const footnoteHtml = d.footnote
    ? `<div style="font-size:22px;color:rgba(255,255,255,0.5);text-align:right;padding:0 64px 12px">${d.footnote}</div>`
    : '';

  const ctaBadgeHtml = d.cta_badge
    ? `<div style="font-size:24px;font-weight:800;color:#fff;background:rgba(0,0,0,0.18);padding:6px 18px;border-radius:30px;white-space:nowrap">${d.cta_badge}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<link href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:1080px;height:1080px;overflow:hidden;font-family:'Pretendard','Apple SD Gothic Neo',sans-serif}
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
      ${d.brand || '브랜드'}
    </div>

    <!-- 훅 -->
    <div style="font-size:30px;font-weight:500;color:${pal.hook};margin-bottom:14px;letter-spacing:-0.5px">${d.hook || ''}</div>

    <!-- 헤드라인 -->
    <div style="font-size:80px;font-weight:900;line-height:1.08;color:${pal.headline};letter-spacing:-2px">
      ${d.headline_line1 || ''}<br>${d.headline_line2 || ''}
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
    <div style="font-size:27px;font-weight:700;color:#fff;letter-spacing:-0.5px;white-space:nowrap">${d.cta_text || '지금 바로 시작하기 →'}</div>
  </div>

</div>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('  AI 광고소재 자동화');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  API KEY: ${process.env.ANTHROPIC_API_KEY ? '✅ 설정됨' : '❌ ANTHROPIC_API_KEY 필요'}`);
  console.log('='.repeat(50));
});
