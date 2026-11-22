/* 목업 모드: 실제 추천 로직 연결 시 페이지에서 이 스크립트 태그만 제거하면 된다. */
(function(){
const UI=window.MenuUI;
const ready=fetch('mock/menus.mock.json').then(r=>r.json()).then(d=>{UI.mockMenus=d;return d});
UI.menusReady=ready;
let last=[],shown=0;
const strip=t=>t.replace(/(^|\s)[+\-!✕]+\S+/g,' ').trim(); // 목업용: 접두어 토큰 제거 (실제 파싱은 B의 parseQuery)
document.addEventListener('menu:search',async e=>{
  const {text,cuisines,weights,exclude}=e.detail,menus=await ready;
  const q=strip(text||'');
  last=menus.filter(m=>(!cuisines.length||cuisines.includes(m.cuisine))
    &&!(m.ingredients||[]).some(i=>exclude.includes(i)||weights[i]===-1)
    &&(!q||q.split(/\s+/).some(w=>[m.name,m.desc,...m.ingredients,...m.tags].join(' ').includes(w))));
  shown=0;pick();
});
document.addEventListener('menu:reroll',pick);
function pick(){
  const slice=last.slice(shown,shown+3);shown=(shown+3)>=last.length?0:shown+3;
  UI.renderResults(slice.map(menu=>({menu,score:0,reasons:['(목업) 텍스트 포함 매칭']})));
}
document.addEventListener('menu:add',async e=>{
  const ms=await ready;ms.push({id:'user-'+Date.now(),...e.detail,tags:[],source:'user'});UI.mockChanged&&UI.mockChanged();
});
})();
