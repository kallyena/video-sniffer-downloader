// DNR（declarativeNetRequest）会话规则管理：
// 为视频请求注入来源页面的 Referer。
// 原因：MV3 中 Service Worker 的 fetch 与 downloads API 发起的请求均不带页面 Referer，
// 会被 B 站等站点的 CDN 防盗链直接拒绝（403）；
// 而 Referer 属于 forbidden header，fetch 无法直接设置，只能通过 DNR 修改。

// 为任务注册 Referer 注入规则（在发起任何视频请求前调用）
export async function ensureRefererRule(task) {
  if (!task.pageUrl || !/^https?:/i.test(task.pageUrl)) return; // 无来源页面信息则跳过
  let urlFilter;
  try {
    const parsed = new URL(task.url);
    urlFilter = parsed.origin + parsed.pathname; // 不含 query：签名参数过长且无需匹配
  } catch {
    return;
  }

  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ruleId = rules.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id: ruleId,
      priority: 1,
      // 不限定 resourceTypes：需同时覆盖 SW fetch（xmlhttprequest）与浏览器下载请求
      condition: { urlFilter },
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'referer', operation: 'set', value: task.pageUrl }]
      }
    }]
  });
  task.dnrRuleId = ruleId;
}

// 移除任务的 Referer 规则（任务终态/取消时）
export async function removeRefererRule(task) {
  if (!task.dnrRuleId) return;
  task.dnrRuleId = 0;
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [task.dnrRuleId] })
    .catch(() => {});
}

// 回收孤儿规则：对应任务已删除、或已终态超过 10 分钟的会话规则。
// direct 任务的规则要等浏览器下载完成才移除，SW 重启可能错过时机，需定期清理
const DIRECT_RULE_TTL_MS = 10 * 60 * 1000;

export async function cleanupOrphanRules(tasks) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const now = Date.now();
  const orphanIds = rules
    .filter((rule) => {
      const task = tasks.find((t) => t.dnrRuleId === rule.id);
      if (!task) return true;
      if (['completed', 'failed', 'canceled'].includes(task.status)) {
        const endedAt = task.completedAt || task.updatedAt || 0;
        return now - endedAt > DIRECT_RULE_TTL_MS;
      }
      return false;
    })
    .map((rule) => rule.id);
  if (orphanIds.length) {
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: orphanIds })
      .catch(() => {});
  }
}
