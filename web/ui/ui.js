/* 공용 UI 헬퍼 (두 페이지 공용). 로직 없음: CustomEvent 발행 + 렌더링만. */
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

/* 화면 전환(구 회전→확대)이 진행 중이면 끝난 뒤에 그린다 */
function renderResults(items){
  const d=window.MenuUI&&window.MenuUI.diving;
  if(d&&window.MenuSphere)window.MenuSphere.settle();   // 결과가 준비됨 → 구가 감속하며 멈추기 시작
  const s=window.MenuUI&&window.MenuUI.search;           // 이 검색이 취소됐다면 늦게 온 결과는 버린다
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
  $('#progress-label').textContent=label||('모델 로딩 '+Math.round(p*100)+'%');
}

/* '이게 없다고?' 모달 */
function initAddModal(){
  const dlg=el('dialog',{id:'add-modal'});
  dlg.innerHTML=`<form method="dialog" id="add-form">
    <h2 style="color:var(--text);font-size:1.1rem">이게 없다고?</h2>
    <label>이름<input type="text" name="name" required maxlength="40"></label>
    <label>종류<select name="cuisine">${CUISINES.map(([v,k])=>`<option value="${v}">${k}</option>`).join('')}</select></label>
    <label>재료 (쉼표/Enter로 추가)</label>
    <div class="chips" id="add-ing-chips"></div>
    <input type="text" id="add-ing-input" placeholder="예: 닭고기">
    <label>한 줄 설명<input type="text" name="desc" maxlength="120"></label>
    <div class="actions">
      <button type="button" class="btn" data-act="cancel">취소</button>
      <button type="button" class="btn" data-act="suggest">공용 목록에도 제안</button>
      <button type="submit" class="btn primary" data-act="save">저장</button>
    </div></form>`;
  document.body.append(dlg);
  const form=$('#add-form',dlg),chips=$('#add-ing-chips',dlg),inp=$('#add-ing-input',dlg);
  let ings=[];
  const draw=()=>chips.replaceChildren(...ings.map((n,i)=>el('span',{className:'chip tag'},n,el('button',{type:'button',textContent:'×',title:'삭제',onclick:()=>{ings.splice(i,1);draw()}}))));
  const commit=()=>{inp.value.split(/[,，]/).map(s=>s.trim()).filter(s=>s&&!ings.includes(s)).forEach(s=>ings.push(s));inp.value='';draw()};
  inp.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===','){e.preventDefault();commit()}});
  const collect=()=>{commit();const f=new FormData(form);return{name:f.get('name').trim(),cuisine:f.get('cuisine'),ingredients:[...ings],desc:f.get('desc').trim()}};
  const reset=()=>{form.reset();ings=[];draw()};
  $('[data-act=cancel]',dlg).onclick=()=>dlg.close();
  $('[data-act=suggest]',dlg).onclick=()=>{
    if(!form.reportValidity())return;
    emit('menu:suggest-public',{menu:collect()});toast('공용 목록에 제안했어요');dlg.close();reset()};
  form.addEventListener('submit',e=>{
    if(e.submitter&&e.submitter.dataset.act!=='save')return;
    emit('menu:add',collect());toast('저장했어요');reset()});
  document.querySelectorAll('[data-open-add]').forEach(b=>b.addEventListener('click',()=>dlg.showModal()));
}

window.MenuUI={CUISINES,CUISINE_KO,$,el,emit,toast,renderResults,setProgress,initAddModal};
document.addEventListener('DOMContentLoaded',initAddModal);
})();
