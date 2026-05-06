// AdCraft Figma Plugin — code.js (Figma sandbox)
// 역할: 레이어 스캔, 카피 주입, 이미지 주입

figma.showUI(__html__, { width: 400, height: 640, title: 'AdCraft — AI 광고소재' });

// ── 텍스트 레이어 전체 스캔 (재귀) ──
function scanTextLayers(node, result = []) {
  if (node.type === 'TEXT') {
    result.push({
      id: node.id,
      name: node.name,
      chars: node.characters.slice(0, 80),
      fontSize: node.fontSize !== figma.mixed ? node.fontSize : null,
    });
  }
  if ('children' in node) {
    for (const child of node.children) {
      scanTextLayers(child, result);
    }
  }
  return result;
}

// ── 이미지/도형 레이어 스캔 (배경 이미지용) ──
function scanImageLayers(node, result = []) {
  if (
    (node.type === 'RECTANGLE' || node.type === 'FRAME' || node.type === 'VECTOR') &&
    /bg|background|배경|image|img|photo|사진/i.test(node.name)
  ) {
    result.push({ id: node.id, name: node.name });
  }
  if ('children' in node) {
    for (const child of node.children) {
      scanImageLayers(child, result);
    }
  }
  return result;
}

// ── 선택된 프레임 정보를 UI로 전송 ──
function sendSelectionInfo() {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) {
    figma.ui.postMessage({ type: 'no-selection' });
    return;
  }
  const node = sel[0];
  const textLayers = scanTextLayers(node);
  const imageLayers = scanImageLayers(node);
  figma.ui.postMessage({
    type: 'selection-info',
    frameName: node.name,
    textLayers,
    imageLayers,
  });
}

// ── UI → code.js 메시지 처리 ──
figma.ui.onmessage = async (msg) => {

  // 선택 정보 요청
  if (msg.type === 'get-selection') {
    sendSelectionInfo();
  }

  // 카피 레이어에 주입
  if (msg.type === 'apply-copy') {
    const { mapping } = msg; // { layerId: "텍스트 값", ... }
    const sel = figma.currentPage.selection;
    if (sel.length === 0) {
      figma.ui.postMessage({ type: 'error', message: '프레임을 선택해주세요.' });
      return;
    }

    async function applyToNode(node) {
      if (node.type === 'TEXT' && mapping[node.id] !== undefined && mapping[node.id] !== '') {
        try {
          // 폰트 로드 (mixed font 대응)
          if (node.fontName !== figma.mixed) {
            await figma.loadFontAsync(node.fontName);
          } else {
            // mixed font: 첫 번째 문자의 폰트 로드
            const firstFont = node.getRangeFontName(0, 1);
            await figma.loadFontAsync(firstFont);
          }
          node.characters = mapping[node.id];
        } catch (e) {
          console.error('폰트 로드 실패:', node.name, e.message);
        }
      }
      if ('children' in node) {
        for (const child of node.children) {
          await applyToNode(child);
        }
      }
    }

    await applyToNode(sel[0]);
    figma.ui.postMessage({ type: 'apply-done' });
  }

  // 배경 이미지 레이어에 주입
  if (msg.type === 'apply-image') {
    const { layerId, imageBase64 } = msg;
    const node = figma.getNodeById(layerId);
    if (!node || !('fills' in node)) {
      figma.ui.postMessage({ type: 'error', message: '이미지 레이어를 찾을 수 없습니다.' });
      return;
    }
    try {
      const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
      const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      const image = figma.createImage(bytes);
      node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
      figma.ui.postMessage({ type: 'image-done' });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: '이미지 적용 실패: ' + e.message });
    }
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};

// 초기 선택 스캔
sendSelectionInfo();

// 선택 변경 감지
figma.on('selectionchange', sendSelectionInfo);
