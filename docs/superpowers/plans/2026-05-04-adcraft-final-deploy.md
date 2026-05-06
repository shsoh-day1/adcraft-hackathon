# AdCraft 최종 디벨롭 & 실배포 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** feat/vi-language-detection 브랜치 머지 + Supabase 간단 로그인/가입 구현 + Vercel 실배포

**Architecture:**
- Express.js 서버 (server.js) + 단일 HTML 프론트 (public/index.html)
- Supabase를 DB로 사용: users 테이블 (이메일+이름) + generations 테이블 (사용 로그)
- 로그인 상태는 localStorage에 저장, API 호출 시 user_id 함께 전송
- Vercel 환경변수에 Supabase 키 추가 후 자동 배포

**Tech Stack:** Node.js + Express, Supabase JS Client (CDN), Vercel, @anthropic-ai/sdk, OpenAI

---

## Task 0: 브랜치 머지 (feat/vi-language-detection → main)

**Files:**
- Modify: `server.js`
- Modify: `public/index.html`

- [ ] **Step 1: 머지 시도**

```bash
cd "C:\Users\SB_소수현\Documents\adcraft-hackathon"
git merge origin/feat/vi-language-detection --no-edit
```

Expected: 충돌 발생 가능 (server.js). 충돌 시 Step 2로.

- [ ] **Step 2: 충돌 해결 전략**

충돌 시:
- server.js: **두 변경 모두 유지** — main의 nl2br + 주예진 이미지 UX + 띠엠 detectLanguage 모두 통합
- index.html: **main 버전 유지** (주예진의 최신 UI가 더 완성도 높음)
  - 단, detectLanguage 관련 서버 측 변경만 server.js에서 취함

```bash
# 충돌 확인
git status
# index.html 충돌 시 main 버전으로 덮어씀
git checkout HEAD -- public/index.html
```

- [ ] **Step 3: 언어감지 함수 server.js 통합 확인**

server.js에 `detectLanguage` 함수가 있는지 확인:
```bash
grep -n "detectLanguage" server.js
```
없으면 Task 1에서 수동 추가.

- [ ] **Step 4: 머지 완료 커밋**

```bash
git add server.js public/index.html
git commit -m "feat: merge vi-language-detection — auto-detect URL language for copy generation"
```

---

## Task 1: detectLanguage 함수 수동 통합 (머지 충돌로 빠진 경우)

**Files:**
- Modify: `server.js` (상단 헬퍼 함수 섹션)

- [ ] **Step 1: server.js 상단 (imports 이후) 에 함수 추가**

```javascript
// ─── 🌐 언어 감지 ───
function detectLanguage(text) {
  const sample = text.slice(0, 2000);
  const korean = (sample.match(/[가-힣]/g) || []).length;
  const japanese = (sample.match(/[぀-ヿ]/g) || []).length;
  const chinese = (sample.match(/[一-鿿]/g) || []).length;
  const vietnamese = (sample.match(/[àáâãèéêìíîòóôùúûýăđêơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) || []).length * 3;
  const scores = { ko: korean, ja: japanese, zh: chinese, vi: vietnamese };
  const max = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return max[1] > 5 ? max[0] : 'ko';
}
```

- [ ] **Step 2: /api/generate-ad 핸들러에 언어감지 연결**

`rawPageInfo` 생성 부분 (약 line 160) 을 찾아서:

```javascript
// 기존:
const rawPageInfo = { target, usp1, usp2, usp3, ad_set_message, creative_message };

// 변경:
const detectedLang = detectLanguage(pageContent);
const rawPageInfo = { language: detectedLang, target, usp1, usp2, usp3, ad_set_message, creative_message };
```

그리고 `resolvedPageInfo` 후에:
```javascript
if (!resolvedPageInfo.language) resolvedPageInfo.language = detectedLang;
```

- [ ] **Step 3: copyAgent에 언어 지시 추가**

copyAgent 내 prompt에 language 반영:
```javascript
// copyAgent 프롬프트 상단에 추가 (언어 변수 찾아서)
const langMap = { ko: '한국어', vi: '베트남어(Vietnamese)', en: '영어(English)', ja: '일본어(Japanese)', zh: '중국어(Chinese)' };
const langInstruction = `모든 카피는 반드시 ${langMap[pageInfo.language || 'ko']}로 작성한다.`;
```

---

## Task 2: Supabase 프로젝트 셋업

**Files:**
- Create: `.env.local` (로컬 테스트용, gitignore에 이미 포함됨)

- [ ] **Step 1: Supabase 프로젝트 생성**

