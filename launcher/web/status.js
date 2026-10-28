// i18n-ignore-file: standalone deployment status is bilingual by design.
const phases = {
  running: '运行中 / Running', starting: '启动中 / Starting',
  'waiting-for-match': '有新版，等待对局结束 / Update waiting for matches to finish',
  preparing: '正在准备新版 / Preparing update',
};
function link(label, url) {
  const anchor = document.createElement('a');
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== 'github.com') throw new Error('Invalid link');
  anchor.href = target.href;
  anchor.textContent = label;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}
async function refresh() {
  try {
    const response = await fetch('/subscriptions/status.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    const server = document.getElementById('server');
    server.replaceChildren();
    for (const [label, value] of [
      ['当前版本 / Current', status.current], ['最新版本 / Latest', status.latest || '—'],
      ['状态 / Status', phases[status.phase] || status.phase],
      ['检查时间 / Checked', status.checkedAt ? new Date(status.checkedAt).toLocaleString() : '—'],
    ]) {
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = value;
      server.append(dt, dd);
    }
    document.getElementById('error').textContent = status.error || '';
    const feeds = document.getElementById('feeds');
    feeds.replaceChildren();
    for (const item of status.subscriptions) {
      const row = document.createElement('p');
      row.append(link(item.repository, item.url), document.createTextNode(` · ${item.version || item.error || '—'}`));
      if (item.feed) row.append(document.createTextNode(' · '), link('RSS / Atom', item.feed));
      feeds.append(row);
    }
  } catch (error) { document.getElementById('error').textContent = `暂时无法连接服务器 / Server unavailable: ${error.message}`; }
}
refresh();
setInterval(refresh, 15_000);
