// 下载任务管理器：
// - m3u8：清单解析 → 并发切片下载（AES-128 自动解密）→ Cache Storage 暂存 → 合并/分片保存
// - 直链（mp4/flv 等）：直接交给浏览器下载
// - blob：由 content script 分块抓取后合并保存
// 任务状态持久化到 storage.local，Service Worker 重启后可断点续传（m3u8）
import { parseM3U8, inferContainer, ivToBytes } from './m3u8-parser.js';
import { sanitizeFilename, generateTaskId, sleep } from './utils.js';
import { ensureRefererRule, removeRefererRule, cleanupOrphanRules } from './dnr.js';

const TASKS_KEY = 'vd:tasks';
const SETTINGS_KEY = 'vd:settings';
const MAX_TASK_HISTORY = 60;      // 最多保留的历史任务数
const SEGMENT_RETRIES = 3;        // 单个分片最大重试次数
const MAX_CONSECUTIVE_FAILURES = 5; // 连续失败阈值，超过则中止任务
const PERSIST_DEBOUNCE_MS = 400;  // 任务状态写盘节流间隔
const PLAYLIST_TIMEOUT_MS = 20000; // 清单/密钥请求超时（防防盗链 CDN 挂起连接导致任务卡死）
const SEGMENT_TIMEOUT_MS = 60000;  // 单个分片请求超时

const DEFAULT_SETTINGS = {
  rootDir: 'VideoDownloader', // 下载根目录（位于浏览器默认下载目录下）
  autoMerge: true,            // 下载完成后自动合并为单文件
  keepSegments: false,        // 同时保留分片文件（保存到 segments/ 子目录）
  concurrency: 3,             // 分片并发下载数
  nameSource: 'title'         // 默认文件名来源：title=页面标题 / url=地址文件名
};

const runningTaskIds = new Set(); // 正在执行的任务（防重入）
let tasksCache = null;            // 内存中的任务列表（SW 生命周期内有效）
let persistTimer = null;

// ============ 设置与持久化 ============

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

export async function saveSettings(patch) {
  const merged = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}

export async function getTasks() {
  if (!tasksCache) {
    const stored = await chrome.storage.local.get(TASKS_KEY);
    tasksCache = stored[TASKS_KEY] || [];
  }
  return tasksCache;
}

async function persistTasksNow() {
  if (!tasksCache) return;
  await chrome.storage.local.set({ [TASKS_KEY]: tasksCache.slice(-MAX_TASK_HISTORY) });
}

// 节流写盘：分片下载高频更新时避免每片都写 storage
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    await persistTasksNow();
  }, PERSIST_DEBOUNCE_MS);
}

function cacheName(taskId) {
  return `vd-task-${taskId}`;
}

// ============ 任务创建与分发 ============

export async function createTask(video, fileName, settings) {
  const tasks = await getTasks();
  // 同一地址的任务正在进行则拒绝，避免重复下载
  const duplicated = tasks.some(
    (t) => t.url === video.url && ['pending', 'downloading', 'merging'].includes(t.status)
  );
  if (duplicated) {
    return { error: '该视频已有进行中的下载任务（如为残留任务，可在下方任务列表中取消后再试）' };
  }

  const name = sanitizeFilename(fileName, 'video');
  const rootDir = sanitizeFilename(settings.rootDir, 'VideoDownloader');
  const task = {
    id: generateTaskId(),
    kind: video.kind, // m3u8 | direct | blob
    url: video.url,
    name,
    dir: `${rootDir}/${name}`, // 下载目录：根目录/视频名/（相对浏览器默认下载目录）
    ext: video.ext || inferExtFromUrl(video.url, video.kind),
    tabId: video.tabId || 0,
    frameId: video.frameId ?? 0, // blob 源所在的页面 frame（分块抓取时定向发送）
    pageUrl: video.pageUrl || '',
    pageTitle: video.pageTitle || '',
    status: 'pending',
    error: '',
    totalSegments: 0,
    downloadedSegments: 0,
    totalChunks: 0,
    receivedChunks: 0,
    bytes: 0,
    isLive: false,
    downloadIds: [], // 该任务产生的所有浏览器下载项（分片模式会有多个）
    downloadState: '',
    createdAt: Date.now(),
    completedAt: 0
  };
  tasks.push(task);
  await persistTasksNow();
  updateBadge(task);
  console.log('[视频下载] 创建任务:', task.kind, task.name, task.url);
  // 异步执行，不阻塞 popup 响应
  runTask(task, settings);
  return { task };
}

