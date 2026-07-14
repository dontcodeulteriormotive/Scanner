/* ============ tiny storage layer (localStorage with in-memory fallback) ============ */
const mem = {};
const store = {
  get(k, fallback){ try{ const v = localStorage.getItem(k); return v==null ? fallback : JSON.parse(v); }catch(e){ return (k in mem)? mem[k] : fallback; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){ mem[k]=v; } }
};

/* ============ state ============ */
const todayKey = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
let targets = store.get('targets', { na:2000, pr:180, kc:2600 });
let log     = store.get('log:'+todayKey(), []);
let current = null;   // { name, brand, perServing:{...}|null, per100:{...}|null, servingLabel }
let basis   = 'serving';
let qty     = 1;

const $ = id => document.getElementById(id);

/* ============ views ============ */
document.querySelectorAll('nav button').forEach(b=>{
  b.addEventListener('click', ()=>{
    document.querySelectorAll('nav button').forEach(x=>x.classList.remove('on'));
    document.querySelectorAll('.view').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    $('view-'+b.dataset.view).classList.add('on');
    if(b.dataset.view==='today') renderToday();
    if(b.dataset.view==='history') renderHistory();
    if(b.dataset.view!=='scan') stopCamera();
  });
});
$('todayLabel').textContent = new Date().toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});

/* ============ scanning ============ */
let stream=null, scanLoop=null, zxingControls=null, lastCode='', lastAt=0;

async function startCamera(){
  hideErr();
  try{
    stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ideal:'environment'} }, audio:false });
  }catch(e){
    showErr('Camera unavailable ('+ (e.name||'error') +'). You can still type the barcode number below.');
    return;
  }
  const video = $('video');
  video.srcObject = stream;
  await video.play().catch(()=>{});
  $('scanidle').style.display='none';
  $('reticle').style.display='flex';
  $('scanhint').style.display='block';

  if('BarcodeDetector' in window){
    let detector;
    try{
      detector = new BarcodeDetector({ formats:['ean_13','ean_8','upc_a','upc_e','code_128'] });
    }catch(e){ detector = new BarcodeDetector(); }
    const tick = async ()=>{
      if(!stream) return;
      try{
        const codes = await detector.detect(video);
        if(codes.length) return onCode(codes[0].rawValue);
      }catch(e){}
      scanLoop = requestAnimationFrame(tick);
    };
    scanLoop = requestAnimationFrame(tick);
  } else {
    // iOS Safari path: load ZXing on demand
    try{
      await loadScript('https://unpkg.com/@zxing/browser@latest');
      const reader = new ZXingBrowser.BrowserMultiFormatReader();
      zxingControls = await reader.decodeFromVideoElement(video, (result)=>{ if(result) onCode(result.getText()); });
    }catch(e){
      showErr('Could not load the barcode reader on this browser. Type the barcode number below instead.');
    }
  }
}
function stopCamera(){
  if(scanLoop) cancelAnimationFrame(scanLoop), scanLoop=null;
  if(zxingControls){ try{zxingControls.stop();}catch(e){} zxingControls=null; }
  if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
  $('scanidle').style.display='flex';
  $('reticle').style.display='none';
  $('scanhint').style.display='none';
}
function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s); }); }

function onCode(code){
  const now = Date.now();
  if(code===lastCode && now-lastAt<4000) return;   // debounce repeats
  lastCode=code; lastAt=now;
  if(navigator.vibrate) navigator.vibrate(60);
  stopCamera();
  lookup(code);
}

$('startScan').addEventListener('click', startCamera);
$('lookupBtn').addEventListener('click', ()=>{ const c=$('manualCode').value.replace(/\D/g,''); if(c) lookup(c); });
$('manualCode').addEventListener('keydown', e=>{ if(e.key==='Enter'){ const c=$('manualCode').value.replace(/\D/g,''); if(c) lookup(c);} });