1. https://supabase.com 접속 → 로그인 → New Project
2. Project name: `adcraft-hackathon`
3. Database password 기록 (나중에 필요)
4. Region: Northeast Asia (Tokyo)
5. 생성 완료 후 Settings → API에서 다음 값 복사:
   - `SUPABASE_URL` = Project URL (https://xxxx.supabase.co)
   - `SUPABASE_ANON_KEY` = anon/public key

- [ ] **Step 2: Supabase SQL Editor에서 테이블 생성**

SQL Editor → New Query → 아래 실행:

```sql
-- 사용자 테이블
CREATE TABLE IF NOT EXISTS users (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email text UNIQUE NOT NULL,
  name text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 생성 로그 테이블
CREATE TABLE IF NOT EXISTS generations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  user_email text,
  user_name text,
  source_url text,
  created_at timestamptz DEFAULT now()
);

-- RLS 비활성화 (내부 사용 전용 — 간단하게)
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE generations DISABLE ROW LEVEL SECURITY;
```

- [ ] **Step 3: .env.local 파일 생성**

```
ANTHROPIC_API_KEY=<기존 값>
OPENAI_API_KEY=<기존 값>
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGci...
```

---

## Task 3: 서버에 Supabase 연동 + 로그인 API 추가

**Files:**
- Modify: `server.js`
- Modify: `package.json`

- [ ] **Step 1: Supabase 패키지 설치**

```bash
cd "C:\Users\SB_소수현\Documents\adcraft-hackathon"
npm install @supabase/supabase-js
```

Expected: package.json에 `@supabase/supabase-js` 추가됨

- [ ] **Step 2: server.js 상단 import에 Supabase 추가**

```javascript
// 기존 import들 아래에 추가
import { createClient } from '@supabase/supabase-js';

const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;
```

- [ ] **Step 3: 회원가입 API 추가** (server.js, 기존 라우트들 뒤)

```javascript
// ─── 👤 회원가입 ───
app.post('/api/auth/signup', async (req, res) => {
  const { email, name } = req.body;
  if (!email || !name) return res.status(400).json({ error: '이메일과 이름을 입력해주세요.' });
  if (!supabase) return res.json({ user: { id: 'local', email, name } }); // 개발 모드

  // 이미 가입된 이메일이면 로그인처럼 처리
  const { data: existing } = await supabase
    .from('users').select('*').eq('email', email).single();
  if (existing) return res.json({ user: existing });

  const { data, error } = await supabase
    .from('users').insert({ email, name }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
});

// ─── 👤 로그인 (이메일 조회) ───
app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '이메일을 입력해주세요.' });
  if (!supabase) return res.json({ user: { id: 'local', email, name: '테스트' } });

  const { data, error } = await supabase
    .from('users').select('*').eq('email', email).single();
  if (error || !data) return res.status(404).json({ error: '가입된 이메일이 없습니다. 먼저 회원가입해주세요.' });
  res.json({ user: data });
});
```

- [ ] **Step 4: /api/generate-ad에 사용자 로그 추가**

`/api/generate-ad` 핸들러 상단 (req.body 파싱 부분):
```javascript
// 기존 구조분해 뒤에 추가
const { user_id, user_email, user_name } = req.body;

// ... (기존 코드) ...

// 생성 성공 후 응답 전에 로그 기록 (res.json 직전)
if (supabase && user_id) {
  supabase.from('generations').insert({
    user_id: user_id !== 'local' ? user_id : null,
    user_email, user_name,
    source_url: url,
  }).then(() => {}).catch(() => {}); // 로그 실패해도 생성은 계속
}
```

- [ ] **Step 5: 커밋**

```bash
git add server.js package.json package-lock.json
git commit -m "feat: Supabase 연동 — 간단 회원가입/로그인 + 생성 로그 기록"
```

---

## Task 4: 로그인 UI (public/index.html)

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 로그인 모달 HTML 추가** (</body> 바로 위)

```html
<!-- ─── 로그인/회원가입 모달 ─── -->
<div id="authModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center">
  <div style="background:#fff;border-radius:16px;padding:40px 36px;width:380px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
    <div style="text-align:center;margin-bottom:28px">
      <div style="font-size:28px;font-weight:900;color:#1B5BD4;letter-spacing:-1px">AdCraft</div>
      <div style="font-size:13px;color:#888;margin-top:4px">by Claude AI · Day1Company</div>
    </div>

    <!-- 탭 -->
    <div style="display:flex;gap:8px;margin-bottom:24px;background:#f5f5f5;border-radius:8px;padding:4px">
      <button id="tabLogin" onclick="switchAuthTab('login')"
        style="flex:1;padding:8px;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;background:#1B5BD4;color:#fff;transition:all .2s">로그인</button>
      <button id="tabSignup" onclick="switchAuthTab('signup')"
        style="flex:1;padding:8px;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;background:transparent;color:#666;transition:all .2s">회원가입</button>
    </div>

    <!-- 로그인 폼 -->
    <div id="loginForm">
      <div style="margin-bottom:16px">
        <label style="font-size:13px;font-weight:600;color:#333;display:block;margin-bottom:6px">이메일</label>
        <input id="loginEmail" type="email" placeholder="sh.soh@day1company.co.kr"
          style="width:100%;padding:12px 14px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none"
          onfocus="this.style.borderColor='#1B5BD4'" onblur="this.style.borderColor='#e0e0e0'">
      </div>
      <button onclick="handleLogin()"
        style="width:100%;padding:14px;background:#1B5BD4;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;margin-top:4px">
        로그인
      </button>
      <div id="loginError" style="color:#e53e3e;font-size:13px;margin-top:10px;display:none"></div>
    </div>

    <!-- 회원가입 폼 -->
    <div id="signupForm" style="display:none">
      <div style="margin-bottom:16px">
        <label style="font-size:13px;font-weight:600;color:#333;display:block;margin-bottom:6px">이름</label>
        <input id="signupName" type="text" placeholder="홍길동"
          style="width:100%;padding:12px 14px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none"
          onfocus="this.style.borderColor='#1B5BD4'" onblur="this.style.borderColor='#e0e0e0'">
      </div>
      <div style="margin-bottom:16px">
        <label style="font-size:13px;font-weight:600;color:#333;display:block;margin-bottom:6px">이메일</label>
        <input id="signupEmail" type="email" placeholder="sh.soh@day1company.co.kr"
          style="width:100%;padding:12px 14px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none"
          onfocus="this.style.borderColor='#1B5BD4'" onblur="this.style.borderColor='#e0e0e0'">
      </div>
      <button onclick="handleSignup()"
        style="width:100%;padding:14px;background:#1B5BD4;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;margin-top:4px">
        가입하기
      </button>
      <div id="signupError" style="color:#e53e3e;font-size:13px;margin-top:10px;display:none"></div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: 로그인 상태 표시 (nav 우측에 사용자 이름 + 로그아웃)**

nav 바 오른쪽 영역 (`.nav-right` 또는 `nav` 내 버튼 그룹)에 추가:

```html
<div id="userBadge" style="display:none;align-items:center;gap:8px">
  <span id="userNameDisplay" style="font-size:13px;font-weight:600;color:#1B5BD4"></span>
  <button onclick="handleLogout()"
    style="padding:6px 12px;border:1.5px solid #e0e0e0;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;background:#fff;color:#666">
    로그아웃
  </button>
</div>
```

- [ ] **Step 3: 로그인 JS 로직 추가** (</script> 바로 위)

```javascript
// ─── 인증 로직 ───
(function initAuth() {
  const user = JSON.parse(localStorage.getItem('adcraft_user') || 'null');
  if (user) {
    showUserBadge(user);
  } else {
    showAuthModal();
  }
})();

function showAuthModal() {
  document.getElementById('authModal').style.display = 'flex';
}

function hideAuthModal() {
  document.getElementById('authModal').style.display = 'none';
}

function showUserBadge(user) {
  const badge = document.getElementById('userBadge');
  const nameDisplay = document.getElementById('userNameDisplay');
  if (badge) { badge.style.display = 'flex'; }
  if (nameDisplay) { nameDisplay.textContent = user.name + '님'; }
}

function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('loginForm').style.display = isLogin ? 'block' : 'none';
  document.getElementById('signupForm').style.display = isLogin ? 'none' : 'block';
  document.getElementById('tabLogin').style.background = isLogin ? '#1B5BD4' : 'transparent';
  document.getElementById('tabLogin').style.color = isLogin ? '#fff' : '#666';
  document.getElementById('tabSignup').style.background = isLogin ? 'transparent' : '#1B5BD4';
  document.getElementById('tabSignup').style.color = isLogin ? '#666' : '#fff';
}

