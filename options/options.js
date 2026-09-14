// 设置页逻辑：通过后台读写设置（默认值由后台统一管理）
import { LINKS } from '../links.js';

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }).catch(() => null);
  if (!settings) {
    showStatus('无法读取设置，请重新打开本页', true);
    return;
  }
  fillForm(settings);
  bindEvents();
  bindAboutLinks();
}

// 关于区块：版本号展示与三个外部入口
function bindAboutLinks() {
  document.getElementById('about-version').textContent = chrome.runtime.getManifest().version;
  document.getElementById('about-donate').addEventListener('click', () => chrome.tabs.create({ url: LINKS.donate }));
  document.getElementById('about-github').addEventListener('click', () => chrome.tabs.create({ url: LINKS.github }));
  // 反馈走 GitHub Issues（已登录用户优先）；未登录时页面本身会引导登录
  document.getElementById('about-feedback').addEventListener('click', () => chrome.tabs.create({ url: LINKS.issues }));
}

function fillForm(settings) {
  document.getElementById('opt-root-dir').value = settings.rootDir;
  document.getElementById('opt-name-source').value = settings.nameSource;
  document.getElementById('opt-auto-merge').checked = settings.autoMerge;
  document.getElementById('opt-keep-segments').checked = settings.keepSegments;
  document.getElementById('opt-concurrency').value = settings.concurrency;
  document.getElementById('concurrency-value').textContent = settings.concurrency;
}

function bindEvents() {
  const concurrencyInput = document.getElementById('opt-concurrency');
  concurrencyInput.addEventListener('input', () => {
    document.getElementById('concurrency-value').textContent = concurrencyInput.value;
  });

  document.getElementById('btn-save').addEventListener('click', saveSettings);
}

async function saveSettings() {
  const patch = {
    rootDir: document.getElementById('opt-root-dir').value.trim() || 'VideoDownloader',
    nameSource: document.getElementById('opt-name-source').value,
    autoMerge: document.getElementById('opt-auto-merge').checked,
    keepSegments: document.getElementById('opt-keep-segments').checked,
    concurrency: parseInt(document.getElementById('opt-concurrency').value, 10) || 3
  };
  const merged = await chrome.runtime
    .sendMessage({ type: 'SAVE_SETTINGS', patch })
    .catch(() => null);
  if (merged) {
    fillForm(merged);
    showStatus('保存成功');
  } else {
    showStatus('保存失败，请重试', true);
  }
}

function showStatus(message, isError) {
  const el = document.getElementById('save-status');
  el.textContent = message;
  el.style.color = isError ? '#b91c1c' : '#15803d';
  setTimeout(() => { el.textContent = ''; }, 2000);
}