/* ============ Open Food Facts lookup ============ */
async function lookup(code){
  hideErr(); $('result').style.display='none'; $('customForm').style.display='none';
  showInfoBtnLoading(true);
  try{
    const r = await fetch('https://world.openfoodfacts.org/api/v2/product/'+encodeURIComponent(code)+'.json?fields=product_name,brands,serving_size,nutriments');
    const data = await r.json();
    if(!data || data.status===0 || !data.product) throw new Error('notfound');
    const p = data.product, n = p.nutriments||{};
    const g = (v)=> (typeof v==='number' && isFinite(v)) ? v : null;

    const per100 = {
      na: g(n.sodium_100g)!=null ? Math.round(n.sodium_100g*1000) : null,   // OFF sodium is grams
      pr: g(n.proteins_100g), kc: g(n['energy-kcal_100g']),
      cb: g(n.carbohydrates_100g), ft: g(n.fat_100g)
    };
    const perServ = {
      na: g(n.sodium_serving)!=null ? Math.round(n.sodium_serving*1000) : null,
      pr: g(n.proteins_serving), kc: g(n['energy-kcal_serving']),
      cb: g(n.carbohydrates_serving), ft: g(n.fat_serving)
    };
    const hasServ = Object.values(perServ).some(v=>v!=null);
    const has100  = Object.values(per100).some(v=>v!=null);
    if(!hasServ && !has100) throw new Error('nonut');

    current = {
      name: p.product_name || ('Item '+code),
      brand: p.brands || '',
      perServing: hasServ ? perServ : null,
      per100: has100 ? per100 : null,
      servingLabel: p.serving_size || 'serving'
    };
    basis = hasServ ? 'serving' : '100';
    qty = 1;
    renderResult();
  }catch(e){
    if(e.message==='notfound') showErr('That barcode isn’t in Open Food Facts yet. You can log it manually with “Log a food without a barcode.”');
    else if(e.message==='nonut') showErr('Product found, but it has no nutrition data on file. Log it manually instead.');
    else showErr('Couldn’t reach the food database. Check your connection and try again.');
  }
  showInfoBtnLoading(false);
}
function showInfoBtnLoading(on){ $('lookupBtn').disabled=on; $('lookupBtn').textContent = on? '…' : 'Look up'; }

/* ============ result card ============ */
function activeNut(){
  const src = basis==='serving' ? current.perServing : current.per100;
  const scale = qty;
  const f=(v,dp=0)=> v==null? '—' : (Math.round(v*scale*(dp?10:1))/(dp?10:1));
  return { na:f(src.na), pr:f(src.pr,1), kc:f(src.kc), cb:f(src.cb,1), ft:f(src.ft,1), raw:src };
}
function renderResult(){
  $('rName').textContent = current.name;
  $('rBrand').textContent = current.brand;
  $('basisServing').classList.toggle('on', basis==='serving');
  $('basis100').classList.toggle('on', basis==='100');
  $('basisServing').style.display = current.perServing? '' : 'none';
  $('basis100').style.display = current.per100? '' : 'none';
  $('qVal').textContent = qty;
  $('qUnit').textContent = basis==='serving' ? ('× '+current.servingLabel) : '× 100 g';
  const a = activeNut();
  $('nNa').textContent=a.na; $('nPr').textContent=a.pr; $('nKc').textContent=a.kc; $('nCb').textContent=a.cb; $('nFt').textContent=a.ft;
  $('result').style.display='block';
  $('result').scrollIntoView({behavior:'smooth',block:'nearest'});
}
$('basisServing').addEventListener('click',()=>{ basis='serving'; renderResult(); });
$('basis100').addEventListener('click',()=>{ basis='100'; renderResult(); });
$('qMinus').addEventListener('click',()=>{ qty=Math.max(0.5, +(qty-0.5).toFixed(1)); renderResult(); });
$('qPlus').addEventListener('click',()=>{ qty=+(qty+0.5).toFixed(1); renderResult(); });

$('addBtn').addEventListener('click', ()=>{
  const src = basis==='serving' ? current.perServing : current.per100;
  const s = qty, r=(v,dp=0)=> v==null?0: Math.round(v*s*(dp?10:1))/(dp?10:1);
  addEntry({ name:current.name, detail: qty+' × '+(basis==='serving'?current.servingLabel:'100 g'),
    na:r(src.na), pr:r(src.pr,1), kc:r(src.kc), cb:r(src.cb,1), ft:r(src.ft,1) });
  $('result').style.display='none';
});

/* ============ custom food ============ */
$('customBtn').addEventListener('click', ()=>{ $('customForm').style.display='block'; $('result').style.display='none'; $('cName').focus(); });
$('cCancel').addEventListener('click', ()=>{ $('customForm').style.display='none'; });
$('cAdd').addEventListener('click', ()=>{
  const name=$('cName').value.trim(); if(!name){ $('cName').focus(); return; }
  const num=id=>{ const v=parseFloat($(id).value); return isFinite(v)? v:0; };
  addEntry({ name, detail:'custom', na:num('cNa'), pr:num('cPr'), kc:num('cKc'), cb:num('cCb'), ft:num('cFt') });
  ['cName','cNa','cPr','cKc','cCb','cFt'].forEach(id=>$(id).value='');
  $('customForm').style.display='none';
});

