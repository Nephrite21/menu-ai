/* 공용 UI 헬퍼 (두 페이지 공용). 로직 없음: CustomEvent 발행 + 렌더링만. 로직은 app.js 가 이벤트를 구독해서 처리한다. */
(function(){
const CUISINES=[["korean","한식"],["western","양식"],["chinese","중식"],["japanese","일식"],["vietnamese","베트남"],["mexican","멕시코"],["thai","태국"],["indian","인도"],["fusion","퓨전"],["snack","분식"],["cafe","카페"],["other","기타"]];
const CUISINE_KO=Object.fromEntries(CUISINES);
const $=(s,r=document)=>r.querySelector(s);
const el=(tag,props={},...kids)=>{const e=Object.assign(document.createElement(tag),props);kids.flat().forEach(k=>e.append(k));return e};
const emit=(name,detail)=>document.dispatchEvent(new CustomEvent(name,{detail}));

function toast(msg,ms=2200){const t=el('div',{className:'toast',textContent:msg});document.body.append(t);setTimeout(()=>t.remove(),ms)}

/* 검색 실패(타임아웃/오류) 알림. 취소(AbortSignal)는 검색을 시작한 페이지가 처리한다. */
document.addEventListener('menu:search-failed',e=>{
  const r=e.detail&&e.detail.reason;
  toast(r==='timeout'?'찾는 데 너무 오래 걸려서 취소했어요. 다시 시도해 주세요.':'찾는 중에 문제가 생겨 취소했어요. 다시 시도해 주세요.',4000);
});

/* ---- 메뉴 목록: 목록 페이지가 await MenuUI.menusReady 로 읽는다. app.js 가 setMenus(list) 로 채운다. ---- */
let menusResolve=null,menusP=new Promise(r=>{menusResolve=r});
function setMenus(list){
  if(menusResolve){menusResolve(list);menusResolve=null;return}
  menusP=Promise.resolve(list);
  if(typeof UI.onMenusChanged==='function')UI.onMenusChanged();
}

/* ---- 결과 ---- */
/* 화면 전환(구 회전→확대)이 진행 중이면 끝난 뒤에 그린다 */
function renderResults(items){
  const d=UI.diving;
  if(d&&window.MenuSphere)window.MenuSphere.settle();   // 결과가 준비됨 → 구가 감속하며 멈추기 시작
  const s=UI.search;                                     // 이 검색이 취소됐다면 늦게 온 결과는 버린다
  (d||Promise.resolve()).then(r=>{
    if(r==='failed'||(s&&s.ac.signal.aborted))return;
    renderNow(items);
  });
}
function renderNow(items){
  const box=$('#results');if(!box)return;
  box.replaceChildren();
  document.body.classList.add('has-results');
  requestAnimationFrame(()=>box.closest('.results-zone')?.scrollIntoView({behavior:'smooth',block:'start'}));
  if(!items||!items.length){box.append(el('div',{className:'empty',textContent:'조건에 맞는 메뉴가 없어요. 조건을 바꿔보세요.'}));return}
  for(const {menu:m,score,reasons=[]} of items){
    box.append(el('article',{className:'card'},
      el('h3',{},m.name,
        el('span',{className:'badge',textContent:CUISINE_KO[m.cuisine]||m.cuisine}),
        m.cuisineInferred?el('span',{className:'badge',title:'임베딩 유사도로 종류를 추정했어요'+(m.cuisineConfidence?' (신뢰도 '+Math.round(m.cuisineConfidence*100)+'%)':''),textContent:'추정'}):'',
        m.source==='user'?el('span',{className:'badge user',textContent:'내가 추가'}):'',
        el('span',{className:'score',textContent:score!=null?'점수 '+Number(score).toFixed(2):''})),
      el('div',{className:'ings',textContent:'재료: '+(m.ingredients||[]).join(', ')}),
      m.desc?el('div',{textContent:m.desc}):'',
      reasons.length?el('ul',{className:'reasons'},reasons.map(r=>el('li',{textContent:r}))):''));
  }
}
function setProgress(p,label){ // p: 0~1, null이면 숨김
  const b=$('#progress-box');if(!b)return;
  b.hidden=p==null;if(p==null)return;
  $('#progress-bar').style.width=Math.round(p*100)+'%';
  const text=label||('모델 로딩 '+Math.round(p*100)+'%');
  $('#progress-label').textContent=text;
  if(window.MenuJelly)window.MenuJelly.set(p,text);           // 홈 화면: 검색창 자리의 젤리 로딩바(jelly.js)
  else{const hs=$('#hero-status');if(hs)hs.textContent=text}
}

/* ---- '이게 없다고?' 모달 (추가 / 수정 겸용) ---- */
let dlg=null,openModal=()=>{};
function initAddModal(){
  dlg=el('dialog',{id:'add-modal'});
  dlg.innerHTML=`<form method="dialog" id="add-form">
    <h2 id="add-title" style="color:var(--text);font-size:1.1rem">이게 없다고?</h2>
    <label>이름<input type="text" name="name" required maxlength="30"></label>
    <label>종류<select name="cuisine">${CUISINES.map(([v,k])=>`<option value="${v}">${k}</option>`).join('')}</select></label>
    <label>재료 (쉼표/Enter로 추가)</label>
    <div class="chips" id="add-ing-chips"></div>
    <input type="text" id="add-ing-input" placeholder="예: 닭고기">
    <label>태그 (쉼표로 구분, 맛·상황 단어. 공용 제안에는 2개 이상 필요)<input type="text" name="tags" placeholder="예: 매운, 야식, 혼밥"></label>
    <label>설명 (공용 제안에는 10자 이상)<input type="text" name="desc" maxlength="300"></label>
    <div class="actions">
      <button type="button" class="btn" data-act="cancel">취소</button>
      <button type="button" class="btn" data-act="suggest">공용 목록에도 제안</button>
      <button type="submit" class="btn primary" data-act="save">저장</button>
    </div></form>`;
  document.body.append(dlg);
  const form=$('#add-form',dlg),chips=$('#add-ing-chips',dlg),inp=$('#add-ing-input',dlg);
  let ings=[],editId=null;
  const draw=()=>chips.replaceChildren(...ings.map((n,i)=>el('span',{className:'chip tag'},n,el('button',{type:'button',textContent:'×',title:'삭제',onclick:()=>{ings.splice(i,1);draw()}}))));
  const commit=()=>{inp.value.split(/[,，]/).map(s=>s.trim()).filter(s=>s&&!ings.includes(s)).forEach(s=>ings.push(s));inp.value='';draw()};
  inp.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===','){e.preventDefault();commit()}});
  const collect=()=>{
    commit();const f=new FormData(form);
    const tags=[...new Set(String(f.get('tags')||'').split(/[,，]/).map(s=>s.trim()).filter(Boolean))];
    return{name:f.get('name').trim(),cuisine:f.get('cuisine'),ingredients:[...ings],tags,desc:f.get('desc').trim()};
  };
  const reset=()=>{form.reset();ings=[];editId=null;draw()};
  /* prefill 에 id 가 있으면 수정 모드 */
  openModal=(prefill)=>{
    reset();
    if(prefill){
      editId=prefill.id||null;
      form.elements.name.value=prefill.name||'';form.elements.cuisine.value=prefill.cuisine||'korean';
      ings=[...(prefill.ingredients||[])];form.elements.tags.value=(prefill.tags||[]).join(', ');form.elements.desc.value=prefill.desc||'';draw();
    }
    $('#add-title',dlg).textContent=editId?'메뉴 수정':'이게 없다고?';
    $('[data-act=suggest]',dlg).hidden=!!editId;
    dlg.showModal();
  };
  $('[data-act=cancel]',dlg).onclick=()=>dlg.close();
  /* 토스트는 여기서 띄우지 않는다: 저장/제안이 실제로 끝난 뒤 app.js 가 알린다 */
  $('[data-act=suggest]',dlg).onclick=()=>{
    if(!form.reportValidity())return;
    const m=collect();
    emit('menu:add',m);                       // 내 메뉴로도 바로 저장
    emit('menu:suggest-public',{menu:m});dlg.close();reset()};
  form.addEventListener('submit',e=>{
    if(e.submitter&&e.submitter.dataset.act!=='save')return;
    const m=collect();
    if(editId)emit('menu:update',{id:editId,...m});else emit('menu:add',m);
    reset()});
  document.querySelectorAll('[data-open-add]').forEach(b=>b.addEventListener('click',()=>openModal()));
}

const UI={CUISINES,CUISINE_KO,$,el,emit,toast,renderResults,setProgress,initAddModal,setMenus,
  get menusReady(){return menusP},openAddModal:(p)=>openModal(p)};
window.MenuUI=UI;
document.addEventListener('DOMContentLoaded',initAddModal);
})();
