/* 젤리(탱글탱글) 로딩바. #hero-status 안에 SVG 를 만들고 window.MenuJelly.set(p, label) 로 진행을 받는다.
   - 진행 값은 스프링(출렁임)으로 따라가서 늘어날 때 튕긴다.
   - 바 앞쪽에 방울들이 떠다니고, SVG 구이(goo) 필터로 바와 합쳐졌다 떨어지는 모핑이 생긴다.
   - 실제 진행률은 모델 초기화 구간에서 한참 0% 에 머물므로, 멈춘 것처럼 보이지 않게 천천히 차오르는 보정 값을 함께 쓴다.
     (보정은 최대 92%까지. 100% 는 준비가 끝났을 때만) */
(function(){
const host=document.getElementById('hero-status');
if(!host)return;
const reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
const NS='http://www.w3.org/2000/svg';
const W=320,H=44,X0=14,X1=W-14,CY=22,TH=16;           // viewBox, 바 시작/끝 x, 중심 y, 트랙 두께

host.innerHTML=`
<div class="jelly" role="progressbar" aria-label="검색 모델 준비" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
  <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
    <defs>
      <linearGradient id="jelly-grad" gradientUnits="userSpaceOnUse" x1="${X0}" y1="0" x2="${X1}" y2="0">
        <stop offset="0" stop-color="#ff9a4d"/><stop offset=".55" stop-color="#ff6b9a"/><stop offset="1" stop-color="#8b98ff"/>
      </linearGradient>
      <filter id="jelly-goo" x="-10%" y="-80%" width="120%" height="260%" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="4.2" result="blur"/>
        <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10" result="goo"/>
        <feBlend in="SourceGraphic" in2="goo"/>
      </filter>
    </defs>
    <rect x="${X0}" y="${CY-TH/2}" width="${X1-X0}" height="${TH}" rx="${TH/2}" fill="rgba(255,255,255,.07)" stroke="rgba(160,170,255,.25)"/>
    <g id="jelly-fill" filter="url(#jelly-goo)" fill="url(#jelly-grad)"></g>
  </svg>
  <div class="jelly-label"><span id="jelly-text">검색 모델 준비 중…</span> <b id="jelly-pct">0%</b></div>
</div>`;

const box=host.querySelector('.jelly'),g=host.querySelector('#jelly-fill'),textEl=host.querySelector('#jelly-text'),pctEl=host.querySelector('#jelly-pct');
const mk=(tag,attrs)=>{const e=document.createElementNS(NS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);g.append(e);return e};
const body=mk('rect',{x:X0,y:CY-TH/2+1,width:0,height:TH-2,rx:(TH-2)/2});
const head=mk('ellipse',{cx:X0,cy:CY,rx:8,ry:7});
const BLOBS=Array.from({length:6},(_,i)=>({el:mk('circle',{cx:X0,cy:CY,r:5}),i}));

/* 상태 */
let real=0,done=false,x=0,v=0,t0=performance.now(),last=t0,raf=0,pop=0;
function set(p,label){
  if(typeof p==='number')real=Math.max(real,Math.min(1,p));        // 진행은 뒤로 가지 않는다
  if(real>=1&&!done){done=true;pop=1}
  if(label)textEl.textContent=label.replace(/\s*\d+%/,'');         // 퍼센트는 바가 보여 주는 값 하나만 쓴다(실제 진행률과 보정값이 어긋나 보이지 않게)
}
const targetNow=(t)=>{
  if(done)return 1;
  const fake=.92*(1-Math.exp(-(t-t0)/9000));                        // 약 9초 시정수로 92%까지 천천히
  return Math.min(.96,Math.max(real*.96,fake));
};

function frame(now){
  const dt=Math.min(.05,(now-last)/1000);last=now;
  const tgt=targetNow(now);
  /* 스프링(감쇠비≈0.5: 한두 번 튕기고 가라앉음) — 서브스텝으로 안정적으로 적분 */
  if(reduce){x=tgt;v=0}
  else for(let s=0;s<4;s++){const h=dt/4;v+=((tgt-x)*140-v*11)*h;x+=v*h}
  pop=Math.max(0,pop-dt*2.2);
  const w=(X1-X0)*Math.max(0,Math.min(1.04,x));                    // 오버슈트로 살짝 넘칠 수 있음(탱글)
  const sec=(now-t0)/1000,speed=Math.min(1,Math.abs(v)*2.2);
  /* 몸통 */
  body.setAttribute('width',Math.max(0,w).toFixed(1));
  /* 머리: 빠르게 늘어날 때 가로로 늘고 세로로 납작해지는 스쿼시&스트레치 */
  const hx=X0+w;
  head.setAttribute('cx',hx.toFixed(1));
  head.setAttribute('rx',(8+speed*9+pop*4).toFixed(1));
  head.setAttribute('ry',(7.5-speed*2.4+pop*3).toFixed(1));
  /* 방울: 머리 근처에서 위아래로 출렁이며 떠다닌다 → 필터가 바와 합쳤다 떼었다 함 */
  for(const b of BLOBS){
    const i=b.i,ph=sec*(1.6+i*.23)+i*1.9;
    const off=(i%2?1:-1)*(6+Math.abs(Math.sin(ph*.7))*10);          // 머리 앞/뒤로 떠다니는 거리
    const cx=Math.max(X0,Math.min(X1,hx+off*Math.sin(ph*.5+i)));
    const cy=CY+Math.sin(ph*1.4)*(6+speed*3);
    const r=3.2+2.4*Math.abs(Math.sin(ph*.9+i))+pop*2;
    b.el.setAttribute('cx',cx.toFixed(1));b.el.setAttribute('cy',cy.toFixed(1));b.el.setAttribute('r',r.toFixed(2));
    b.el.style.opacity=w>6?1:0;
  }
  const pct=Math.max(0,Math.min(100,Math.round(x*100)));
  pctEl.textContent=pct+'%';box.setAttribute('aria-valuenow',String(pct));
  box.style.transform=pop>0?`scale(${(1+pop*.07).toFixed(3)})`:'';   // 완료 순간 통 튀는 느낌
  if(document.body.classList.contains('loading')||pop>0||Math.abs(x-tgt)>.001)raf=requestAnimationFrame(frame);
  else raf=0;
}
function start(){if(!raf){last=performance.now();raf=requestAnimationFrame(frame)}}
start();
window.MenuJelly={set(p,label){set(p,label);start()}};
})();