async function runTask(task, settings) {
  if (runningTaskIds.has(task.id)) return;
  runningTaskIds.add(task.id);
  try {
    // 立即转入下载态并落盘：
    // 否则清单拉取阶段（网络慢/CDN 挂起）任务一直显示"排队中"，
    // 且 SW 若在此阶段被浏览器回收，任务会停留在 pending 且无人恢复
    task.status = 'downloading';
    await persistTasksNow();
    // 防盗链：为视频请求注入来源页 Referer（B 站等 CDN 必需，否则 403）
    await ensureRefererRule(task);
    if (task.kind === 'm3u8') {
      await runM3U8Task(task, settings);
    } else if (task.kind === 'direct') {
      await runDirectTask(task);
    } else if (task.kind === 'blob') {
      await runBlobTask(task);
    }
  } catch (err) {
    if (task.status !== 'canceled') { // 已取消的任务不被覆盖为失败
      // 兜底提取错误文案：部分异常对象没有 message（null/字符串/空 Error），
      // 必须保证 task.error 非空，否则用户只看到"失败"无从排查
      const reason = (err && err.message) || (err ? String(err) : '') || '未知错误';
      task.status = 'failed';
      task.error = reason;
      console.error('[视频下载] 任务失败:', task.name, '-', reason, '\n错误堆栈:', (err && err.stack) || '无堆栈信息');
      updateBadge(task);
      await persistTasksNow();
    }
  } finally {
    runningTaskIds.delete(task.id);
    // m3u8/blob 的所有请求已结束，立即移除 Referer 规则；
    // direct 的规则要等浏览器下载完成（onDownloadChanged 中移除），此处跳过
    if (task.kind !== 'direct') {
      await removeRefererRule(task);
    }
    schedulePersist();
  }
}

// ============ m3u8 下载主流程 ============

async function runM3U8Task(task, settings) {
  const cache = await caches.open(cacheName(task.id));

  // 1. 拉取清单；主清单（多码率）自动选取最高码率子清单
  let parsed;
  let mergeOnly = false;
  try {
    parsed = await fetchAndParsePlaylist(task);
    console.log('[视频下载] 清单获取成功:',
      parsed.isMaster ? '主清单' : `${parsed.segments.length} 个分片`,
      task.name);
  } catch (err) {
    // 清单地址可能已过期（签名链接有时效）：
    // 若分片此前已全部下载并缓存，跳过清单直接进入合并
    if (task.totalSegments > 0 && task.downloadedSegments >= task.totalSegments) {
      mergeOnly = true;
      parsed = { mapUri: (await cache.match('map')) ? { url: '' } : null, segments: [] };
    } else {
      throw err;
    }
  }
  if (!mergeOnly && !parsed.segments.length) {
    throw new Error('清单中没有可下载的分片');
  }
  if (task.status === 'canceled') return;

  // 2. 并发下载全部分片（含初始化段与 AES-128 解密），暂存 Cache Storage
  if (!mergeOnly) {
    task.totalSegments = parsed.segments.length;
    task.isLive = parsed.isLive;
    task.ext = inferContainer(parsed); // ts 或 mp4（fMP4）
    // 重置计数后由缓存命中重新统计，避免断点恢复时重复累加
    task.downloadedSegments = 0;

    const keyCache = new Map(); // 密钥地址 → CryptoKey
    const failures = await downloadAllSegments(task, parsed, cache, keyCache, settings);
    console.log('[视频下载] 分片下载完成: 成功', task.downloadedSegments, '/ 共', task.totalSegments, '失败', failures, task.name);
    if (task.status === 'canceled') return;
    if (failures > 0) {
      throw new Error(`${failures} 个分片下载失败，可重试继续断点续传`);
    }
  }

  // 3. 保存（经 offscreen 页面执行）：自动合并为单文件 / 保留分片
  task.status = 'merging';
  await persistTasksNow();
  console.log('[视频下载] 开始合并保存:', task.name, `共 ${task.totalSegments} 片`);
  const keepSegments = settings.keepSegments || !settings.autoMerge; // 两者都关时兜底保留分片
  const result = await saveViaOffscreen({
    taskId: task.id,
    dir: task.dir,
    name: task.name,
    ext: task.ext,
    mime: task.ext === 'mp4' ? 'video/mp4' : 'video/mp2t',
    prefix: 'seg-',
    total: task.totalSegments,
    merge: settings.autoMerge,
    keepSegments,
    cleanup: settings.autoMerge && !keepSegments
  });
  if (result.bytes) task.bytes = result.bytes;

  task.status = 'completed';
  task.completedAt = Date.now();
  updateBadge(task);
  schedulePersist();
}

