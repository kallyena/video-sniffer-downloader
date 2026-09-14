// Content Script：
// 1. 扫描页面 video/audio 元素（含动态插入、src 变化）并上报后台
// 2. 响应后台指令：重新扫描（RESCAN）、抓取 blob 视频并分块回传（FETCH_BLOB）
(function () {
  'use strict';

  const CHUNK_SIZE = 4 * 1024 * 1024; // blob 分块大小：4MB
  const reportedSrcs = new Set();     // 已上报的媒体源，避免重复消息
  let scanTimer = null;

  // ---------- 扫描与上报 ----------

  // 收集页面上所有 video/audio 元素的播放源信息
  function collectVideoElements() {
    const results = [];
    document.querySelectorAll('video, audio').forEach((element) => {
      const src = element.currentSrc || element.src;
      if (!src || reportedSrcs.has(src)) return;
      if (!/^(https?|blob:)/i.test(src)) return; // 过滤 data: 等其它协议
      reportedSrcs.add(src);
      results.push({
        src,
        tag: element.tagName.toLowerCase(),
        duration: Number.isFinite(element.duration) ? element.duration : 0,
        width: element.videoWidth || 0,
        height: element.videoHeight || 0
      });
    });
    return results;
  }

  // 有新发现才上报，避免频繁唤醒后台
  function reportNewVideos() {
    const videos = collectVideoElements();
    if (!videos.length) return;
    chrome.runtime
      .sendMessage({ type: 'PAGE_INFO', url: location.href, videos })
      .catch(() => {}); // 后台未就绪时静默忽略
  }

  // MutationObserver 监听动态插入的媒体元素（SPA 页面常见）
  const observer = new MutationObserver(() => {
    scheduleScan();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 轮询兜底：currentSrc 由 MSE 动态设置时不会触发 DOM 变更
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      reportNewVideos();
    }, 500);
  }

  setInterval(reportNewVideos, 3000);
  reportNewVideos();

  // ---------- 后台指令处理 ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'RESCAN') {
      reportedSrcs.clear(); // 清空去重记录，全量重新上报
      reportNewVideos();
      sendResponse({ ok: true });
    } else if (msg.type === 'FETCH_BLOB') {
      sendResponse({ ok: true }); // 立即应答，数据走独立消息流回传
      streamBlobToBackground(msg.taskId, msg.url);
    }
    return false;
  });

  // ---------- blob 视频分块抓取 ----------

  // 抓取 blob URL 的完整数据，按块回传后台（MSE 动态流会 fetch 失败并回报错误）
  async function streamBlobToBackground(taskId, blobUrl) {
    try {
      const response = await fetch(blobUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const totalChunks = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE));

      // 先回传元信息（大小/类型/块数），后台据此初始化任务
      await safeSend({ type: 'BLOB_META', taskId, size: blob.size, mime: blob.type || '', total: totalChunks });

      // 逐块回传数据
      for (let index = 0; index < totalChunks; index++) {
        const start = index * CHUNK_SIZE;
        const buffer = await blob.slice(start, start + CHUNK_SIZE).arrayBuffer();
        await safeSend({ type: 'BLOB_CHUNK', taskId, index, total: totalChunks, buffer });
      }
      await safeSend({ type: 'BLOB_DONE', taskId });
    } catch {
      // blob 已失效或为 MSE 动态流（MediaSource 无法整体读取）
      await safeSend({
        type: 'BLOB_ERROR',
        taskId,
        error: '该 blob 是 MSE 动态流，无法直接抓取。请播放视频后，在嗅探列表中选择「DASH 视频流 / DASH 音频流 / M3U8」条目下载'
      });
    }
  }

  function safeSend(message) {
    return chrome.runtime.sendMessage(message).catch(() => {});
  }
})();