/* ============ log ============ */
function addEntry(e){
  e.id = Date.now()+Math.random().toString(16).slice(2);
  e.at = new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
  log.push(e); persist(); toast();
}
function removeEntry(id){ log = log.filter(x=>x.id!==id); persist(); renderToday(); }
function persist(){ store.set('log:'+todayKey(), log); }

function renderToday(){
  // roll over the day if the app was left open past midnight
  const fresh = store.get('log:'+todayKey(), null);
  if(fresh!==null) log = fresh; else { log=[]; persist(); }

  const sum = log.reduce((a,e)=>({na:a.na+(+e.na||0),pr:a.pr+(+e.pr||0),kc:a.kc+(+e.kc||0),cb:a.cb+(+e.cb||0),ft:a.ft+(+e.ft||0)}),{na:0,pr:0,kc:0,cb:0,ft:0});
  $('naUsed').textContent = Math.round(sum.na);
  $('naCap').textContent = targets.na;
  const left = targets.na - sum.na;
  $('naLeft').textContent = left>=0 ? Math.round(left)+' mg left' : Math.round(-left)+' mg over';
  const pct = Math.min(100, (sum.na/targets.na)*100);
  $('gaugeFill').style.width = pct+'%';
  $('gauge').classList.toggle('over', sum.na>targets.na);
  const st=$('naStatus');
  if(sum.na>targets.na){ st.textContent='Over your sodium cap — go easy the rest of the day.'; st.classList.add('over'); }
  else if(pct>75){ st.textContent='Getting close to your cap. Choose low-sodium from here.'; st.classList.remove('over'); }
  else { st.textContent='On track.'; st.classList.remove('over'); }

  $('sumPr').textContent=Math.round(sum.pr*10)/10; $('sumKc').textContent=Math.round(sum.kc);
  $('sumCb').textContent=Math.round(sum.cb); $('sumFt').textContent=Math.round(sum.ft);
  $('goalPr').textContent=targets.pr; $('goalKc').textContent=targets.kc;

  const list=$('logList'); list.innerHTML='';
  if(!log.length){ list.innerHTML='<div class="empty">Nothing logged yet. Scan something on the Scan tab.</div>'; return; }
  [...log].reverse().forEach(e=>{
    const div=document.createElement('div'); div.className='entry';
    div.innerHTML='<div class="info"><div class="n"></div><div class="m"><span class="na">'+Math.round(e.na)+' mg Na</span> · <span class="pr">'+e.pr+' g P</span> · '+Math.round(e.kc)+' kcal · '+e.at+'</div></div><button class="del" aria-label="Delete">✕</button>';
    div.querySelector('.n').textContent = e.name + (e.detail? ' · '+e.detail : '');
    div.querySelector('.del').addEventListener('click',()=>removeEntry(e.id));
    list.appendChild(div);
  });
}

