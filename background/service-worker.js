// Service Worker 入口：
// 1. 网络嗅探（webRequest）：捕获 m3u8 清单（扩展名 + Content-Type 双重识别）与常见直链视频
// 2. 消息路由：与 content script / popup / options 页面通信
// 3. 保活与恢复：定时 alarm 唤醒，断点续传中断的 m3u8 任务
import {
  createTask, cancelTask, retryTask, removeTask, clearFinishedTasks, resumePendingTasks,
  onDownloadChanged, onBlobMeta, onBlobChunk, onBlobError, onBlobDone,
  getSettings, saveSettings, getTasks, cleanupFinishedRules
} from './task-manager.js';

// ============ 全局错误捕获 ============

// 捕获所有未处理的异步错误，避免静默失败导致"只显示失败、无任何日志"难以排查
self.addEventListener('unhandledrejection', (event) => {
  console.error('[视频下载] 未处理的异步错误:', event.reason);
});
self.addEventListener('error', (event) => {
  console.error('[视频下载] 未捕获的脚本错误:', event.message, event.filename, event.lineno);
});

// ============ 网络嗅探 ============

const M3U8_EXT_REGEX = /\.(m3u8|m3u)(\?|#|$)/i;
// m4s：B 站等 DASH 站点的独立音视频流（视频/音频分离，需分别下载后合并）
const DIRECT_EXT_REGEX = /\.(mp4|flv|webm|mov|mkv|avi|m4v|m4s|mp3|m4a|aac|wav|ogg)(\?|#|$)/i;
const detectedVideos = new Map(); // tabId → Map<kind|url, videoInfo>（SW 内存，重启后由重扫恢复）

// B 站 DASH 音频流的 stream id 集合（用于区分视频流/音频流，仅对 bilibili 域名生效）
const BILI_AUDIO_STREAM_IDS = new Set([30216, 30232, 30280, 30250, 30251, 30279, 30249]);

// 爱奇艺分片请求计数：播放器会按字节范围多次拉取同一文件（start/end 参数），
// 归一化后同一 URL 被请求 ≥2 次才注册为视频条目——
// m3u8 里解析出的死链分片不会产生页面请求，天然被过滤掉
const iqiyiRangeCounts = new Map();
const IQIYI_RANGE_THRESHOLD = 2;

// 爱奇艺私有流判定：/videos/vts/ 路径的 .ts/.265ts + start/end 字节范围参数
function isIqiyiSegmentUrl(url) {
  try {
    const parsed = new URL(url);
    return /\/videos\/vts\//.test(parsed.pathname)
      && /\.(ts|265ts)$/i.test(parsed.pathname)
      && parsed.searchParams.has('start')
      && parsed.searchParams.has('end');
  } catch {
    return false;
  }
}

// 归一化：去掉字节范围参数（start/end/contentlength/num）得到整文件直链。
// 已实测：爱奇艺 CDN 鉴权完全在 URL 上，去掉范围参数即可整文件下载
function normalizeIqiyiSegmentUrl(url) {
  try {
    const parsed = new URL(url);
    ['start', 'end', 'contentlength', 'num'].forEach((p) => parsed.searchParams.delete(p));
    return parsed.href;
  } catch {
    return null;
  }
}

// 爱奇艺 bid（码率档位）→ 清晰度标签
function iqiyiQualityLabel(url) {
  try {
    const bid = new URL(url).searchParams.get('bid') || '';
    const map = { 200: '270P', 300: '360P', 500: '480P', 600: '720P', 700: '1080P', 800: '1080P高码率', 900: '4K' };
    return map[bid] || (bid ? `清晰度${bid}` : '');
  } catch {
    return '';
  }
}

// 识别 DASH 流类型：B 站从 m4s 文件名中的流 id 判断音/视频；其它站点统一标 dash
function detectStreamType(videoUrl, pageUrl) {
  if (!/\.m4s(\?|#|$)/i.test(videoUrl)) return '';
  try {
    const host = new URL(pageUrl).hostname;
    if (!/(^|\.)bilibili\.com$/i.test(host)) return 'dash';
    const match = new URL(videoUrl).pathname.match(/-(\d+)\.m4s$/i);
    return match && BILI_AUDIO_STREAM_IDS.has(Number(match[1])) ? 'audio' : 'video';
  } catch {
    return 'dash';
  }
}

// 按扩展名识别 m3u8 与直链视频请求
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return; // 非页面发起的请求
    const url = details.url;
    if (M3U8_EXT_REGEX.test(url)) {
      registerDetected(details, 'm3u8');
    } else if (DIRECT_EXT_REGEX.test(url)) {
      registerDetected(details, 'direct');
    } else if (isIqiyiSegmentUrl(url)) {
      registerIqiyiSegment(details);
    }
  },
  { urls: ['<all_urls>'] }
);

// 按响应头 Content-Type 识别不带 .m3u8 扩展名的清单（很多站点清单地址无扩展名）
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const header = (details.responseHeaders || []).find(
      (h) => h.name.toLowerCase() === 'content-type'
    );
    if (header && /mpegurl/i.test(header.value || '')) {
      registerDetected(details, 'm3u8');
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// 注册嗅探到的视频条目（去重合并，附带页面标题供文件名使用）
async function registerDetected(details, kind) {
  const { tabId, url, frameId } = details;
  if (!/^https?:/i.test(url)) return;
  const key = `${kind}|${url}`;
  const tabVideos = getOrCreateTabMap(tabId);
  if (tabVideos.has(key)) return;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  tabVideos.set(key, {
    key, url, kind, tabId, frameId: frameId ?? 0,
    pageTitle: tab?.title || '',
    pageUrl: tab?.url || '',
    streamType: detectStreamType(url, tab?.url || ''),
    detectedAt: Date.now(),
    source: 'network'
  });
}

function getOrCreateTabMap(tabId) {
  let tabVideos = detectedVideos.get(tabId);
  if (!tabVideos) {
    tabVideos = new Map();
    detectedVideos.set(tabId, tabVideos);
  }
  return tabVideos;
}

// 注册爱奇艺整文件视频条目：播放器按字节范围多次请求同一文件，
// 累计次数达到阈值后注册（归一化 URL 去重，不同清晰度为不同文件）
async function registerIqiyiSegment(details) {
  const fullUrl = normalizeIqiyiSegmentUrl(details.url);
  if (!fullUrl) return;
  const count = (iqiyiRangeCounts.get(fullUrl) || 0) + 1;
  iqiyiRangeCounts.set(fullUrl, count);
  if (count < IQIYI_RANGE_THRESHOLD) return;

  const key = `direct|${fullUrl}`;
  const tabVideos = getOrCreateTabMap(details.tabId);
  if (tabVideos.has(key)) return;

  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  tabVideos.set(key, {
    key, url: fullUrl, kind: 'direct', tabId: details.tabId,
    frameId: details.frameId ?? 0,
    pageTitle: tab?.title || '',
    pageUrl: tab?.url || '',
    quality: iqiyiQualityLabel(fullUrl), // 清晰度标签（480P/720P/...）
    detectedAt: Date.now(),
    source: 'network'
  });
}

// 页面关闭时清理该页的嗅探记录
chrome.tabs.onRemoved.addListener((tabId) => {
  detectedVideos.delete(tabId);
});

// ============ 消息路由 ============

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse(result || { ok: true }))
    .catch((err) => sendResponse({ error: err.message || String(err) }));
  return true; // 保持消息通道开放以支持异步响应
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'PAGE_INFO':
      return handlePageInfo(msg, sender);
    case 'GET_STATE':
      return getState(msg.tabId);
    case 'START_DOWNLOAD': {
      const settings = await getSettings();
      return await createTask(msg.video, msg.fileName, settings);
    }
    case 'CANCEL_TASK':
      return await cancelTask(msg.taskId);
    case 'RETRY_TASK':
      return await retryTask(msg.taskId);
    case 'REMOVE_TASK':
      return await removeTask(msg.taskId);
    case 'CLEAR_TASKS':
      return await clearFinishedTasks();
    case 'GET_SETTINGS':
      return await getSettings();
    case 'SAVE_SETTINGS':
      return await saveSettings(msg.patch);
    case 'BLOB_META':
      return await onBlobMeta(msg);
    case 'BLOB_CHUNK':
      return await onBlobChunk(msg);
    case 'BLOB_ERROR':
      return await onBlobError(msg);
    case 'BLOB_DONE':
      return await onBlobDone(msg);
    default:
      return { ok: true };
  }
}

