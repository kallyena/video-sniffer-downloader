// 通用工具函数（Service Worker 与 Popup 共用）

// Windows 保留设备名，不能直接作为文件名
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// 净化文件/目录名：去除 Windows 非法字符与控制符，限制长度
export function sanitizeFilename(name, fallback = 'video') {
  let cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, ' ')   // 文件系统非法字符
    .replace(/[\x00-\x1f]/g, '')     // 控制字符
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')             // 不允许以点开头（隐藏文件）
    .slice(0, 80)
    .trim();
  if (WINDOWS_RESERVED.test(cleaned)) cleaned = '_' + cleaned;
  return cleaned || fallback;
}

// 从 URL 提取文件名（去 query 后的最后一段）
export function filenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last);
  } catch {
    return '';
  }
}

// 字节数格式化为可读文本
export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return value.toFixed(value >= 100 || unitIndex === 0 ? 0 : 1) + ' ' + units[unitIndex];
}

// 生成不重复的任务 ID
export function generateTaskId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
