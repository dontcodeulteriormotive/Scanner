/* ============ tiny storage layer (localStorage with in-memory fallback) ============ */
const mem = {};
const store = {
  get(k, fallback){ try{ const v = localStorage.getItem(k); return v==null ? fallback : JSON.parse(v); }catch(e){ return (k in mem)? mem[k] : fallback; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){ mem[k]=v; } }
};

/* ============ state ============ */
const todayKey = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
let targets   = store.get('targets', { na:2000, pr:180, kc:2600 });
let log       = store.get('log:'+todayKey(), []);
let favorites = store.get('favorites', []);
let current   = null;   // { name, brand, perServing:{...}|null, per100:{...}|null, servingLabel }
let basis     = 'serving';
let qty       = 1;
let mealR     = 'snack';   // meal chosen on the result card
let mealC     = 'snack';   // meal chosen on the custom / edit form
let editingId = null;      // entry id currently being edited (via custom form)

const $ = id => document.getElementById(id);

/* ============ meals ============ */
const MEAL_ORDER = ['breakfast','lunch','dinner','snack'];
const MEAL_LABEL = { breakfast:'Breakfast', lunch:'Lunch', dinner:'Dinner', snack:'Snack', other:'Other' };
function defaultMeal(){
  const h = new Date().getHours();
  if(h < 11) return 'breakfast';
  if(h < 16) return 'lunch';
  if(h < 21) return 'dinner';
  return 'snack';
}
function setupMealSelector(wrapId, initial, onPick){
  const wrap = $(wrapId);
  wrap.querySelectorAll('button').forEach(b=>{
    b.onclick = ()=>{
      wrap.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      onPick(b.dataset.meal);
    };
  });
  paintMealSelector(wrapId, initial);
}
function paintMealSelector(wrapId, meal){
  $(wrapId).querySelectorAll('button').forEach(b=> b.classList.toggle('on', b.dataset.meal===meal));
}

