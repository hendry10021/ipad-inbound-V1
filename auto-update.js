/* One-time LAN pairing; subsequent updates touch master/settings only. */
window.startInboundAutoSync = function () {
  const panel = document.querySelector('#adminPanel');
  const box = document.createElement('div');
  box.className = 'setting';
  box.innerHTML = '<h3>每月訂單自動更新</h3><p>配對一次後，電腦「更新」資料夾有新資料時會自動同步。</p><label>內網更新網址</label><input id="syncUrl" placeholder="https://電腦位址:8766"><label>配對碼</label><input id="syncToken" type="password" autocomplete="off"><button id="saveSync">儲存並連線</button><p id="syncMessage" role="status"></p>';
  panel.prepend(box);
  const banner = document.createElement('p');
  banner.style.cssText = 'margin:0;padding:10px 18px;background:#fff3cd;color:#583f00;display:none';
  banner.setAttribute('role', 'status');
  document.querySelector('header').after(banner);
  let running = false;
  const message = text => { document.querySelector('#syncMessage').textContent = text; banner.textContent = text; banner.style.display = 'block'; };
  const saved = state.settings.lanSync || {};
  document.querySelector('#syncUrl').value = saved.url || '';
  document.querySelector('#syncToken').value = saved.token || '';
  document.querySelector('#saveSync').onclick = async () => {
    try {
      const url = new URL(document.querySelector('#syncUrl').value.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('請輸入 https://電腦位址:8766');
      const token = document.querySelector('#syncToken').value.trim();
      if (!token) throw Error('請填寫配對碼');
      state.settings.lanSync = {url:url.origin, token};
      await idbPut('settings', {key:'lanSync',value:state.settings.lanSync});
      await sync();
    } catch (e) { message(e.message); }
  };
  async function sync() {
    const cfg = state.settings.lanSync;
    if (running || !cfg?.url || !cfg?.token || document.hidden) return;
    running = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const get = async path => {
        const response = await fetch(cfg.url + path, {headers:{Authorization:'Bearer '+cfg.token},cache:'no-store',signal:controller.signal,credentials:'omit',redirect:'error'});
        if (!response.ok) throw Error('更新服務回應 '+response.status);
        return response;
      };
      const status = await (await get('/status')).json();
      if (status.state !== 'ready') { message('新訂單尚未啟用：'+status.message+'。目前仍使用先前資料。'); return; }
      if (state.settings.masterImportMeta?.lanVersion === status.csv_sha256) { message('自動更新已連線｜'+status.source_name+'｜'+status.complete_rows+' 筆'); return; }
      // Do not swap the comparison data in the middle of a photographed transaction.
      if (state.labelPhotoBlob || state.pendingMasterFile) { message('新訂單已就緒，完成目前操作後自動更新。'); return; }
      const bytes = await (await get('/master.csv')).arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
      if (hash !== status.csv_sha256) throw Error('來源正在更新，稍後自動重試');
      const parsed = parseCSVWithHeaders(new TextDecoder().decode(bytes));
      if (!validateMasterHeaders(parsed.headers).ok || !parsed.rows.length) throw Error('CSV 欄位檢查失敗');
      const rows = parsed.rows.map(mapMasterRow);
      if (rows.length !== status.complete_rows || new Set(rows.map(r=>r.boxNo)).size !== rows.length || rows.some(r=>!r.boxNo||!r.partNo||!r.poNo||![r.orderQty,r.boxQty,r.nw,r.gw].every(Number.isFinite)||r.orderQty<=0||r.boxQty<=0||r.nw<0||r.gw<r.nw)) throw Error('訂單內容檢查失敗');
      if (state.labelPhotoBlob || state.pendingMasterFile) return;
      const meta = {filename:status.source_name,count:rows.length,importedAt:new Date().toISOString(),lanVersion:hash};
      const tx = state.db.transaction(['master','settings'],'readwrite');
      const complete = new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || Error('更新取消'));});
      tx.objectStore('master').clear();
      rows.forEach(r=>tx.objectStore('master').put(r));
      tx.objectStore('settings').put({key:'masterImportMeta',value:meta});
      await complete;
      state.master = rows; state.settings.masterImportMeta = meta; updateMasterStatus();
      message('自動更新完成｜'+status.source_name+'｜'+rows.length+' 筆');
    } catch (e) { message('未取得最新訂單，保留先前資料。請確認電腦開機、同一內網及配對連線。'+(e.name==='AbortError'?'連線逾時。':e.message)); }
    finally {clearTimeout(timeout);running=false;}
  }
  sync(); setInterval(sync,60000);
  window.addEventListener('online',sync);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});
};
