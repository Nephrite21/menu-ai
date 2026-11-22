/* 배경: 음식 SVG 아이콘이 달린 발광 네트워크 구. 순수 canvas, 외부 의존 없음.
   canvas#bg-sphere 가 있는 페이지에서만 동작. data-dim 이면 CSS로 흐리게 표시.
   window.MenuSphere:
     settle() 결과 준비됨(감속 시작) / fail(reason) 실패 알림 → 확대 없이 정지 + 'menu:search-failed' 이벤트, 프로미스는 'failed'로 끝남
     timeoutMs  결과가 이 시간(기본 15000ms) 안에 안 오면 자동으로 fail('timeout')
     dive()  → Promise. 구가 무작위로 회전 → 아이콘 하나가 정면에 와서 → 화면 전체로 확대(화면 전환). body.diving 토글.
     spin()  → Promise. 회전만(다른 거 추천용). body.spinning 토글. */
(function(){
const cv=document.getElementById('bg-sphere');if(!cv)return;
const ctx=cv.getContext('2d');
const ICONS=window.MenuIcons||{};
const NAMES=Object.keys(ICONS).filter(n=>!['bean','wheat'].includes(n)); // 음식으로 안 보이는 것 제외
const GLOW=['#ff9a4d','#8b98ff','#5ee38b','#ff6b9a','#ffd166'];
const N=88,reduce=matchMedia('(prefers-reduced-motion:reduce)').matches,TAU=Math.PI*2;
let W,H,dpr,R,cx,cy,mx=0,my=0,tx=0,ty=0,baseY=0,extraY=0,extraX=0,last=0,anim=null;

/* 피보나치 구 위의 점 */
const pts=[];
for(let i=0;i<N;i++){
  const y=1-2*(i+.5)/N,r=Math.sqrt(1-y*y),th=i*2.399963;
  const icon=i%2===0&&NAMES.length?(i/2)%NAMES.length:-1;
  pts.push({x:Math.cos(th)*r,y,z:Math.sin(th)*r,icon,c:GLOW[(icon<0?i:icon)%GLOW.length]});
}
pts.forEach((p,i)=>{p.ci=GLOW.indexOf(p.c)});
/* 글로우 점 스프라이트: 색별로 한 번만 그린다 */
const dots=GLOW.map(c=>{const s=document.createElement('canvas');s.width=s.height=32;const g=s.getContext('2d');
  const r=g.createRadialGradient(16,16,0,16,16,16);r.addColorStop(0,'#fff');r.addColorStop(.18,c);r.addColorStop(.5,c+'55');r.addColorStop(1,c+'00');
  g.fillStyle=r;g.fillRect(0,0,32,32);return s});
const iconPts=pts.map((p,i)=>i).filter(i=>pts[i].icon>=0);
/* 가까운 3점끼리 연결 + 일부 삼각 면 */
const edges=[],seen=new Set(),tris=[],triSeen=new Set(),nb=[];
pts.forEach((p,i)=>{
  nb[i]=pts.map((q,j)=>({j,d:(p.x-q.x)**2+(p.y-q.y)**2+(p.z-q.z)**2})).filter(o=>o.j!==i)
    .sort((a,b)=>a.d-b.d).slice(0,4).map(o=>o.j);
  nb[i].slice(0,3).forEach(j=>{const k=i<j?i+'-'+j:j+'-'+i;if(!seen.has(k)){seen.add(k);edges.push([i,j])}});
});
pts.forEach((_,i)=>{const a=nb[i][0],b=nb[i][1];
  if(nb[a].includes(b)||nb[b].includes(a)){const k=[i,a,b].sort((x,y)=>x-y).join('-');
    if(!triSeen.has(k)){triSeen.add(k);if(tris.length*3<triSeen.size)tris.push([i,a,b])}}});

/* SVG 선 아이콘 → 네온 색 + 글로우 스프라이트. scale=1(평상시 96px), 6(확대용 576px) */
function makeSprite(name,col,scale,onDone){
  const s=document.createElement('canvas');s.width=s.height=96*scale;const c=s.getContext('2d');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${56*scale}" height="${56*scale}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  const img=new Image();
  img.onload=()=>{c.shadowColor=col;c.shadowBlur=14*scale;c.drawImage(img,20*scale,20*scale);c.drawImage(img,20*scale,20*scale);s.ready=true;onDone&&onDone()};
  img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  return s;
}
const sprites=NAMES.map((n,k)=>makeSprite(n,GLOW[k%GLOW.length],1,()=>{if(reduce)draw(performance.now())}));

function resize(){
  dpr=Math.min(window.devicePixelRatio||1,1.5);W=innerWidth;H=innerHeight;
  cv.width=W*dpr;cv.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
  R=Math.min(W*.5,H*.4);cx=W/2;cy=H/2;if(reduce)draw(performance.now());
}

const ease=p=>p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;      // in-out cubic
const easeIn=p=>p*p*p;

/* 전환 흐름: spin(가속 후 계속 회전) → [최소 시간 경과 && settle() 호출됨] → decel(부드럽게 감속, 아이콘 하나가 정면에 정지) → zoom(확대)
   opts.zoom=false 면 확대 없이 감속 정지까지만. */
const WMAX=0.0055;                                    // 최대 회전 속도(rad/ms, 약 초당 0.5바퀴)
const wrap=d=>((d+Math.PI)%TAU+TAU)%TAU-Math.PI;     // (-π, π]
const smooth=p=>p*p*(3-2*p);
function start(opts){
  if(anim)return anim.promise;
  if(reduce||!NAMES.length)return Promise.resolve();
  const zoom=opts.zoom!==false;
  tx=ty=0;
  const a={zoom,phase:'spin',t0:performance.now(),minSpin:zoom?1000:600,ready:false,
    dir:Math.random()<.5?1:-1,x0:extraX,D:1100,zoomDur:760,target:-1,hi:null};
  a.promise=new Promise(res=>{a.done=res});
  a.failsafe=setTimeout(()=>fail('timeout',a),api.timeoutMs); // 결과가 영영 안 오면 포기하고 멈춘다
  anim=a;
  document.body.classList.add(zoom?'diving':'spinning');
  return a.promise;
}
/* 결과가 준비됐음을 알린다. 최소 회전 시간이 지났으면 곧바로 감속을 시작한다. */
function settle(){if(anim)anim.ready=true}
/* 실패(타임아웃·오류): 확대하지 않고 감속해서 멈추고, 'menu:search-failed' 이벤트를 발행한다. 이미 결과가 준비됐으면 무시. */
function fail(reason,a){
  a=a||anim;if(!a||a!==anim||a.ready||a.failed)return;
  a.failed=true;a.ready=true;
  document.dispatchEvent(new CustomEvent('menu:search-failed',{detail:{reason:reason||'error'}}));
}
function beginDecel(a,t){
  a.phase='decel';a.t1=t;a.v0=WMAX;a.yd0=extraY;a.xd0=extraX;a.delta=0;a.xT=extraX;
  if(a.failed)a.zoom=false;                           // 실패하면 확대 없이 제자리에 정지
  if(!a.zoom)return;
  /* 감속이 끝났을 때의 각도 근처에서 정면에 가장 가까운 아이콘을 목표로 고른다(조금만 보정하면 정중앙에 멈춘다) */
  const yF=baseY+extraY+a.dir*a.v0*a.D/2;
  let best=-1,bd=9;
  for(const i of iconPts){const p=pts[i],d=wrap(Math.atan2(-p.x,p.z)-yF);
    if(Math.abs(d)<bd){bd=Math.abs(d);best=i;a.delta=d}}
  const p=pts[best];
  a.target=best;a.xT=Math.atan2(p.y,Math.hypot(p.x,p.z))+.28;
  a.hi=makeSprite(NAMES[p.icon],p.c,6);               // 확대용 고해상도(감속 시간 동안 로드)
}
function finish(){
  const a=anim;anim=null;clearTimeout(a.failsafe);
  document.body.classList.remove('diving','spinning');
  a.done(a.failed?'failed':'ok');
}

function draw(t){
  const dt=Math.min(50,t-(last||t));last=t;
  mx+=(tx-mx)*.08;my+=(ty-my)*.08;
  let q=0;                                            // 확대 진행도 0~1
  if(anim){
    const a=anim;
    if(a.phase==='spin'){
      const el=t-a.t0,r=Math.min(1,el/400);
      extraY+=a.dir*WMAX*ease(r)*dt;                  // 400ms 동안 가속, 이후 등속
      if(a.zoom)extraX=a.x0+.28*Math.sin(el*.0035)*r; // 위아래로 살짝 흔들리며 도는 느낌
      if(el>=a.minSpin&&a.ready)beginDecel(a,t);
    }else if(a.phase==='decel'){
      const p=Math.min(1,(t-a.t1)/a.D);
      extraY=a.yd0+a.dir*a.v0*a.D*(p-p*p/2)+a.delta*smooth(p); // 속도가 선형으로 0까지 줄어드는 감속(+정면 보정)
      if(a.zoom)extraX=a.xd0+(a.xT-a.xd0)*smooth(p);
      if(p>=1){if(a.zoom){a.phase='zoom';a.t0=t}else finish()}
    }
    if(anim&&anim.phase==='zoom')q=Math.min(1,(t-anim.t0)/anim.zoomDur);
  }else if(!reduce)baseY+=dt*0.00011;                 // 전환 중에는 자동 회전 정지
  const ay=baseY+extraY+mx*.5,ax=-.28+extraX+my*.3;
  const cyc=Math.cos(ay),sy=Math.sin(ay),cxc=Math.cos(ax),sx=Math.sin(ax);
  ctx.clearRect(0,0,W,H);
  let P=pts.map(p=>{
    const x1=p.x*cyc+p.z*sy,z1=-p.x*sy+p.z*cyc;
    const y2=p.y*cxc-z1*sx,z2=p.y*sx+z1*cxc;
    const k=2.8/(2.8-z2*.8);
    return{sx:cx+x1*R*k,sy:cy+y2*R*k,d:(z2+1)/2,k,p};
  });
  /* 확대: 목표 아이콘이 화면 중앙으로 오면서 Z배로 커진다 */
  let Z=1,tgt=-1,fade=1;
  if(anim&&anim.phase==='zoom'){
    tgt=anim.target;
    const qe=easeIn(q),big=Math.max(W,H)*1.5/46;
    Z=Math.exp(Math.log(big)*qe);
    const n=P[tgt],o=ease(q);
    P=P.map(o2=>({...o2,sx:(o2.sx-n.sx)*Z+n.sx+(cx-n.sx)*o,sy:(o2.sy-n.sy)*Z+n.sy+(cy-n.sy)*o}));
    fade=1-Math.min(1,q*1.15);                        // 나머지는 점점 사라짐
  }
  ctx.globalCompositeOperation='lighter';
  const lineA=tgt>=0?fade:1;
  /* 면 */
  ctx.fillStyle='rgba(150,165,255,.07)';ctx.globalAlpha=lineA;
  for(const [a,b,c] of tris){const A=P[a],B=P[b],C=P[c];if((A.d+B.d+C.d)/3<.35)continue;
    ctx.beginPath();ctx.moveTo(A.sx,A.sy);ctx.lineTo(B.sx,B.sy);ctx.lineTo(C.sx,C.sy);ctx.fill()}
  /* 선 */
  ctx.lineWidth=Math.min(1+q*2,3);
  for(const [a,b] of edges){const A=P[a],B=P[b],d=(A.d+B.d)/2;
    ctx.strokeStyle=`rgba(160,175,255,${(.05+.38*d*d)*lineA})`;
    ctx.beginPath();ctx.moveTo(A.sx,A.sy);ctx.lineTo(B.sx,B.sy);ctx.stroke()}
  /* 노드·아이콘: 먼 것부터 */
  for(const o of P.slice().sort((a,b)=>a.d-b.d)){
    const isT=o.p===pts[tgt];
    const a=(.25+.75*o.d)*(isT?1:(tgt>=0?fade:1));
    ctx.globalAlpha=a;
    const sz=Math.max(0,Math.min(Z,6));
    if(!isT||tgt<0){const ds=(5+9*o.d)*sz;ctx.drawImage(dots[o.p.ci],o.sx-ds/2,o.sy-ds/2,ds,ds)} // 미리 그려 둔 글로우 점(shadowBlur 대신)
    /* 뒤쪽(d 낮음)은 색 점만, 앞쪽으로 올수록 아이콘이 서서히 나타난다 */
    if(o.p.icon>=0&&(isT||o.d>.45)){
      if(!isT)ctx.globalAlpha=a*Math.min(1,(o.d-.45)/.15);
      let spr=sprites[o.p.icon];const s=(16+30*o.d)*o.k*Z;
      if(isT&&anim.hi&&anim.hi.ready)spr=anim.hi;
      if(isT)ctx.globalAlpha=1-Math.max(0,(q-.8)/.2);  // 마지막 구간에서 아이콘도 사라지며 화면이 비워진다
      if(spr.ready!==false&&s<W*6)ctx.drawImage(spr,o.sx-s/2,o.sy-s/2,s,s);
    }
  }
  /* 확대 중 번지는 빛 */
  if(tgt>=0){
    const c=pts[tgt].c,g=ctx.createRadialGradient(cx,cy,0,cx,cy,Math.max(W,H)*.7);
    const ga=.32*Math.sin(Math.PI*Math.min(1,q*1.05));
    ctx.globalAlpha=1;g.addColorStop(0,c+Math.round(ga*255).toString(16).padStart(2,'0'));g.addColorStop(1,c+'00');
    ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
  }
  ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
  if(anim&&anim.phase==='zoom'&&q>=1)finish();
  if(!reduce||anim)requestAnimationFrame(draw);
}
addEventListener('resize',resize);
addEventListener('pointermove',e=>{if(anim)return;tx=(e.clientX/innerWidth-.5)*2;ty=(e.clientY/innerHeight-.5)*2},{passive:true});
const api={dive:()=>start({zoom:true}),spin:()=>start({zoom:false}),settle,fail:r=>fail(r||'error'),timeoutMs:15000};
window.MenuSphere=api;
resize();requestAnimationFrame(draw);
})();