// 经 offscreen document 完成保存：
// MV3 SW 中 URL.createObjectURL 不可用，合并后的数据无法直接提交下载，
// 由 offscreen 页面从 Cache Storage 取回分片、拼接后提交（消息只能传 JSON，数据走缓存）
async function saveViaOffscreen(job) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_SAVE', job });
  if (!response || response.error) {
    throw new Error(response?.error || '保存服务异常（offscreen 页面无响应）');
  }
  return response;
}

async function ensureOffscreenDocument() {
  // 不用 hasDocument()（部分版本不存在，调用会抛无文案的 TypeError）；
  // 直接创建并忽略"已存在"错误，兼容性最好
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: '合并视频分片并提交下载'
    });
  } catch (err) {
    const message = String((err && err.message) || '');
    // 已存在时会报 "Only a single offscreen document..."，属预期情况
    if (!/single offscreen|already exist/i.test(message)) {
      throw err;
    }
  }
}

// 拉取并解析清单；主清单（多码率）自动选取最高码率子清单
async function fetchAndParsePlaylist(task) {
  let playlistUrl = task.url;
  let parsed = parseM3U8(await fetchText(playlistUrl), playlistUrl);
  if (parsed.isMaster) {
    const best = [...parsed.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
    playlistUrl = best.url;
    parsed = parseM3U8(await fetchText(playlistUrl), playlistUrl);
  }
  return parsed;
}

// 并发下载所有分片；返回失败分片数。已缓存的分片自动跳过（断点续传）
function downloadAllSegments(task, parsed, cache, keyCache, settings) {
  const concurrency = Math.max(1, Math.min(10, settings.concurrency || 3));
  const queue = [];
  if (parsed.mapUri) {
    queue.push({ url: parsed.mapUri.url, cacheKey: 'map', key: parsed.mapUri.key, seq: 0 });
  }
  parsed.segments.forEach((seg, index) => {
    queue.push({
      url: seg.url,
      cacheKey: `seg-${index}`,
      key: seg.key,
      seq: parsed.mediaSequence + index
    });
  });

  return (async () => {
    const pending = [];
    for (const item of queue) {
      if (await cache.match(item.cacheKey)) {
        task.downloadedSegments++; // 断点续传：跳过已完成分片
      } else {
        pending.push(item);
      }
    }
    updateBadge(task);

    let failures = 0;
    let consecutiveFailures = 0;
    let cursor = 0;
    let active = 0;

    await new Promise((resolve) => {
      const launchNext = () => {
        // 停止条件：取消 / 连续失败过多 / 队列耗尽
        while (
          active < concurrency &&
          cursor < pending.length &&
          task.status !== 'canceled' &&
          consecutiveFailures < MAX_CONSECUTIVE_FAILURES
        ) {
          const item = pending[cursor++];
          active++;
          downloadSegment(item, cache, keyCache)
            .then(() => {
              consecutiveFailures = 0;
              task.downloadedSegments++;
              updateBadge(task);
            })
            .catch((err) => {
              failures++;
              consecutiveFailures++;
              console.warn('[视频下载] 分片失败:', item.url, err.message);
            })
            .finally(() => {
              active--;
              schedulePersist();
              if (active === 0) resolve();
              else launchNext();
            });
        }
        if (active === 0) resolve();
      };
      launchNext();
    });
    return failures;
  })();
}

// 下载单个分片：重试 + AES-128 解密 + 写入缓存
async function downloadSegment(item, cache, keyCache) {
  let buffer = null;
  for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
    try {
      buffer = await fetchBuffer(item.url);
      break;
    } catch (err) {
      if (attempt === SEGMENT_RETRIES) throw err;
      await sleep(300 * (attempt + 1));
    }
  }
  if (item.key && item.key.method === 'AES-128' && item.key.uri) {
    buffer = await decryptSegment(buffer, item.key, item.seq, keyCache);
  }
  await cache.put(item.cacheKey, new Response(buffer));
}

