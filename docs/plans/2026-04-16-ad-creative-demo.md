# Ad Creative Auto-Generator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상세페이지 URL을 입력하면 메타(Facebook/Instagram) 광고 카피 10개 이상을 자동 생성하는 웹 데모

**Architecture:** Node.js Express 서버가 URL 크롤링 + Claude API 호출을 처리하고, 단일 HTML 페이지가 결과를 렌더링한다. 서버-클라이언트 분리로 API 키를 안전하게 유지한다.

**Tech Stack:** Node.js 25, Express 4, @anthropic-ai/sdk, node-html-parser, dotenv, Tailwind CSS (CDN)

---

## File Structure

```
hackathon-demo/
├── server.js              # Express 서버 + /api/crawl + /api/generate 엔드포인트
├── public/
│   └── index.html         # 단일 페이지 UI (Tailwind CSS, vanilla JS)
├── package.json
└── .env                   # ANTHROPIC_API_KEY (git ignore)
```

---

## Task 1: 프로젝트 초기화

**Files:**
- Create: `hackathon-demo/package.json`
- Create: `hackathon-demo/.env`

- [ ] **Step 1: package.json 생성**

```json
{
  "name": "ad-creative-demo",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "express": "^4.18.2",
    "node-html-parser": "^6.1.13",
    "dotenv": "^16.4.5"
  }
}
```

- [ ] **Step 2: 의존성 설치**

```bash
cd hackathon-demo
npm install
```

Expected: `node_modules/` 생성, `package-lock.json` 생성

- [ ] **Step 3: .env 파일 생성**

```
ANTHROPIC_API_KEY=sk-ant-여기에_실제_키_입력
PORT=3000
```

- [ ] **Step 4: .gitignore 생성**

```
node_modules/
.env
```

---

## Task 2: Express 서버 기본 골격

**Files:**
- Create: `hackathon-demo/server.js`

- [ ] **Step 1: 서버 기본 구조 작성**

```js
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
```

- [ ] **Step 2: 서버 실행 확인**

```bash
node server.js
```

Expected: `Server running at http://localhost:3000`
브라우저에서 `http://localhost:3000/health` → `{"status":"ok"}`

---

## Task 3: URL 크롤링 엔드포인트

**Files:**
- Modify: `hackathon-demo/server.js` — `/api/crawl` 엔드포인트 추가

- [ ] **Step 1: crawl 엔드포인트 추가 (server.js의 `/health` 아래에 삽입)**

```js
import { parse } from 'node-html-parser';

app.post('/api/crawl', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다' });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const root = parse(html);

    // 스크립트/스타일 제거
    root.querySelectorAll('script, style, nav, footer, header').forEach(el => el.remove());

    // 텍스트 추출 (최대 3000자)
    const text = root.innerText
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);

    // 제목 추출
    const title = root.querySelector('title')?.text?.trim() || '';
    const h1 = root.querySelector('h1')?.text?.trim() || '';
    const metaDesc = root.querySelector('meta[name="description"]')?.getAttribute('content') || '';

    res.json({ title, h1, metaDesc, text });
  } catch (err) {
    res.status(500).json({ error: `크롤링 실패: ${err.message}` });
  }
});
```

- [ ] **Step 2: 크롤링 테스트**

```bash
curl -X POST http://localhost:3000/api/crawl \
  -H "Content-Type: application/json" \
  -d '{"url":"https://fastcampus.co.kr/b2g_innercircle_ba"}'
```

Expected: `{"title":"...","text":"..."}`

---

## Task 4: Claude API 광고 카피 생성 엔드포인트

**Files:**
- Modify: `hackathon-demo/server.js` — `/api/generate` 엔드포인트 추가

- [ ] **Step 1: Anthropic 클라이언트 초기화 (파일 상단 import 블록에 추가)**

```js
import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

- [ ] **Step 2: generate 엔드포인트 추가**

```js
app.post('/api/generate', async (req, res) => {
  const { pageContent, url } = req.body;
  if (!pageContent) return res.status(400).json({ error: '페이지 콘텐츠가 필요합니다' });

  const prompt = `다음은 상품/서비스 상세페이지의 내용입니다:

URL: ${url}
제목: ${pageContent.title}
H1: ${pageContent.h1}
메타 설명: ${pageContent.metaDesc}
본문 텍스트: ${pageContent.text}

위 내용을 분석해서 메타(Facebook/Instagram) 광고 소재를 생성해주세요.

다음 6가지 앵글로 각 2개씩, 총 12개의 광고 소재를 만들어주세요:
1. 통증/고민 (타겟의 문제 공감)
2. 결과/변화 (얻게 될 것)
3. 신뢰/증거 (수치, 인증, 후기)
4. 긴급성 (지금 행동해야 하는 이유)
5. 정체성 (이런 사람을 위한)
6. 비교 (기존 방법과 다른 점)

각 소재는 반드시 다음 형식으로 출력하세요:

[앵글명]
Primary Text (125자 이내): ...
Headline (40자 이내): ...
Description (30자 이내): ...
이미지 방향: ...

---

중요:
- Primary Text는 첫 문장에 훅을 배치할 것
- 한국어로 작성
- 글자 수 제한 엄수
- 상세페이지 실제 내용 기반으로 작성 (지어내지 말 것)`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0].text;

    // 소재 파싱
    const ads = parseAdCreatives(raw);

    res.json({ ads, raw });
  } catch (err) {
    res.status(500).json({ error: `생성 실패: ${err.message}` });
  }
});