/* ============ views ============ */
document.querySelectorAll('nav button').forEach(b=>{
  b.addEventListener('click', ()=>{
    document.querySelectorAll('nav button').forEach(x=>x.classList.remove('on'));
    document.querySelectorAll('.view').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    $('view-'+b.dataset.view).classList.add('on');
    if(b.dataset.view==='scan') renderQuickAdd();
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
    showErr('Camera unavailable ('+ (e.name||'error') +'). You can still search by name or type the barcode number below.');
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
      showErr('Could not load the barcode reader on this browser. Search by name or type the barcode number below instead.');
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

/* ============ Open Food Facts: parse + barcode lookup + name search ============ */
const g = (v)=> (typeof v==='number' && isFinite(v)) ? v : null;
function parseProduct(p, code){
  const n = p.nutriments || {};
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
  if(!hasServ && !has100) return null;
  return {
    name: p.product_name || ('Item '+(code||p.code||'')),
    brand: p.brands || '',
    perServing: hasServ ? perServ : null,
    per100: has100 ? per100 : null,
    servingLabel: p.serving_size || 'serving'
  };
}
function showResultFrom(parsed){
  current = parsed;
  basis = parsed.perServing ? 'serving' : '100';
  qty = 1;
  mealR = defaultMeal();
  $('customForm').style.display='none';
  renderResult();
}

async function lookup(code){
  hideErr(); $('result').style.display='none'; $('customForm').style.display='none'; $('searchResults').innerHTML='';
  showBtnLoading('lookupBtn','Look up',true);
  try{
    const r = await fetch('https://world.openfoodfacts.org/api/v2/product/'+encodeURIComponent(code)+'.json?fields=product_name,brands,serving_size,nutriments');
    const data = await r.json();
    if(!data || data.status===0 || !data.product) throw new Error('notfound');
    const parsed = parseProduct(data.product, code);
    if(!parsed) throw new Error('nonut');
    showResultFrom(parsed);
  }catch(e){
    if(e.message==='notfound') showErr('That barcode isn’t in Open Food Facts yet. Try searching by name, or use “Log a food without a barcode.”');
    else if(e.message==='nonut') showErr('Product found, but it has no nutrition data on file. Log it manually instead.');
    else showErr('Couldn’t reach the food database. Check your connection and try again.');
  }
  showBtnLoading('lookupBtn','Look up',false);
}

async function search(query){
  hideErr(); $('result').style.display='none'; $('customForm').style.display='none';
  const box = $('searchResults');
  box.innerHTML='<div class="empty">Searching…</div>';
  showBtnLoading('searchBtn','Search',true);
  try{
    const url = 'https://world.openfoodfacts.org/cgi/search.pl?search_terms='+encodeURIComponent(query)
      +'&search_simple=1&action=process&json=1&page_size=24&fields=code,product_name,brands,serving_size,nutriments';
    const r = await fetch(url);
    const data = await r.json();
    const products = (data && data.products) || [];
    const rows = products
      .map(p=>({ p, parsed: parseProduct(p, p.code) }))
      .filter(x=> x.parsed && x.parsed.name && x.parsed.name.trim() && !/^Item /.test(x.parsed.name))
      .slice(0, 15);
    if(!rows.length){ box.innerHTML='<div class="empty">No matches with nutrition data. Try another term, or log it manually.</div>'; }
    else {
      box.innerHTML='';
      rows.forEach(({parsed})=>{
        const div=document.createElement('div'); div.className='sresult';
        div.innerHTML='<div class="info"><div class="n"></div><div class="b"></div></div><span class="go">＋</span>';
        div.querySelector('.n').textContent = parsed.name;
        div.querySelector('.b').textContent = parsed.brand || (parsed.perServing?'per serving':'per 100 g');
        div.addEventListener('click', ()=>{ showResultFrom(parsed); });
        box.appendChild(div);
      });
    }
  }catch(e){
    box.innerHTML='<div class="empty">Couldn’t reach the food database. Check your connection and try again.</div>';
  }
  showBtnLoading('searchBtn','Search',false);
}
$('searchBtn').addEventListener('click', ()=>{ const q=$('searchQuery').value.trim(); if(q) search(q); });
$('searchQuery').addEventListener('keydown', e=>{ if(e.key==='Enter'){ const q=$('searchQuery').value.trim(); if(q) search(q);} });

function showBtnLoading(id,label,on){ $(id).disabled=on; $(id).textContent = on? '…' : label; }

/* ============ result card ============ */
function computedFromCurrent(){
  const src = basis==='serving' ? current.perServing : current.per100;
  const s = qty, r=(v,dp=0)=> v==null?0: Math.round(v*s*(dp?10:1))/(dp?10:1);
  return {
    name: current.name,
    detail: qty+' × '+(basis==='serving'?current.servingLabel:'100 g'),
    na:r(src.na), pr:r(src.pr,1), kc:r(src.kc), cb:r(src.cb,1), ft:r(src.ft,1)
  };
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
  const src = basis==='serving' ? current.perServing : current.per100;
  const f=(v,dp=0)=> v==null? '—' : (Math.round(v*qty*(dp?10:1))/(dp?10:1));
  $('nNa').textContent=f(src.na); $('nPr').textContent=f(src.pr,1); $('nKc').textContent=f(src.kc); $('nCb').textContent=f(src.cb,1); $('nFt').textContent=f(src.ft,1);
  paintMealSelector('mealSelR', mealR);
  $('favBtn').textContent = isFavorite(computedFromCurrent()) ? '★' : '☆';
  $('result').style.display='block';
  $('result').scrollIntoView({behavior:'smooth',block:'nearest'});
}
$('basisServing').addEventListener('click',()=>{ basis='serving'; renderResult(); });
$('basis100').addEventListener('click',()=>{ basis='100'; renderResult(); });
$('qMinus').addEventListener('click',()=>{ qty=Math.max(0.5, +(qty-0.5).toFixed(1)); renderResult(); });
$('qPlus').addEventListener('click',()=>{ qty=+(qty+0.5).toFixed(1); renderResult(); });
setupMealSelector('mealSelR', mealR, m=>{ mealR=m; });

$('addBtn').addEventListener('click', ()=>{
  const e = computedFromCurrent(); e.meal = mealR;
  addEntry(e);
  $('result').style.display='none';
});
$('favBtn').addEventListener('click', ()=>{
  toggleFavorite(computedFromCurrent());
  $('favBtn').textContent = isFavorite(computedFromCurrent()) ? '★' : '☆';
});

/* ============ favorites + quick add ============ */
function favKey(e){ return (e.name||'')+'|'+(e.detail||''); }
function isFavorite(e){ return favorites.some(f=>favKey(f)===favKey(e)); }
function toggleFavorite(e){
  const k=favKey(e);
  if(favorites.some(f=>favKey(f)===k)){ favorites=favorites.filter(f=>favKey(f)!==k); toast('Removed favorite'); }
  else { favorites.unshift({ name:e.name, detail:e.detail, na:e.na, pr:e.pr, kc:e.kc, cb:e.cb, ft:e.ft }); toast('Favorited ★'); }
  store.set('favorites', favorites);
  renderQuickAdd();
}
function recentFoods(limit){
  const seen=new Set(), out=[];
  const keys = allDayKeys();
  for(const iso of keys){
    const entries = store.get('log:'+iso,[]);
    for(const e of [...entries].reverse()){
      const k=favKey(e);
      if(seen.has(k)) continue;
      seen.add(k); out.push(e);
      if(out.length>=limit) return out;
    }
  }
  return out;
}
function renderQuickAdd(){
  const wrap=$('quickAdd'), section=$('quickAddWrap');
  wrap.innerHTML='';
  const favs = favorites.slice(0,10);
  const favKeys = new Set(favs.map(favKey));
  const recents = recentFoods(12).filter(e=>!favKeys.has(favKey(e))).slice(0,8);
  if(!favs.length && !recents.length){ section.style.display='none'; return; }
  section.style.display='block';
  const makeChip=(e,fav)=>{
    const chip=document.createElement('div'); chip.className='chip'+(fav?' fav':'');
    chip.innerHTML='<button class="star" aria-label="Toggle favorite">'+(fav?'★':'☆')+'</button>'
      +'<span class="t"></span><span class="na">'+Math.round(e.na)+' mg</span>';
    chip.querySelector('.t').textContent = e.name + (e.detail && e.detail!=='custom' ? ' · '+e.detail : '');
    const quick=()=> addEntry({ name:e.name, detail:e.detail, na:e.na, pr:e.pr, kc:e.kc, cb:e.cb||0, ft:e.ft||0, meal:defaultMeal() });
    chip.querySelector('.t').addEventListener('click', quick);
    chip.querySelector('.na').addEventListener('click', quick);
    chip.querySelector('.star').addEventListener('click', ev=>{ ev.stopPropagation(); toggleFavorite(e); });
    return chip;
  };
  favs.forEach(e=>wrap.appendChild(makeChip(e,true)));
  recents.forEach(e=>wrap.appendChild(makeChip(e,false)));
}

/* ============ custom food + edit ============ */
$('customBtn').addEventListener('click', ()=>{ openCustomForm(null); });
$('cCancel').addEventListener('click', ()=>{ closeCustomForm(); });
setupMealSelector('mealSelC', mealC, m=>{ mealC=m; });

function openCustomForm(entry){
  editingId = entry ? entry.id : null;
  $('customTitle').textContent = entry ? 'Edit entry' : 'Custom food';
  $('cAdd').textContent = entry ? 'Save changes' : 'Add to log';
  $('cName').value = entry ? entry.name : '';
  $('cNa').value = entry ? entry.na : '';
  $('cPr').value = entry ? entry.pr : '';
  $('cKc').value = entry ? entry.kc : '';
  $('cCb').value = entry ? (entry.cb||'') : '';
  $('cFt').value = entry ? (entry.ft||'') : '';
  mealC = entry ? (entry.meal||'snack') : defaultMeal();
  paintMealSelector('mealSelC', mealC);
  $('result').style.display='none';
  $('customForm').style.display='block';
  $('customForm').scrollIntoView({behavior:'smooth',block:'nearest'});
  if(!entry) $('cName').focus();
}
function closeCustomForm(){
  $('customForm').style.display='none';
  editingId=null;
  ['cName','cNa','cPr','cKc','cCb','cFt'].forEach(id=>$(id).value='');
}
$('cAdd').addEventListener('click', ()=>{
  const name=$('cName').value.trim(); if(!name){ $('cName').focus(); return; }
  const num=id=>{ const v=parseFloat($(id).value); return isFinite(v)? v:0; };
  const vals={ name, na:num('cNa'), pr:num('cPr'), kc:num('cKc'), cb:num('cCb'), ft:num('cFt'), meal:mealC };
  if(editingId){
    log = log.map(e=> e.id===editingId ? { ...e, ...vals, detail:(e.detail==='custom'||!e.detail)?'custom':e.detail } : e);
    persist(); toast('Updated'); renderToday();
  } else {
    addEntry({ ...vals, detail:'custom' });
  }
  closeCustomForm();
});

/* ============ log ============ */
function addEntry(e){
  e.id = Date.now()+Math.random().toString(16).slice(2);
  e.at = new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
  if(!e.meal) e.meal = defaultMeal();
  log.push(e); persist(); toast();
  if($('view-today').classList.contains('on')) renderToday();
}
function removeEntry(id){ log = log.filter(x=>x.id!==id); persist(); renderToday(); }
function persist(){ store.set('log:'+todayKey(), log); }

function entryRow(e, opts){
  const div=document.createElement('div'); div.className='entry';
  div.innerHTML='<div class="info"><div class="n"></div><div class="m"><span class="na">'+Math.round(e.na)+' mg Na</span> · <span class="pr">'+e.pr+' g P</span> · '+Math.round(e.kc)+' kcal'+(e.at?' · '+e.at:'')+'</div></div>';
  div.querySelector('.n').textContent = e.name + (e.detail && e.detail!=='custom' ? ' · '+e.detail : '');
  if(opts && opts.edit){
    const eb=document.createElement('button'); eb.className='edit'; eb.setAttribute('aria-label','Edit'); eb.textContent='✎';
    eb.addEventListener('click', ()=>{ document.querySelector('nav button[data-view="scan"]').click(); openCustomForm(e); });
    div.appendChild(eb);
  }
  if(opts && opts.del){
    const db=document.createElement('button'); db.className='del'; db.setAttribute('aria-label','Delete'); db.textContent='✕';
    db.addEventListener('click', ()=>removeEntry(e.id));
    div.appendChild(db);
  }
  if(opts && opts.relog){
    const rb=document.createElement('button'); rb.className='relog'; rb.setAttribute('aria-label','Log again today'); rb.textContent='↻';
    rb.addEventListener('click', ev=>{ ev.stopPropagation(); relog(e); });
    div.appendChild(rb);
  }
  return div;
}

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
  if(!log.length){ list.innerHTML='<div class="empty">Nothing logged yet. Scan, search, or quick-add on the Scan tab.</div>'; return; }

  // group by meal, in meal order, then any 'other'
  const groups={};
  log.forEach(e=>{ const m = MEAL_ORDER.includes(e.meal)? e.meal : 'other'; (groups[m]=groups[m]||[]).push(e); });
  const order = MEAL_ORDER.concat('other').filter(m=>groups[m] && groups[m].length);
  order.forEach(m=>{
    const entries=groups[m];
    const naSub=entries.reduce((a,e)=>a+(+e.na||0),0);
    const prSub=entries.reduce((a,e)=>a+(+e.pr||0),0);
    const head=document.createElement('div'); head.className='mealhead';
    head.innerHTML='<span class="ml">'+MEAL_LABEL[m]+'</span><span class="ms"><b>'+Math.round(naSub)+' mg Na</b> · '+Math.round(prSub*10)/10+' g P</span>';
    list.appendChild(head);
    entries.forEach(e=> list.appendChild(entryRow(e, {edit:true, del:true})));
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
function dateKeyOffset(days){
  const d=new Date(); d.setDate(d.getDate()-days);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
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
  addEntry({ name:e.name, detail:e.detail, na:e.na, pr:e.pr, kc:e.kc, cb:e.cb||0, ft:e.ft||0, meal:defaultMeal() });
}

function renderInsights(){
  // averages over logged days within a window
  function avg(days, pick){
    let total=0, n=0;
    for(let i=0;i<days;i++){
      const entries=store.get('log:'+dateKeyOffset(i),[]);
      if(!entries.length) continue;
      total += pick(dayTotals(entries)); n++;
    }
    return n? Math.round(total/n) : 0;
  }
  const na7=avg(7,t=>t.na), na30=avg(30,t=>t.na), pr7=avg(7,t=>t.pr);
  $('stNa7').innerHTML = na7+'<small> mg</small>';
  $('stNa30').innerHTML = na30+'<small> mg</small>';
  $('stPr7').innerHTML = pr7+'<small> g</small>';

  // streak: consecutive days (back from today) that are logged AND under cap.
  // an empty "today" doesn't break the streak — it just isn't counted yet.
  let streak=0;
  for(let i=0;i<365;i++){
    const entries=store.get('log:'+dateKeyOffset(i),[]);
    if(!entries.length){ if(i===0) continue; else break; }
    if(dayTotals(entries).na <= targets.na) streak++; else break;
  }
  $('stStreak').textContent = streak;

  const note=$('stNote');
  if(na7===0 && na30===0){ note.textContent='Log a few days to see your averages and streak build up.'; note.classList.remove('over'); }
  else if(na7>targets.na){ note.textContent='Your 7-day sodium average is above your cap. Small swaps add up.'; note.classList.add('over'); }
  else { note.textContent = streak>0 ? ('Nice — '+streak+' day'+(streak===1?'':'s')+' under your sodium cap.') : 'Under your cap on average this week.'; note.classList.remove('over'); }
}

function renderHistory(){
  renderInsights();
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
    entries.slice().reverse().forEach(e=> body.appendChild(entryRow(e, {relog:true})));
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
  const data={ app:'MacroScan', exported:new Date().toISOString(), targets, favorites, days:{} };
  allDayKeys().forEach(iso=>{ data.days[iso]=store.get('log:'+iso,[]); });
  downloadFile(JSON.stringify(data,null,2), 'application/json', 'macroscan-backup-'+todayKey()+'.json');
  toast('Exported ✓');
});
$('exportCsv').addEventListener('click', ()=>{
  const rows=[['date','time','meal','name','detail','sodium_mg','protein_g','calories_kcal','carbs_g','fat_g']];
  const esc=s=>{ s=(s==null?'':String(s)); return /[",\n]/.test(s)? '"'+s.replace(/"/g,'""')+'"' : s; };
  allDayKeys().sort().forEach(iso=>{
    store.get('log:'+iso,[]).forEach(e=>{
      rows.push([iso, e.at||'', e.meal||'', e.name||'', e.detail||'', e.na||0, e.pr||0, e.kc||0, e.cb||0, e.ft||0].map(esc));
    });
  });
  if(rows.length===1){ toast('No history to export'); return; }
  downloadFile(rows.map(r=>r.join(',')).join('\n'), 'text/csv', 'macroscan-history-'+todayKey()+'.csv');
  toast('CSV exported ✓');
});
function downloadFile(content, type, filename){
  const blob=new Blob([content],{type});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
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
      if(Array.isArray(data.favorites)){ favorites=data.favorites; store.set('favorites',favorites); }
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
renderQuickAdd();

/* ============ service worker (offline support) ============ */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(err=>{
      console.warn('Service worker registration failed:', err);
    });
  });
}