// AES-128-CBC（HLS 标准）解密分片
async function decryptSegment(buffer, keyInfo, seq, keyCache) {
  let cryptoKey = keyCache.get(keyInfo.uri);
  if (!cryptoKey) {
    const keyBuffer = await fetchBuffer(keyInfo.uri);
    cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-CBC' }, false, ['decrypt']);
    keyCache.set(keyInfo.uri, cryptoKey);
  }
  const iv = ivToBytes(keyInfo.iv, seq);
  return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, buffer);
}

// ============ 直链 / blob 任务 ============

// 直链视频：直接交给浏览器下载（原生支持断点与多线程）
async function runDirectTask(task) {
  const downloadId = await chrome.downloads.download({
    url: task.url,
    filename: `${task.dir}/${task.name}.${task.ext}`,
    conflictAction: 'uniquify',
    saveAs: false
  });
  task.downloadIds.push(downloadId);
  task.status = 'completed'; // 已提交浏览器下载，后续状态由 onChanged 跟踪
  task.completedAt = Date.now();
  // DASH 独立流（B 站等）：视频/音频分离，附 ffmpeg 合并说明
  if (task.ext === 'm4s') {
    await saveDashMergeGuide(task);
  }
  updateBadge(task);
  schedulePersist();
}

// 生成 DASH 音视频合并说明（小文本文件，用 data URL 直接提交下载）
async function saveDashMergeGuide(task) {
  const guide = [
    'DASH 音视频合并说明',
    '',
    '本目录下的 .m4s 文件为 DASH 独立流（视频流与音频流分离存储）。',
    '请将同一场内容的视频流与音频流合并为一个完整视频：',
    '',
    '  ffmpeg -i "视频流.m4s" -i "音频流.m4s" -c copy "输出文件名.mp4"',
    '',
    '说明：',
    '1. 需先安装 ffmpeg（视频流与音频流两个文件都要下载后才能合并）。',
    '2. -c copy 表示直接流复制，不重新编码，速度快且无损。',
    '3. 文件名请根据实际下载的文件名调整（同名时浏览器会自动加 (1) 后缀）。',
    '4. 若只下载了单条流（纯音频或纯视频），可忽略本说明。'
  ].join('\r\n');
  // 中文文本 → UTF-8 base64（data URL 方式无需 offscreen 参与）
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(guide)));
  await chrome.downloads.download({
    url: `data:text/plain;charset=utf-8;base64,${base64}`,
    filename: `${task.dir}/音视频合并说明.txt`,
    conflictAction: 'overwrite',
    saveAs: false
  }).catch(() => {}); // 说明文件失败不影响主文件
}

// blob 视频：通知持有该 blob 的页面 frame 分块抓取并回传
async function runBlobTask(task) {
  task.status = 'downloading';
  schedulePersist();
  const options = { frameId: task.frameId };
  const ack = await chrome.tabs
    .sendMessage(task.tabId, { type: 'FETCH_BLOB', taskId: task.id, url: task.url }, options)
    .catch(() => null);
  if (!ack) {
    throw new Error('页面已不可用（可能已跳转），请刷新页面后重试');
  }
}

// content script 回传的 blob 元信息（大小/类型/总分块数）
export async function onBlobMeta(msg) {
  const tasks = await getTasks();
  const task = tasks.find((t) => t.id === msg.taskId);
  if (!task) return;
  task.totalChunks = msg.total;
  task.bytes = msg.size;
  task.ext = extFromMime(msg.mime) || task.ext;
  task.mime = msg.mime;
  schedulePersist();
}

