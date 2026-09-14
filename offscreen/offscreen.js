// Offscreen Document：负责"从 Cache Storage 读取分片 → 合并 → 提交浏览器下载"
// 为什么需要它：MV3 的 Service Worker 中不存在 URL.createObjectURL()，
// 无法直接把合并后的视频数据交给 chrome.downloads 下载；
// 而 offscreen 页面拥有完整 DOM 环境，且能读取 SW 写入的同源缓存。
// 注意：扩展消息只能传 JSON（不能传 Blob），所以数据通过 Cache Storage 传递，
// 本页面按 key 自行取回。

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'OFFSCREEN_SAVE') return false;
  handleSaveJob(msg.job)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: err.message || String(err) }));
  return true; // 异步响应
});

// job 结构：
//   taskId / dir / name / ext / mime
//   prefix: 'seg-' | 'chunk-'   分片在缓存中的 key 前缀
//   total: 分片总数；merge: 合并为单文件；keepSegments: 保留分片；cleanup: 完成后清缓存
async function handleSaveJob(job) {
  const cacheName = `vd-task-${job.taskId}`;
  const cache = await caches.open(cacheName);
  let bytes = 0;

  if (job.merge) {
    bytes = await saveMergedFile(cache, job);
  }
  if (job.keepSegments && job.prefix === 'seg-') {
    await saveSegmentFiles(cache, job);
  }
  if (job.cleanup) {
    await caches.delete(cacheName);
  }
  return { ok: true, bytes };
}

// 读取全部分片合并为单文件并提交下载（TS 直拼 / fMP4 先放初始化段，均为可播放格式）
async function saveMergedFile(cache, job) {
  const parts = [];
  const mapResponse = await cache.match('map');
  if (mapResponse) parts.push(await mapResponse.arrayBuffer()); // fMP4 初始化段放最前
  for (let i = 0; i < job.total; i++) {
    const response = await cache.match(`${job.prefix}${i}`);
    if (response) parts.push(await response.arrayBuffer());
  }
  if (!parts.length) throw new Error('没有可合并的数据');
  const blob = new Blob(parts, { type: job.mime });
  await downloadBlob(blob, `${job.dir}/${job.name}.${job.ext}`);
  return blob.size;
}

// 保留分片模式：每个分片单独保存到 segments/ 子目录，并生成 ffmpeg 合并所需文件
async function saveSegmentFiles(cache, job) {
  const segExt = job.ext === 'mp4' ? 'm4s' : 'ts';
  const listLines = [];
  const mapResponse = await cache.match('map');
  if (mapResponse) {
    await downloadBlob(new Blob([await mapResponse.arrayBuffer()]), 'segments/init.mp4');
    listLines.push("file 'segments/init.mp4'");
  }
  for (let i = 0; i < job.total; i++) {
    const response = await cache.match(`seg-${i}`);
    if (!response) continue;
    const fileName = `seg_${String(i).padStart(5, '0')}.${segExt}`;
    await downloadBlob(new Blob([await response.arrayBuffer()]), `segments/${fileName}`);
    listLines.push(`file 'segments/${fileName}'`);
  }
  await downloadBlob(
    new Blob([listLines.join('\n') + '\n'], { type: 'text/plain' }),
    'segments/filelist.txt'
  );
  await downloadBlob(
    new Blob([buildMergeGuide(job)], { type: 'text/plain;charset=utf-8' }),
    '合并说明.txt'
  );
}

function buildMergeGuide(job) {
  const output = `${job.name}.${job.ext}`;
  return [
    `视频分片合并说明（${job.name}）`,
    '',
    '方式一：本插件已支持"自动合并"，可在设置中开启后重新下载。',
    '',
    '方式二：使用 ffmpeg 手动合并（推荐先安装 ffmpeg）：',
    `  cd "${job.dir}"`,
    `  ffmpeg -f concat -safe 0 -i segments/filelist.txt -c copy "${output}"`,
    '',
    '说明：',
    '1. -c copy 表示直接流复制，不重新编码，速度快且无损。',
    `2. 合并后的文件为 ${output}，可被主流播放器直接播放。`,
    '3. 合并完成后可删除 segments 目录。'
  ].join('\r\n');
}

// 提交浏览器下载，并延迟回收 blob URL（等待浏览器完成读取）
async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });
    if (downloadId === undefined) throw new Error('浏览器拒绝了这个下载请求');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
}