/* ============ history ============ */
function allDayKeys(){
  const keys = new Set(Object.keys(mem).filter(k=>k.startsWith('log:')));
  try{ for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(k && k.startsWith('log:')) keys.add(k); } }catch(e){}
  return [...keys].map(k=>k.slice(4)).sort().reverse();   // newest first, dates are YYYY-MM-DD
}
function dayTotals(entries){
  return entries.reduce((a,e)=>({na:a.na+(+e.na||0),pr:a.pr+(+e.pr||0),kc:a.kc+(+e.kc||0)}),{na:0,pr:0,kc:0});
}
function niceDate(iso){
  const [y,m,d]=iso.split('-').map(Number);
  const dt=new Date(y,m-1,d);
  if(iso===todayKey()) return 'Today';
  const yest=new Date(); yest.setDate(yest.getDate()-1);
  if(dt.toDateString()===yest.toDateString()) return 'Yesterday';
  return dt.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
}
function relog(e){
  addEntry({ name:e.name, detail:e.detail, na:e.na, pr:e.pr, kc:e.kc, cb:e.cb||0, ft:e.ft||0 });
}
function renderHistory(){
  // week chart: last 7 calendar days
  const bars=$('weekBars'); bars.innerHTML='';
  for(let i=6;i>=0;i--){
    const d=new Date(); d.setDate(d.getDate()-i);
    const key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const t=dayTotals(store.get('log:'+key,[]));
    const naPct=Math.min(1.15,t.na/targets.na), prPct=Math.min(1.15,t.pr/targets.pr);
    const col=document.createElement('div'); col.className='col';
    col.innerHTML='<div class="bars">'
      +'<div class="bar na'+(t.na>targets.na?' over':'')+'" style="height:'+Math.max(3,naPct*74)+'px"></div>'
      +'<div class="bar pr" style="height:'+Math.max(3,prPct*74)+'px"></div>'
      +'</div><div class="dl">'+d.toLocaleDateString(undefined,{weekday:'narrow'})+'</div>';
    bars.appendChild(col);
  }
  // day list
  const list=$('historyList'); list.innerHTML='';
  const days=allDayKeys();
  if(!days.length){ list.innerHTML='<div class="empty">No days logged yet.</div>'; return; }
  days.forEach(iso=>{
    const entries=store.get('log:'+iso,[]);
    if(!entries.length && iso!==todayKey()) return;
    const t=dayTotals(entries);
    const day=document.createElement('div'); day.className='day';
    day.innerHTML='<div class="head"><span class="chev">▶</span><div class="d">'+niceDate(iso)+'<small>'+entries.length+' item'+(entries.length===1?'':'s')+'</small></div>'
      +'<div class="tot"><b>'+Math.round(t.na)+' mg Na</b><br><i>'+Math.round(t.pr*10)/10+' g P</i> · '+Math.round(t.kc)+' kcal</div></div>'
      +'<div class="body"></div>';
    const body=day.querySelector('.body');
    entries.slice().reverse().forEach(e=>{
      const div=document.createElement('div'); div.className='entry';
      div.innerHTML='<div class="info"><div class="n"></div><div class="m"><span class="na">'+Math.round(e.na)+' mg Na</span> · <span class="pr">'+e.pr+' g P</span> · '+Math.round(e.kc)+' kcal'+(e.at?' · '+e.at:'')+'</div></div>'
        +'<button class="relog" aria-label="Log again today">↻</button>';
      div.querySelector('.n').textContent = e.name + (e.detail? ' · '+e.detail : '');
      div.querySelector('.relog').addEventListener('click', ev=>{ ev.stopPropagation(); relog(e); });
      body.appendChild(div);
    });
    day.querySelector('.head').addEventListener('click', ()=>day.classList.toggle('open'));
    list.appendChild(day);
  });
}

/* ============ targets ============ */
function loadTargets(){ $('tNa').value=targets.na; $('tPr').value=targets.pr; $('tKc').value=targets.kc; }
$('saveTargets').addEventListener('click', ()=>{
  targets = {
    na: Math.max(1, parseInt($('tNa').value)||2000),
    pr: Math.max(1, parseInt($('tPr').value)||180),
    kc: Math.max(1, parseInt($('tKc').value)||2600)
  };
  store.set('targets', targets); toast('Saved ✓');
});
$('clearToday').addEventListener('click', ()=>{ if(confirm('Clear everything logged today?')){ log=[]; persist(); renderToday(); toast('Cleared'); } });

/* ============ backup ============ */
$('exportBtn').addEventListener('click', ()=>{
  const data={ app:'MacroScan', exported:new Date().toISOString(), targets, days:{} };
  allDayKeys().forEach(iso=>{ data.days[iso]=store.get('log:'+iso,[]); });
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='macroscan-backup-'+todayKey()+'.json'; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  toast('Exported ✓');
});
$('importBtn').addEventListener('click', ()=>$('importFile').click());
$('importFile').addEventListener('change', e=>{
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      const data=JSON.parse(reader.result);
      if(!data.days) throw new Error('bad');
      let count=0;
      Object.entries(data.days).forEach(([iso,entries])=>{
        if(!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Array.isArray(entries)) return;
        const existing=store.get('log:'+iso,[]);
        const ids=new Set(existing.map(x=>x.id));
        entries.forEach(en=>{ if(!ids.has(en.id)){ existing.push(en); count++; } });
        existing.sort((a,b)=>(a.id>b.id?1:-1));
        store.set('log:'+iso,existing);
      });
      if(data.targets){ targets=data.targets; store.set('targets',targets); loadTargets(); }
      log=store.get('log:'+todayKey(),[]);
      renderToday(); toast('Imported '+count+' items');
    }catch(err){ alert('That file doesn’t look like a MacroScan backup.'); }
    e.target.value='';
  };
  reader.readAsText(file);
});

/* ============ misc ============ */
function showErr(t){ const m=$('scanerr'); m.textContent=t; m.classList.add('show'); }
function hideErr(){ $('scanerr').classList.remove('show'); }
let toastT=null;
function toast(t){ const el=$('toast'); el.textContent=t||'Logged ✓'; el.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('show'),1600); }

loadTargets();
renderToday();

/* ============ service worker (offline support) ============ */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(err=>{
      console.warn('Service worker registration failed:', err);
    });
  });
}
