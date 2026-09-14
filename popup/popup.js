// Popup 交互逻辑：
// - 展示当前页嗅探到的视频列表（可编辑文件名后下载）
// - 展示下载任务进度（轮询刷新）
// - 提供合并/保留分片的快捷设置
import { formatBytes, filenameFromUrl } from '../background/utils.js';
import { LINKS } from '../links.js';

let currentTabId = 0;
let currentPageUrl = '';
let settings = null;
let pollTimer = null;

// ---------- 初始化 ----------

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  currentTabId = tab.id;

  document.getElementById('btn-rescan').addEventListener('click', rescan);
  document.getElementById('btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('btn-clear-tasks').addEventListener('click', clearTasks);
  document.getElementById('link-donate').addEventListener('click', () => chrome.tabs.create({ url: LINKS.donate }));
  document.getElementById('link-feedback').addEventListener('click', openFeedback);
  bindQuickSettings();

  await refreshState();
  pollTimer = setInterval(pollTasks, 1000); // popup 打开期间每秒刷新任务进度
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

// ---------- 状态加载与渲染 ----------

async function refreshState() {
  const state = await send({ type: 'GET_STATE', tabId: currentTabId }).catch(() => null);
  if (!state) return;
  settings = state.settings;
  renderPageInfo(state);
  renderVideoList(state);
  renderTaskList(state.tasks);
  renderQuickSettings();
}

// 轮询只刷新任务区，避免重渲染视频列表打断文件名输入
async function pollTasks() {
  const state = await send({ type: 'GET_STATE', tabId: currentTabId }).catch(() => null);
  if (state) renderTaskList(state.tasks);
}

function renderPageInfo(state) {
  const el = document.getElementById('page-title');
  currentPageUrl = state.pageUrl || '';
  const isNormalPage = /^https?:/.test(currentPageUrl);
  el.textContent = isNormalPage ? `当前页面：${state.pageTitle || currentPageUrl}` : '请在普通网页中使用（当前页面不受支持）';
  el.title = currentPageUrl;
}

// ---------- 视频列表 ----------

function renderVideoList(state) {
  const list = document.getElementById('video-list');
  const empty = document.getElementById('video-empty');
  list.textContent = '';
  // 可下载性排序：m3u8 > 直链/DASH 流 > blob（MSE 的 blob 通常无法直接抓取，排最后）
  const priority = { m3u8: 0, direct: 1, blob: 2 };
  const videos = (state.videos || []).slice().sort(
    (a, b) => priority[a.kind] - priority[b.kind] || b.detectedAt - a.detectedAt
  );
  empty.style.display = videos.length ? 'none' : 'block';
  document.getElementById('video-count').textContent = videos.length ? `${videos.length}` : '';

  videos.forEach((video) => list.appendChild(buildVideoItem(video, state)));
}

function buildVideoItem(video, state) {
  const item = document.createElement('div');
  item.className = 'video-item';

  // 第一行：类型徽章 + 地址
  const rowTop = document.createElement('div');
  rowTop.className = 'row-top';
  rowTop.appendChild(buildBadge(video));
  const urlEl = document.createElement('div');
  urlEl.className = 'video-url';
  urlEl.textContent = video.url;
  urlEl.title = video.url;
  rowTop.appendChild(urlEl);
  item.appendChild(rowTop);

  // 元信息行：时长 / 分辨率
  const meta = describeVideo(video);
  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'video-meta';
    metaEl.textContent = meta;
    item.appendChild(metaEl);
  }

  // 第二行：文件名输入 + 复制 + 下载
  const rowBottom = document.createElement('div');
  rowBottom.className = 'row-bottom';

  const nameInput = document.createElement('input');
  nameInput.className = 'name-input';
  nameInput.type = 'text';
  nameInput.value = defaultFileName(video, state);
  nameInput.title = '下载目录名与文件名（保存在：下载目录/根目录/该名称/ 下）';
  rowBottom.appendChild(nameInput);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn link';
  copyBtn.textContent = '复制';
  copyBtn.addEventListener('click', () => copyUrl(video.url));
  rowBottom.appendChild(copyBtn);

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'btn download';
  downloadBtn.textContent = '下载';
  downloadBtn.addEventListener('click', () => startDownload(video, nameInput.value));
  rowBottom.appendChild(downloadBtn);

  item.appendChild(rowBottom);
  return item;
}

function buildBadge(video) {
  const badge = document.createElement('span');
  let kind = video.isAudio ? 'audio' : video.kind;
  if (video.kind === 'direct' && video.streamType) kind = video.streamType;
  badge.className = `badge ${kind}`;
  // 爱奇艺条目：徽章直接显示清晰度（如 720P）
  if (video.quality) {
    badge.textContent = video.quality;
    return badge;
  }
  const labels = {
    m3u8: 'M3U8',
    direct: video.isAudio ? '音频' : '直链视频',
    blob: 'BLOB',
    audio: '音频',
    video: 'DASH 视频流',
    dash: 'DASH 流'
  };
  badge.textContent = labels[kind] || '视频';
  return badge;
}