function parseAdCreatives(text) {
  const sections = text.split('---').filter(s => s.trim());
  return sections.map(section => {
    const lines = section.trim().split('\n').filter(l => l.trim());
    const angle = lines[0]?.replace(/^\[|\]$/g, '').trim() || '소재';
    const get = (key) => {
      const line = lines.find(l => l.startsWith(key));
      return line ? line.replace(`${key}:`, '').trim() : '';
    };
    return {
      angle,
      primaryText: get('Primary Text (125자 이내)'),
      headline: get('Headline (40자 이내)'),
      description: get('Description (30자 이내)'),
      imageDirection: get('이미지 방향'),
    };
  }).filter(ad => ad.primaryText);
}
```

- [ ] **Step 3: 생성 테스트**

```bash
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","pageContent":{"title":"테스트","h1":"테스트 상품","metaDesc":"","text":"테스트 상품입니다. 품질이 좋습니다."}}'
```

Expected: `{"ads":[...],"raw":"..."}`

---

## Task 5: 프론트엔드 UI

**Files:**
- Create: `hackathon-demo/public/index.html`

- [ ] **Step 1: 전체 HTML 작성**

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>광고소재 자동 생성기</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .loading-dots::after {
      content: '';
      animation: dots 1.5s steps(4, end) infinite;
    }
    @keyframes dots {
      0%, 20% { content: ''; }
      40% { content: '.'; }
      60% { content: '..'; }
      80%, 100% { content: '...'; }
    }
  </style>
</head>
<body class="bg-gray-50 min-h-screen font-sans">

  <!-- 헤더 -->
  <header class="bg-white border-b border-gray-200 px-6 py-4">
    <div class="max-w-4xl mx-auto flex items-center gap-3">
      <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
        <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
        </svg>
      </div>
      <div>
        <h1 class="text-lg font-bold text-gray-900">광고소재 자동 생성기</h1>
        <p class="text-xs text-gray-500">상세페이지 URL → 메타 광고 카피 12개 자동 생성</p>
      </div>
    </div>
  </header>

  <main class="max-w-4xl mx-auto px-6 py-8">

    <!-- 입력 섹션 -->
    <div class="bg-white rounded-2xl border border-gray-200 p-6 mb-6 shadow-sm">
      <label class="block text-sm font-semibold text-gray-700 mb-2">상세페이지 URL</label>
      <div class="flex gap-3">
        <input
          id="urlInput"
          type="url"
          placeholder="https://example.com/product/..."
          class="flex-1 border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          value="https://fastcampus.co.kr/b2g_innercircle_ba"
        />
        <button
          id="generateBtn"
          onclick="generate()"
          class="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-3 rounded-xl text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          생성하기
        </button>
      </div>
      <p class="text-xs text-gray-400 mt-2">크롤링 → 분석 → 카피 생성까지 약 15~30초 소요</p>
    </div>

    <!-- 상태 표시 -->
    <div id="statusSection" class="hidden mb-6">
      <div class="bg-blue-50 border border-blue-100 rounded-xl p-4 flex items-center gap-3">
        <div class="animate-spin w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full"></div>
        <p id="statusText" class="text-sm text-blue-700 font-medium loading-dots">상세페이지 분석 중</p>
      </div>
    </div>

    <!-- 에러 표시 -->
    <div id="errorSection" class="hidden mb-6">
      <div class="bg-red-50 border border-red-100 rounded-xl p-4">
        <p id="errorText" class="text-sm text-red-700"></p>
      </div>
    </div>

    <!-- 결과 섹션 -->
    <div id="resultsSection" class="hidden">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-base font-bold text-gray-900">생성된 광고 소재</h2>
        <div class="flex gap-2">
          <span id="adCount" class="text-xs bg-blue-100 text-blue-700 font-semibold px-3 py-1 rounded-full"></span>
          <button onclick="copyAll()" class="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 font-medium px-3 py-1 rounded-full transition-colors">전체 복사</button>
        </div>
      </div>
      <div id="adGrid" class="grid gap-4"></div>
    </div>

  </main>

  <script>
    let allAds = [];

    async function generate() {
      const url = document.getElementById('urlInput').value.trim();
      if (!url) return alert('URL을 입력해주세요');

      const btn = document.getElementById('generateBtn');
      btn.disabled = true;
      showStatus('상세페이지 크롤링 중');
      hideError();
      hideResults();

      try {
        // Step 1: Crawl
        const crawlRes = await fetch('/api/crawl', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const pageContent = await crawlRes.json();
        if (!crawlRes.ok) throw new Error(pageContent.error);

        // Step 2: Generate
        showStatus('Claude AI로 광고 카피 생성 중');
        const genRes = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, pageContent }),
        });
        const result = await genRes.json();
        if (!genRes.ok) throw new Error(result.error);

        allAds = result.ads;
        renderAds(result.ads);
        hideStatus();
      } catch (err) {
        hideStatus();
        showError(err.message);
      } finally {
        btn.disabled = false;
      }
    }

    function renderAds(ads) {
      const grid = document.getElementById('adGrid');
      document.getElementById('adCount').textContent = `${ads.length}개 생성`;
      grid.innerHTML = ads.map((ad, i) => `
        <div class="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-lg">${ad.angle}</span>
            <button onclick="copySingle(${i})" class="text-xs text-gray-400 hover:text-gray-600">복사</button>
          </div>
          <div class="space-y-3">
            <div>
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Primary Text</p>
              <p class="text-sm text-gray-800 leading-relaxed">${ad.primaryText}</p>
              <p class="text-xs text-gray-300 mt-1">${ad.primaryText.length}자</p>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Headline</p>
                <p class="text-sm font-semibold text-gray-800">${ad.headline}</p>
                <p class="text-xs text-gray-300">${ad.headline.length}자</p>
              </div>
              <div>
                <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Description</p>
                <p class="text-sm text-gray-600">${ad.description}</p>
                <p class="text-xs text-gray-300">${ad.description.length}자</p>
              </div>
            </div>
            ${ad.imageDirection ? `
            <div class="bg-gray-50 rounded-lg p-3">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">이미지 방향</p>
              <p class="text-xs text-gray-600">${ad.imageDirection}</p>
            </div>` : ''}
          </div>
        </div>
      `).join('');
      document.getElementById('resultsSection').classList.remove('hidden');
    }

    function copySingle(i) {
      const ad = allAds[i];
      const text = `[${ad.angle}]\nPrimary Text: ${ad.primaryText}\nHeadline: ${ad.headline}\nDescription: ${ad.description}`;
      navigator.clipboard.writeText(text).then(() => alert('복사됨!'));
    }

    function copyAll() {
      const text = allAds.map(ad =>
        `[${ad.angle}]\nPrimary Text: ${ad.primaryText}\nHeadline: ${ad.headline}\nDescription: ${ad.description}\n`
      ).join('\n---\n\n');
      navigator.clipboard.writeText(text).then(() => alert(`${allAds.length}개 소재 복사됨!`));
    }

    function showStatus(msg) {
      document.getElementById('statusText').textContent = msg;
      document.getElementById('statusSection').classList.remove('hidden');
    }
    function hideStatus() { document.getElementById('statusSection').classList.add('hidden'); }
    function showError(msg) {
      document.getElementById('errorText').textContent = msg;
      document.getElementById('errorSection').classList.remove('hidden');
    }
    function hideError() { document.getElementById('errorSection').classList.add('hidden'); }
    function hideResults() { document.getElementById('resultsSection').classList.add('hidden'); }

    // Enter 키 지원
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('urlInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') generate();
      });
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: 브라우저에서 UI 확인**

`http://localhost:3000` 접속 → URL 입력창과 생성 버튼이 보이면 OK

---

## Task 6: 통합 테스트 & 실행

- [ ] **Step 1: 서버 재시작**

```bash
cd hackathon-demo
node server.js
```

- [ ] **Step 2: 엔드-투-엔드 테스트**

1. 브라우저에서 `http://localhost:3000` 열기
2. URL 입력란에 `https://fastcampus.co.kr/b2g_innercircle_ba` 입력
3. "생성하기" 클릭
4. 크롤링 → 생성 상태 메시지 확인
5. 12개 광고 소재 카드 렌더링 확인
6. "전체 복사" 버튼 테스트

Expected: 12개 카드가 앵글별로 표시되고, 각 카드에 Primary Text / Headline / Description / 이미지 방향이 포함됨

- [ ] **Step 3: .env에 실제 API 키 확인**

```
ANTHROPIC_API_KEY=sk-ant-...  # 실제 키가 입력돼 있어야 함
```

---

## 완성 파일 목록

```
hackathon-demo/
├── server.js           ← Task 2~4에서 작성
├── public/
│   └── index.html      ← Task 5에서 작성
├── package.json        ← Task 1에서 작성
├── package-lock.json   ← npm install 시 자동 생성
└── .env                ← Task 1에서 작성 (API 키)
```