// content script 回传的 blob 数据块
export async function onBlobChunk(msg) {
  const tasks = await getTasks();
  const task = tasks.find((t) => t.id === msg.taskId);
  if (!task || task.status !== 'downloading') return;
  const cache = await caches.open(cacheName(task.id));
  await cache.put(`chunk-${msg.index}`, new Response(msg.buffer));
  task.receivedChunks++;
  updateBadge(task);
  if (task.totalChunks && task.receivedChunks >= task.totalChunks) {
    await finishBlobTask(task);
  } else {
    schedulePersist();
  }
}

export async function onBlobError(msg) {
  const tasks = await getTasks();
  const task = tasks.find((t) => t.id === msg.taskId);
  if (!task) return;
  task.status = 'failed';
  task.error = msg.error || '读取视频数据失败';
  await caches.delete(cacheName(task.id));
  updateBadge(task);
  schedulePersist();
}

// content script 传输完成确认：数据块若已收齐但未触发合并（容错），在此补偿触发
export async function onBlobDone(msg) {
  const tasks = await getTasks();
  const task = tasks.find((t) => t.id === msg.taskId);
  if (!task || task.status !== 'downloading' || !task.totalChunks) return;
  if (task.receivedChunks >= task.totalChunks) {
    await finishBlobTask(task);
  }
}

// blob 数据块收齐：经 offscreen 页面合并缓存中的数据块并保存为单文件
async function finishBlobTask(task) {
  task.status = 'merging';
  await persistTasksNow();
  const result = await saveViaOffscreen({
    taskId: task.id,
    dir: task.dir,
    name: task.name,
    ext: task.ext,
    mime: task.mime || 'video/mp4',
    prefix: 'chunk-',
    total: task.totalChunks,
    merge: true,
    keepSegments: false,
    cleanup: true
  });
  if (result.bytes) task.bytes = result.bytes;
  task.status = 'completed';
  task.completedAt = Date.now();
  updateBadge(task);
  schedulePersist();
}

// ============ 任务控制 / 恢复 / 状态 ============

export async function cancelTask(taskId) {
  const tasks = await getTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.status = 'canceled';
  await removeRefererRule(task);
  await caches.delete(cacheName(taskId));
  updateBadge(task);
  await persistTasksNow();
}

export async function retryTask(taskId) {
  const tasks = await getTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task || runningTaskIds.has(task.id)) return;
  // merging 状态可能因服务意外终止而卡死，同样允许重试
  if (!['failed', 'canceled', 'merging'].includes(task.status)) return;
  const settings = await getSettings();
  task.status = 'pending';
  task.error = '';
  task.downloadedSegments = 0;
  task.receivedChunks = 0;
  await persistTasksNow();
  runTask(task, settings);
}

// SW 启动/定时唤醒时恢复未完成的任务：
// - m3u8：已缓存分片自动跳过（下载中→续传；合并中被中断→重新合并）
// - pending：SW 在清单拉取阶段被回收时遗留的状态，一并恢复
export async function resumePendingTasks() {
  const tasks = await getTasks();
  const active = ['pending', 'downloading', 'merging'];
  if (!tasks.some((t) => active.includes(t.status))) return;
  const settings = await getSettings();
  for (const task of tasks) {
    if (runningTaskIds.has(task.id)) continue;
    // 刚创建的任务可能正要被 createTask 启动，避免与 alarm 恢复逻辑竞态
    if (Date.now() - task.createdAt < 5000) continue;
    if (task.kind === 'm3u8' && active.includes(task.status)) {
      runTask(task, settings);
    } else if (task.kind === 'direct' && task.status === 'pending') {
      runTask(task, settings);
    } else if (task.kind === 'blob' && ['pending', 'downloading'].includes(task.status)) {
      // blob 的数据源在页面内存中，SW 重启后分块传输已断开，只能标记失败
      task.status = 'failed';
      task.error = '服务重启导致传输中断，请刷新页面后重试';
      schedulePersist();
    }
  }
}

// 浏览器下载状态变化：跟踪 downloadState；direct 任务下载结束后移除其 Referer 规则
export async function onDownloadChanged(delta) {
  if (!delta.state) return;
  const tasks = await getTasks();
  const task = tasks.find((t) => t.downloadIds.includes(delta.id));
  if (!task) return;
  task.downloadState = delta.state.current;
  if (['complete', 'interrupted'].includes(delta.state.current) && task.kind === 'direct') {
    await removeRefererRule(task);
  }
  schedulePersist();
}

