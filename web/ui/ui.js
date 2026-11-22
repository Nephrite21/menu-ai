/* 공용 UI 헬퍼 (두 페이지 공용). 로직 없음: CustomEvent 발행 + 렌더링만. 로직은 app.js 가 이벤트를 구독해서 처리한다. */
(function(){
const CUISINES=[["korean","한식"],["northkorean","북한"],["western","양식"],["chinese","중식"],["japanese","일식"],["vietnamese","베트남"],["mexican","멕시코"],["thai","태국"],["indian","인도"],["fusion","퓨전"],["snack","분식"],["cafe","카페"],["other","기타"]];
const CUISINE_KO=Object.fromEntries(CUISINES);
const $=(s,r=document)=>r.querySelector(s);
const el=(tag,props={},...kids)=>{const e=Object.assign(document.createElement(tag),props);kids.flat().forEach(k=>e.append(k));return e};
const emit=(name,detail)=>document.dispatchEvent(new CustomEvent(name,{detail}));

function toast(msg,ms=2200,action){
  const t=el('div',{className:'toast'},msg);
  if(action)t.append(el('button',{type:'button',className:'toast-act',textContent:action.label,onclick:()=>{t.remove();action.onClick()}}));
  document.body.append(t);setTimeout(()=>t.remove(),ms)}

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
function renderResults(items,opts={}){
  const d=UI.diving;
  if(d&&window.MenuSphere)window.MenuSphere.settle();   // 결과가 준비됨 → 구가 감속하며 멈추기 시작
  const s=UI.search;                                     // 이 검색이 취소됐다면 늦게 온 결과는 버린다
  (d||Promise.resolve()).then(r=>{
    if(r==='failed'||(s&&s.ac.signal.aborted))return;
    renderNow(items,opts);
  });
}
function renderNow(items,opts={}){
  const box=$('#results');if(!box)return;
  box.replaceChildren();
  document.body.classList.add('has-results');
  if(!opts.noScroll)requestAnimationFrame(()=>box.closest('.results-zone')?.scrollIntoView({behavior:'smooth',block:'start'}));
  if(!items||!items.length){box.append(el('div',{className:'empty',textContent:'조건에 맞는 메뉴가 없어요. 조건을 바꿔보세요.'}));return}
  /* 카드: 이름·배지·점수(우상단 한 곳)·재료·설명. 누르면 상세 창이 열린다(추천 이유 등은 거기서). */
  for(const {menu:m,score,reasons=[]} of items){
    const open=()=>openDetail(m,{score,reasons});
    box.append(el('article',{className:'card',tabIndex:0,role:'button',title:'눌러서 자세히 보기',onclick:open,
        onkeydown:e=>{if(e.target!==e.currentTarget)return;if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}}},
      el('h3',{},m.name,
        el('span',{className:'badge',textContent:CUISINE_KO[m.cuisine]||m.cuisine}),
        m.brand?el('span',{className:'badge',textContent:m.brand}):'',
        m.cuisineInferred?el('span',{className:'badge',title:'임베딩 유사도로 종류를 추정했어요'+(m.cuisineConfidence?' (신뢰도 '+Math.round(m.cuisineConfidence*100)+'%)':''),textContent:'추정'}):'',
        m.source==='user'?el('span',{className:'badge user',textContent:'내가 추가'}):'',
        el('span',{className:'score',textContent:score!=null?'점수 '+Number(score).toFixed(2):''})),
      (m.ingredients||[]).length?el('div',{className:'ings',textContent:'재료: '+m.ingredients.join(', ')}):'',
      m.desc?el('div',{className:'card-desc',textContent:m.desc}):'',
      el('div',{className:'card-foot'},banButton(m))));
  }
}

/* ---- 숨기기(밴): 먹고 싶지 않은 메뉴는 더 이상 추천하지 않는다. 저장·필터링은 app.js ---- */
const BAN_SVG='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>';
function banButton(m){
  const b=el('button',{type:'button',className:'card-ban',title:'이 메뉴는 더 이상 추천하지 않아요',
    onclick:e=>{e.stopPropagation();emit('menu:ban',{id:m.id,name:m.name})}});
  b.innerHTML=BAN_SVG+'<span>숨기기</span>';return b;
}
function banToggle(m){
  const banned=UI.isBanned(m.id);
  return el('button',{type:'button',className:'btn small'+(banned?'':' danger'),textContent:banned?'숨김 해제':'이 메뉴 숨기기',
    onclick:()=>{emit(banned?'menu:unban':'menu:ban',{id:m.id,name:m.name});detailDlg.close()}});
}
function setHiddenCount(n){
  const note=$('#hidden-note');if(!note)return;
  note.hidden=!n;const c=$('#hidden-count');if(c)c.textContent=String(n);
}

/* ---- 메뉴 상세 창 (카드·목록 행을 누르면 열림) ---- */
let detailDlg=null;
const ALLOWED_LINK=/^https:\/\/(ko\.wikipedia\.org|www\.wikidata\.org)\//;
/* 출처 문자열의 URL 중 위키백과/위키데이터만 링크로 바꾼다(그 밖의 URL 은 글자로만 표시) */
function linkify(text){
  const out=[];let last=0;
  for(const m of String(text).matchAll(/https:\/\/[^\s;)]+/g)){
    out.push(text.slice(last,m.index));
    out.push(ALLOWED_LINK.test(m[0])?el('a',{href:m[0],target:'_blank',rel:'noopener noreferrer',textContent:decodeURI(m[0]).replace(/^https:\/\//,'')}):m[0]);
    last=m.index+m[0].length;
  }
  out.push(text.slice(last));return out;
}
function sourceNode(m){
  switch(m.source){
    case 'curated':return '직접 정리한 메뉴 데이터';
    case 'franchise':return (m.brand?m.brand+' · ':'')+'메뉴 이름과 일반적인 특징만 정리했어요. 가격·열량 등은 매장 정보를 확인해 주세요.';
    case 'user':return '내가 추가한 메뉴예요. 이 브라우저에만 저장돼요.';
    default:return m.attribution?linkify(m.attribution):'위키 데이터';
  }
}
/* ---- 내 주변에서 찾기: 카카오맵/네이버지도/구글지도 검색을 위치와 함께 연다 (app.js 가 UI.openMap 을 채운다) ---- */
const MAP_SERVICES=[['kakao','카카오맵','#fee500'],['naver','네이버지도','#03c75a'],['google','구글지도','#4285f4']];
const RADII=[500,1000,2000,3000,5000];
const radiusLabel=r=>r<1000?r+'m':(r/1000)+'km';
function mapSection(m){
  if(!UI.openMap)return [];
  let radius=(()=>{try{const n=Number(localStorage.getItem('menuai.radius'));return RADII.includes(n)?n:1000}catch{return 1000}})();
  const franchise=m.source==='franchise'&&m.brand;
  const input=el('input',{type:'text',value:franchise?m.brand:m.name,maxLength:40,'aria-label':'지도에서 찾을 검색어'});
  const sel=el('select',{'aria-label':'검색 반경',onchange:()=>{radius=Number(sel.value);try{localStorage.setItem('menuai.radius',String(radius))}catch{}}},
    RADII.map(r=>el('option',{value:String(r),textContent:'반경 '+radiusLabel(r),selected:r===radius})));
  const status=el('p',{className:'map-status',textContent:'내 위치: 아직 확인 전이에요. “내 위치 확인”이나 지도 버튼을 누르면 이 창에서 위치 권한을 물어봐요.'});
  const onStatus=(text,kind)=>{status.textContent=text;status.dataset.kind=kind||''};
  const checkBtn=el('button',{type:'button',className:'btn small',textContent:'내 위치 확인',onclick:()=>{
      if(UI.resetLocation)UI.resetLocation();UI.checkLocation(onStatus)}});
  const btns=MAP_SERVICES.map(([id,label,color])=>el('button',{type:'button',className:'btn map-btn',onclick:()=>{
      const q=input.value.trim();if(!q){toast('찾을 검색어를 입력해 주세요');input.focus();return}
      UI.openMap(id,q,radius,{onStatus})},},
    el('i',{className:'map-dot',style:'background:'+color}),label));
  return [el('h3',{textContent:'내 주변에서 찾기'}),
    el('div',{className:'map-box'},
      el('div',{className:'map-row'},input,sel),
      el('div',{className:'map-row map-loc'},status,checkBtn),
      el('div',{className:'map-row map-btns'},btns),
      el('p',{className:'map-note',textContent:(franchise?'프랜차이즈 메뉴라 브랜드 이름으로 매장을 찾아요. ':'')
        +'위치는 지도 링크에만 쓰고 이 사이트는 저장하거나 보내지 않아요(5분간 이 탭의 메모리에만 기억). '
        +'반경은 지도가 처음 보여 줄 범위를 맞추는 값이라 정확한 거리 제한은 아니고, 카카오맵은 반경을 지정할 수 없어 기본 범위로 열려요. 허용하지 않으면 위치 없이 검색해요.'}))];
}

function openDetail(m,extra={}){
  const {score,reasons=[]}=extra;
  if(!detailDlg){
    detailDlg=el('dialog',{id:'detail-modal',className:'detail-modal'});
    detailDlg.addEventListener('click',e=>{if(e.target===detailDlg)detailDlg.close()}); // 바깥(배경) 클릭으로 닫기
    document.body.append(detailDlg);
  }
  const sec=(title,...kids)=>[el('h3',{textContent:title}),...kids];
  const tags=(arr)=>el('div',{className:'chips'},(arr||[]).map(t=>el('span',{className:'chip tag',textContent:t})));
  const why=reasons.filter(r=>!/^질문과의 의미 유사도/.test(r));           // 유사도는 점수 하나로만 표시
  const sims=(UI.similarProvider?UI.similarProvider(m):[])||[];
  const kids=[
    el('div',{className:'dm-head'},
      el('h2',{className:'dm-title',textContent:m.name}),
      el('button',{type:'button',className:'dm-close',textContent:'×',title:'닫기','aria-label':'닫기',onclick:()=>detailDlg.close()})),
    el('div',{className:'dm-badges'},
      el('span',{className:'badge',textContent:CUISINE_KO[m.cuisine]||m.cuisine}),
      m.brand?el('span',{className:'badge',textContent:m.brand}):'',
      m.cuisineInferred?el('span',{className:'badge',textContent:'종류 추정'}):'',
      m.source==='user'?el('span',{className:'badge user',textContent:'내가 추가'}):'',
      score!=null?el('span',{className:'score',textContent:'점수 '+Number(score).toFixed(2)}):''),
    m.desc?el('p',{className:'dm-desc',textContent:m.desc}):'',
    ...((m.ingredients||[]).length?sec('재료',tags(m.ingredients)):[]),
    ...((m.tags||[]).length?sec('태그',tags(m.tags)):[]),
    ...(why.length?sec('추천 이유',el('ul',{className:'reasons'},why.map(r=>el('li',{textContent:r})))):[]),
    ...(sims.length?sec('비슷한 메뉴',el('div',{className:'chips'},sims.map(s=>
        el('button',{type:'button',className:'chip',textContent:s.menu.name,title:'점수 '+Number(s.score).toFixed(2),onclick:()=>openDetail(s.menu)})))):[]),
    ...mapSection(m),
    ...sec('출처',el('p',{className:'dm-src'},sourceNode(m))),
    ...(m.cuisineInferred?[el('p',{className:'dm-note',textContent:'음식 종류는 비슷한 메뉴들과의 유사도로 추정한 값이에요'+(m.cuisineConfidence?' (신뢰도 '+Math.round(m.cuisineConfidence*100)+'%)':'')+'. 틀렸다면 알려 주세요.'})]:[]),
  ];
  if(UI.isBanned)kids.push(el('div',{className:'dm-actions'},banToggle(m)));
  detailDlg.replaceChildren(el('div',{className:'dm'},...kids));
  if(!detailDlg.open)detailDlg.showModal();
  detailDlg.querySelector('.dm').scrollTop=0;
}

/* ---- 추천 개수 드롭다운(3/5/10) ---- */
const COUNTS=[3,5,10];
let pickCount=(()=>{try{const n=Number(localStorage.getItem('menuai.count'));return COUNTS.includes(n)?n:3}catch{return 3}})();
function initCountSelect(){
  const root=$('#count-dd');if(!root)return;
  root.innerHTML=`<button type="button" class="btn dd-btn" id="count-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="추천 개수">
      <span id="count-val"></span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <ul class="dd-menu" role="listbox" aria-label="추천 개수" tabindex="-1" hidden></ul>`;
  const btn=$('#count-btn',root),menu=$('.dd-menu',root),val=$('#count-val',root);
  let active=COUNTS.indexOf(pickCount);
  const paint=()=>{
    val.textContent=pickCount+'개';
    menu.replaceChildren(...COUNTS.map((n,i)=>el('li',{role:'option',textContent:n+'개씩 추천','aria-selected':String(n===pickCount),
      onclick:()=>choose(n),onmouseenter:()=>{active=i;mark()}})));
    mark();
  };
  const mark=()=>[...menu.children].forEach((li,i)=>{if(i===active)li.setAttribute('data-active','');else li.removeAttribute('data-active')});
  const setOpen=(o)=>{menu.hidden=!o;btn.setAttribute('aria-expanded',String(o));if(o){active=COUNTS.indexOf(pickCount);mark();menu.focus()}};
  const choose=(n)=>{
    setOpen(false);btn.focus();
    if(n===pickCount)return;
    pickCount=n;try{localStorage.setItem('menuai.count',String(n))}catch{}
    paint();emit('menu:count',{n});
  };
  btn.onclick=()=>setOpen(menu.hidden);
  menu.addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'){e.preventDefault();active=(active+1)%COUNTS.length;mark()}
    else if(e.key==='ArrowUp'){e.preventDefault();active=(active-1+COUNTS.length)%COUNTS.length;mark()}
    else if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(COUNTS[active])}
    else if(e.key==='Escape'||e.key==='Tab'){setOpen(false);btn.focus()}
  });
  document.addEventListener('click',e=>{if(!root.contains(e.target))setOpen(false)});
  paint();
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

const UI={CUISINES,CUISINE_KO,$,el,emit,toast,renderResults,setProgress,initAddModal,setMenus,openDetail,setHiddenCount,
  isBanned:null, // isBanned(id) 는 app.js 가 채운다
  pickCount:()=>pickCount,similarProvider:null, // similarProvider(menu) → [{menu,score}] 는 app.js 가 채운다
  get menusReady(){return menusP},openAddModal:(p)=>openModal(p)};
window.MenuUI=UI;
document.addEventListener('DOMContentLoaded',()=>{initAddModal();initCountSelect()});
})();
