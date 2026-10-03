export const ACCOUNT_ID = '1000000000000000';
export const REFRESH_INTERVAL_MS = 300_000;

// The original endpoints and response mapping must be observed before implementation.
// No request path or credential is guessed; screenshot values are never live responses.
export class IntegrationPendingError extends Error {
  constructor() { super('真实接口待接入'); this.name = 'IntegrationPendingError'; }
}
export async function loadAccountData({signal,...query}) {
 const response=await fetch('/api/dashboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(query),signal});
 const result=await response.json();
 if(!response.ok){const error=new Error(result.error?.message||'请求失败');error.code=result.error?.code;throw error;}
 return result;
}

export function createPoller({ load = loadAccountData, query, onData, onError,onLoading=()=>{},
  interval = REFRESH_INTERVAL_MS, timer = globalThis, now = Date.now }) {
  let running = false, stopped = true, timeout, active, requestedRevision = 0;
  function schedule() {
    if (!stopped) timeout = timer.setTimeout(() => { void refresh(); }, interval);
  }
  async function refresh() {
    if (running || stopped) return;
    running = true;
    onLoading(true);
    timer.clearTimeout(timeout);
    active = new AbortController();
    const revision = requestedRevision;
    const requestTimeout = timer.setTimeout(() => active?.abort(), 90_000);
    try {
      const data = await load({ ...query(), accountId: ACCOUNT_ID, signal: active.signal });
      if (String(data?.accountId) !== ACCOUNT_ID || !['live','recorded'].includes(data?.source)) {
        throw new Error('数据账户或来源不匹配，已拒绝更新');
      }
      if (!stopped && revision === requestedRevision) onData(data, now());
    } catch (error) {
      if (!stopped && revision === requestedRevision) onError(error);
    } finally {
      timer.clearTimeout(requestTimeout);
      running = false;
      onLoading(false);
      active = undefined;
      if (!stopped && revision !== requestedRevision) void refresh();
      else schedule();
    }
  }
  return {
    start() { if (!stopped) return; stopped = false; void refresh(); },
    refresh,
    invalidate() { requestedRevision++; active?.abort(); void refresh(); },
    stop() { stopped = true; requestedRevision++; timer.clearTimeout(timeout); active?.abort(); },
  };
}