// content script 上报页面内的 video/audio 元素（含 blob 源）
async function handlePageInfo(msg, sender) {
  const tab = sender.tab;
  if (!tab || !tab.id || !Array.isArray(msg.videos)) return;
  const tabVideos = getOrCreateTabMap(tab.id);
  for (const video of msg.videos) {
    if (!video.src || !/^(https?|blob:)/i.test(video.src)) continue;
    const kind = video.src.startsWith('blob:') ? 'blob' : 'direct';
    const key = `${kind}|${video.src}`;
    const extra = {
      duration: video.duration,
      width: video.width,
      height: video.height,
      isAudio: video.tag === 'audio',
      source: 'page',
      frameId: sender.frameId ?? 0
    };
    const existing = tabVideos.get(key);
    if (existing) {
      Object.assign(existing, extra); // 更新时长/尺寸等元信息
    } else {
      tabVideos.set(key, {
        key, url: video.src, kind, tabId: tab.id,
        frameId: sender.frameId ?? 0,
        pageTitle: tab.title || '',
        pageUrl: msg.url || tab.url || '',
        detectedAt: Date.now(),
        ...extra
      });
    }
  }
}

// 返回 popup 所需的完整状态：当前页视频列表 + 全部任务 + 设置
async function getState(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const videos = [...(detectedVideos.get(tabId)?.values() || [])].sort(
    (a, b) => b.detectedAt - a.detectedAt
  );
  // 页面标题可能已变化（SPA），统一刷新为最新标题
  const pageTitle = tab?.title || '';
  if (pageTitle) {
    videos.forEach((v) => { v.pageTitle = pageTitle; });
  }
  const tasks = (await getTasks()).slice().reverse(); // 最新任务在前
  return { videos, tasks, settings: await getSettings(), pageTitle, pageUrl: tab?.url || '' };
}

// ============ 下载状态跟踪与保活恢复 ============

chrome.downloads.onChanged.addListener(onDownloadChanged);

// 定时唤醒：恢复中断任务 + 回收过期的 DNR 规则，同时防止下载期间 SW 被提前回收
chrome.alarms.create('task-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async () => {
  await resumePendingTasks();
  await cleanupFinishedRules();
});

// SW 每次被事件唤醒都会执行到这里；有进行中的任务则尝试恢复（内部有防重入）
resumePendingTasks();