// 视频元信息描述：时长 + 分辨率 + 来源
function describeVideo(video) {
  const parts = [];
  if (video.duration > 0) parts.push(`时长 ${formatDuration(video.duration)}`);
  if (video.width && video.height) parts.push(`${video.width}x${video.height}`);
  if (video.kind === 'm3u8') parts.push('HLS 切片流，下载后自动合并');
  if (video.kind === 'blob') {
    // MSE 的 blob 无法直接抓取：提示用户优先选择列表中的可下载条目
    parts.push('MSE 动态流，多数情况无法直接下载，建议选择列表上方的 DASH/m3u8 条目');
  }
  if (video.quality) parts.push('完整视频文件（TS 格式），下载后可直接播放');
  if (video.streamType) {
    // DASH 独立流提示：视频/音频需分别下载后用 ffmpeg 合并（见下载目录中的说明文件）
    parts.push(video.streamType === 'audio'
      ? 'DASH 音频流，需与视频流分别下载后合并'
      : 'DASH 视频流，需与音频流分别下载后合并');
  }
  return parts.join(' · ');
}

// 默认文件名：依据设置的来源（页面标题 / URL 文件名）；
// B 站等 DASH 流自动加"视频流/音频流"后缀，避免两条流同名混淆
function defaultFileName(video, state) {
  let name;
  if (settings?.nameSource === 'url') {
    name = filenameFromUrl(video.url) || state.pageTitle || 'video';
  } else {
    name = state.pageTitle || filenameFromUrl(video.url) || 'video';
  }
  if (video.streamType) {
    const suffix = video.streamType === 'audio' ? '-音频流' : '-视频流';
    name = name.slice(0, 60) + suffix; // 截短标题保证后缀不被目录名长度限制截掉
  }
  return name;
}

async function startDownload(video, fileName) {
  const trimmed = (fileName || '').trim();
  if (!trimmed) {
    showToast('请先填写文件名');
    return;
  }
  const result = await send({
    type: 'START_DOWNLOAD',
    video,
    fileName: trimmed
  }).catch(() => null);
  if (result?.error) {
    showToast(result.error);
  } else if (!result) {
    showToast('后台服务暂不可用，请重试');
  } else {
    showToast('已开始下载');
  }
  await pollTasks();
}

async function copyUrl(url) {
  try {
    await navigator.clipboard.writeText(url);
    showToast('地址已复制');
  } catch {
    showToast('复制失败');
  }
}

// 清空所有终态任务记录（进行中的任务保留；不影响磁盘上已下载的文件）
async function clearTasks() {
  await send({ type: 'CLEAR_TASKS' }).catch(() => null);
  showToast('已清除结束的任务记录');
  await pollTasks();
}

// ---------- 反馈与求适配 ----------
// 一键生成诊断报告（版本/浏览器/页面/最近失败任务），
// 复制到剪贴板并打开预填邮件——用户只需补充"想支持的网站"后发送
async function openFeedback() {
  const manifest = chrome.runtime.getManifest();
  let failedLine = '无';
  try {
    const state = await send({ type: 'GET_STATE', tabId: currentTabId });
    const failed = (state?.tasks || []).find((t) => t.status === 'failed');
    if (failed) failedLine = `${failed.name} — ${failed.error || '未知错误'}`;
  } catch { /* 状态获取失败不阻塞反馈 */ }
  const report = [
    `【插件版本】${manifest.version}`,
    `【浏览器】${navigator.userAgent}`,
    `【当前页面】${currentPageUrl || '（未记录）'}`,
    `【最近失败任务】${failedLine}`,
    '',
    '【想支持的网站】',
    '【问题描述】'
  ].join('\n');

  // 剪贴板兜底：邮件客户端未弹出时用户可手动粘贴
  await navigator.clipboard.writeText(report).catch(() => {});
  showToast('诊断信息已复制，粘贴补充后发送');

  const subject = encodeURIComponent('视频嗅探下载器 - 站点支持反馈');
  const body = encodeURIComponent(report);
  chrome.tabs.create({ url: `mailto:${LINKS.feedbackEmail}?subject=${subject}&body=${body}` });
}

async function rescan() {
  await chrome.tabs.sendMessage(currentTabId, { type: 'RESCAN' }).catch(() => {});
  // 等待 content script 上报完成后再拉取状态
  setTimeout(refreshState, 600);
}

// ---------- 任务列表 ----------

function renderTaskList(tasks) {
  const list = document.getElementById('task-list');
  const empty = document.getElementById('task-empty');
  list.textContent = '';
  empty.style.display = tasks.length ? 'none' : 'block';

  tasks.slice(0, 20).forEach((task) => list.appendChild(buildTaskItem(task)));
}