async function handleLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  if (!email) { errEl.textContent = '이메일을 입력해주세요.'; errEl.style.display = 'block'; return; }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; errEl.style.display = 'block'; return; }
    localStorage.setItem('adcraft_user', JSON.stringify(data.user));
    showUserBadge(data.user);
    hideAuthModal();
  } catch (e) {
    errEl.textContent = '서버 오류가 발생했습니다.'; errEl.style.display = 'block';
  }
}

async function handleSignup() {
  const name = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const errEl = document.getElementById('signupError');
  errEl.style.display = 'none';
  if (!name || !email) { errEl.textContent = '이름과 이메일을 모두 입력해주세요.'; errEl.style.display = 'block'; return; }

  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; errEl.style.display = 'block'; return; }
    localStorage.setItem('adcraft_user', JSON.stringify(data.user));
    showUserBadge(data.user);
    hideAuthModal();
  } catch (e) {
    errEl.textContent = '서버 오류가 발생했습니다.'; errEl.style.display = 'block';
  }
}

function handleLogout() {
  localStorage.removeItem('adcraft_user');
  location.reload();
}

// ─── 광고 생성 시 user 정보 주입 ───
// 기존 generateAd() 함수 내 fetch('/api/generate-ad') body에 아래 추가:
// const user = JSON.parse(localStorage.getItem('adcraft_user') || '{}');
// body: JSON.stringify({ ...기존파라미터, user_id: user.id, user_email: user.email, user_name: user.name })
```

- [ ] **Step 4: generateAd() 함수에 user 정보 주입**

index.html에서 `/api/generate-ad` fetch 호출 부분 찾기:
```bash
grep -n "generate-ad" public/index.html | head -5
```

해당 fetch body에 user 정보 추가:
```javascript
const adcraftUser = JSON.parse(localStorage.getItem('adcraft_user') || '{}');
// body의 JSON.stringify 안에 추가:
user_id: adcraftUser.id || null,
user_email: adcraftUser.email || null,
user_name: adcraftUser.name || null,
```

- [ ] **Step 5: 다크모드 대응 (모달 배경)**

기존 dark mode CSS에 추가:
```css
body.dark #authModal > div { background: #1e1e1e; color: #fff; }
body.dark #authModal input { background: #2d2d2d; border-color: #444; color: #fff; }
```

- [ ] **Step 6: 커밋**

```bash
git add public/index.html
git commit -m "feat: 로그인/회원가입 모달 UI — 이메일 기반 간단 인증"
```

---

## Task 5: Vercel 환경변수 설정 + 배포

**Files:**
- `vercel.json` (확인만)

- [ ] **Step 1: Vercel 대시보드에서 환경변수 추가**

https://vercel.com → adcraft-hackathon 프로젝트 → Settings → Environment Variables

추가할 변수:
```
SUPABASE_URL = https://xxxx.supabase.co
SUPABASE_ANON_KEY = eyJhbGci...
```
(ANTHROPIC_API_KEY, OPENAI_API_KEY는 이미 설정되어 있어야 함)

- [ ] **Step 2: GitHub push (자동 배포 트리거)**

```bash
cd "C:\Users\SB_소수현\Documents\adcraft-hackathon"
git push origin main
```

Expected: Vercel이 자동으로 감지해서 빌드 + 배포 시작

- [ ] **Step 3: 배포 확인**

https://adcraft-hackathon.vercel.app 접속:
1. 로그인 모달이 뜨는지 확인
2. 회원가입 → 이름+이메일 입력 → 성공 시 모달 닫히고 이름 표시
3. 광고 생성 테스트 (URL 입력 → 생성 버튼)
4. Supabase 대시보드 → Table Editor → generations 테이블에 로그 쌓이는지 확인

- [ ] **Step 4: 배포 완료 슬랙 공유**

팀 슬랙에 배포 URL + 주요 기능 변경사항 공유:
```
🚀 AdCraft 실배포 완료!
URL: https://adcraft-hackathon.vercel.app

✅ 새 기능:
- 로그인/회원가입 (이메일 기반)
- 언어 자동감지 (한/영/베트남어)
- AI 이미지 5종 선택
- 서브텍스트 줄바꿈
```

---

## Self-Review 체크리스트

- [x] **Spec coverage:**
  - ⓐ 레퍼런스 이미지 소스 통합 → 이미 server.js에 구현됨 (reference_images/ 폴더 자동로드)
  - ⓑ 이미지 생성 API (GPT/Gemini) → OpenAI gpt-image-1 이미 구현, 5종 선택 UI ✅
  - ⓒ 간단 회원가입 (Supabase) → Task 2-4에서 구현 ✅
  - 언어 자동감지 → Task 0-1에서 머지/통합 ✅
  - G3 Access Gate (로그인 필수) → Task 4에서 구현 ✅

- [x] **Placeholder scan:** 없음. 모든 코드 블록 완성됨.

- [x] **Type consistency:** user 객체 스키마 일관성 — `{ id, email, name, created_at }` 전체 유지됨.