// 删除单个任务记录（连同缓存与 DNR 规则一起清理；进行中的任务先终止）
export async function removeTask(taskId) {
  const tasks = await getTasks();
  const index = tasks.findIndex((t) => t.id === taskId);
  if (index < 0) return;
  const task = tasks[index];
  task.status = 'canceled'; // 标记取消以终止运行中的流程（runTask 会检查）
  await removeRefererRule(task);
  await caches.delete(cacheName(taskId));
  tasks.splice(index, 1);
  await persistTasksNow();
  refreshBadgeAfterRemoval(task);
}

// 清空全部终态任务（completed/failed/canceled），进行中的任务保留
export async function clearFinishedTasks() {
  const tasks = await getTasks();
  const remaining = [];
  let removedTabId = 0;
  for (const task of tasks) {
    if (['completed', 'failed', 'canceled'].includes(task.status)) {
      await removeRefererRule(task);
      await caches.delete(cacheName(task.id));
      removedTabId = task.tabId || removedTabId;
    } else {
      remaining.push(task);
    }
  }
  tasks.length = 0;
  tasks.push(...remaining);
  await persistTasksNow();
  if (removedTabId > 0) refreshBadgeAfterRemoval({ tabId: removedTabId });
  return { removed: tasks.length !== remaining.length ? undefined : undefined };
}

// 任务被删除后刷新对应标签页的徽章（避免残留旧进度）
function refreshBadgeAfterRemoval(task) {
  if (!task.tabId || task.tabId <= 0) return;
  chrome.action.setBadgeText({ text: '', tabId: task.tabId }).catch(() => {});
}

// 供 alarm 定期调用：回收已完成任务的孤儿 DNR 规则
export async function cleanupFinishedRules() {
  await cleanupOrphanRules(await getTasks());
}

// ============ 徽章与辅助 ============

function updateBadge(task) {
  let text = '';
  if (task.status === 'downloading') {
    const progress = badgeProgress(task);
    if (progress !== null) text = progress;
  } else if (task.status === 'completed') {
    text = '✓';
  } else if (task.status === 'failed') {
    text = '!';
  }
  if (!text) return;
  // 两个 API 的参数结构不同（setBadgeText 只认 text，setBadgeBackgroundColor 只认 color），必须分开构造
  const textOptions = { text };
  const colorOptions = { color: task.status === 'completed' ? '#16a34a' : '#2563eb' };
  if (task.tabId > 0) {
    textOptions.tabId = task.tabId;
    colorOptions.tabId = task.tabId;
  }
  chrome.action.setBadgeText(textOptions).catch(() => {});
  chrome.action.setBadgeBackgroundColor(colorOptions).catch(() => {});
}

function badgeProgress(task) {
  if (task.kind === 'm3u8' && task.totalSegments > 0) {
    return Math.floor((task.downloadedSegments / task.totalSegments) * 100) + '%';
  }
  if (task.kind === 'blob' && task.totalChunks > 0) {
    return Math.floor((task.receivedChunks / task.totalChunks) * 100) + '%';
  }
  return null;
}

// 带超时的 fetch：部分防盗链 CDN 会直接挂起连接（不响应也不拒绝），
// 没有超时会导致任务永久卡住；超时同样覆盖响应体读取阶段
async function fetchWithTimeout(url, timeoutMs, readBody) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await readBody(response);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  return await fetchWithTimeout(url, PLAYLIST_TIMEOUT_MS, (response) => response.text());
}

async function fetchBuffer(url) {
  return await fetchWithTimeout(url, SEGMENT_TIMEOUT_MS, (response) => response.arrayBuffer());
}

// 从 URL 推断扩展名（直链视频用）
function inferExtFromUrl(url, kind) {
  if (kind === 'm3u8') return 'ts';
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1].toLowerCase();
  } catch { /* 忽略非法 URL */ }
  return 'mp4';
}

function extFromMime(mime) {
  const map = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/quicktime': 'mov',
    'video/x-flv': 'flv',
    'video/mp2t': 'ts',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a'
  };
  return map[(mime || '').split(';')[0]] || '';
}