function buildTaskItem(task) {
  const item = document.createElement('div');
  item.className = 'task-item';

  // 第一行：任务名 + 状态徽章
  const rowTop = document.createElement('div');
  rowTop.className = 'row-top';
  const nameEl = document.createElement('div');
  nameEl.className = 'task-name';
  nameEl.textContent = `${task.name}.${task.ext}`;
  nameEl.title = `${task.name}（${task.dir}/）`;
  rowTop.appendChild(nameEl);
  rowTop.appendChild(buildStatusBadge(task));
  item.appendChild(rowTop);

  // 进度条（下载/合并中显示）
  const progress = taskProgress(task);
  if (progress !== null) {
    const track = document.createElement('div');
    track.className = 'progress-track';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = `${Math.round(progress * 100)}%`;
    track.appendChild(fill);
    item.appendChild(track);
  }

  // 第二行：详情 + 操作按钮
  const rowBottom = document.createElement('div');
  rowBottom.className = 'row-bottom';

  const detail = document.createElement('div');
  detail.className = 'task-detail';
  detail.appendChild(document.createTextNode(describeTask(task)));
  rowBottom.appendChild(detail);

  if (['pending', 'downloading', 'merging'].includes(task.status)) {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn mini cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', () => send({ type: 'CANCEL_TASK', taskId: task.id }).then(pollTasks));
    rowBottom.appendChild(cancelBtn);
  }
  if (['failed', 'canceled'].includes(task.status)) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn mini retry';
    retryBtn.textContent = '重试';
    retryBtn.addEventListener('click', () => send({ type: 'RETRY_TASK', taskId: task.id }).then(pollTasks));
    rowBottom.appendChild(retryBtn);
  }

  // 删除按钮：移除该任务记录（不删除已下载到磁盘的文件）
  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn mini remove';
  removeBtn.textContent = '删除';
  removeBtn.title = '从列表中移除该任务（不影响已保存的文件）';
  removeBtn.addEventListener('click', () => send({ type: 'REMOVE_TASK', taskId: task.id }).then(pollTasks));
  rowBottom.appendChild(removeBtn);

  item.appendChild(rowBottom);

  // 失败原因独立成行（完整换行展示，不会被省略号截断）
  if (task.status === 'failed') {
    const errLine = document.createElement('div');
    errLine.className = 'task-error-line';
    errLine.textContent = task.error || '未知错误：请打开 Service Worker 控制台查看 [视频下载] 日志';
    item.appendChild(errLine);
  }
  return item;
}

function buildStatusBadge(task) {
  const badge = document.createElement('span');
  badge.className = `status ${task.status}`;
  const labels = {
    pending: '排队中',
    downloading: '下载中',
    merging: '合并中',
    completed: '已完成',
    failed: '失败',
    canceled: '已取消'
  };
  badge.textContent = labels[task.status] || task.status;
  return badge;
}

// 任务进度（0~1）；非进度型任务返回 null
function taskProgress(task) {
  if (task.status === 'merging') return 0.95;
  if (task.status !== 'downloading') return null;
  if (task.kind === 'm3u8' && task.totalSegments > 0) {
    return task.downloadedSegments / task.totalSegments;
  }
  if (task.kind === 'blob' && task.totalChunks > 0) {
    return task.receivedChunks / task.totalChunks;
  }
  return null;
}

// 任务详情文案：进度 / 大小 / 浏览器下载状态
function describeTask(task) {
  const parts = [];
  // 清单获取阶段（尚未解析出分片数）单独提示，避免显示 0% 造成卡住错觉
  if (task.kind === 'm3u8' && task.status === 'downloading' && !task.totalSegments) {
    parts.push('正在获取视频清单...');
  }
  if (task.kind === 'm3u8' && task.totalSegments) {
    parts.push(`分片 ${task.downloadedSegments}/${task.totalSegments}`);
  }
  if (task.kind === 'blob' && task.totalChunks) {
    parts.push(`数据块 ${task.receivedChunks}/${task.totalChunks}`);
  }
  if (task.bytes) parts.push(formatBytes(task.bytes));
  if (task.isLive) parts.push('直播流（仅录制已生成片段）');
  if (task.status === 'completed') {
    parts.push(task.downloadState === 'complete' ? '浏览器下载完成' : '已提交浏览器下载');
  }
  return parts.join(' · ') || task.dir;
}

// ---------- 快捷设置 ----------

function bindQuickSettings() {
  document.getElementById('qs-auto-merge').addEventListener('change', onQuickSettingChange);
  document.getElementById('qs-keep-segments').addEventListener('change', onQuickSettingChange);
}

function renderQuickSettings() {
  if (!settings) return;
  document.getElementById('qs-auto-merge').checked = !!settings.autoMerge;
  document.getElementById('qs-keep-segments').checked = !!settings.keepSegments;
  document.getElementById('save-path').textContent =
    `保存位置：浏览器默认下载目录 / ${settings.rootDir} / 视频名 /`;
  document.getElementById('save-path').title =
    '每个视频一个独立子目录；如需修改根目录请打开"设置"';
}

async function onQuickSettingChange(event) {
  const patch = {};
  if (event.target.id === 'qs-auto-merge') patch.autoMerge = event.target.checked;
  if (event.target.id === 'qs-keep-segments') patch.keepSegments = event.target.checked;
  const merged = await send({ type: 'SAVE_SETTINGS', patch }).catch(() => null);
  if (merged) {
    settings = merged;
    showToast('设置已保存');
  }
}

// ---------- 辅助 ----------

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 1800);
}
