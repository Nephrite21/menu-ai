/* 배경: 음식 SVG 아이콘이 달린 발광 네트워크 구. 순수 canvas, 외부 의존 없음.
   canvas#bg-sphere 가 있는 페이지에서만 동작. data-dim 이면 CSS로 흐리게 표시.
   window.MenuSphere:
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
  dpr=Math.min(window.devicePixelRatio||1,2);W=innerWidth;H=innerHeight;
  cv.width=W*dpr;cv.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
  R=Math.min(W*.5,H*.4);cx=W/2;cy=H/2;if(reduce)draw(performance.now());
}

const ease=p=>p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;      // in-out cubic
const easeIn=p=>p*p*p;

/* 전환 시작. opts.zoom=false 면 회전만. */
function start(opts){
  if(anim)return anim.promise;
  if(reduce||!NAMES.length)return Promise.resolve();
  const zoom=opts.zoom!==false;
  const target=iconPts[Math.floor(Math.random()*iconPts.length)];
  const p=pts[target];
  /* 목표 노드가 정면(화면 중앙)에 오도록 하는 회전각 */
  const rho=Math.hypot(p.x,p.z),ayT=Math.atan2(-p.x,p.z),axT=Math.atan2(p.y,rho);
  tx=ty=0;
  let dY=(((ayT-baseY-extraY)%TAU)+TAU)%TAU;                // [0,2π)
  const dir=Math.random()<.5?1:-1,turns=1+Math.floor(Math.random()*2); // 정수 바퀴여야 목표 각도에 정확히 멈춘다
  dY=dir>0?dY+TAU*turns:dY-TAU+(-TAU*turns);
  const a={zoom,target,startY:extraY,startX:extraX,
    dY,dX:(axT+.28)-extraX,t0:performance.now(),spinDur:zoom?1000:700,zoomDur:720,phase:'spin',
    hi:zoom?makeSprite(NAMES[p.icon],p.c,6):null};
  a.promise=new Promise(res=>{a.done=res});
  anim=a;
  document.body.classList.add(zoom?'diving':'spinning');
  return a.promise;
}
function finish(){
  const a=anim;anim=null;
  document.body.classList.remove('diving','spinning');
  a.done();
}

function draw(t){
  const dt=Math.min(50,t-(last||t));last=t;
  mx+=(tx-mx)*.08;my+=(ty-my)*.08;
  let q=0;                                            // 확대 진행도 0~1
  if(anim){
    const a=anim;
    if(a.phase==='spin'){
      const e=ease(Math.min(1,(t-a.t0)/a.spinDur));
      extraY=a.startY+a.dY*e;extraX=a.startX+a.dX*e;
      if(t-a.t0>=a.spinDur){if(a.zoom){a.phase='zoom';a.t0=t}else finish()}
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
    ctx.globalAlpha=a;ctx.fillStyle=o.p.c;
    ctx.shadowColor=o.p.c;ctx.shadowBlur=10*o.d;
    const sz=Math.max(0,Math.min(Z,6));
    if(!isT||tgt<0){ctx.beginPath();ctx.arc(o.sx,o.sy,(1.2+2.4*o.d)*sz,0,TAU);ctx.fill()}
    ctx.shadowBlur=0;
    if(o.p.icon>=0){
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
window.MenuSphere={dive:()=>start({zoom:true}),spin:()=>start({zoom:false})};
resize();requestAnimationFrame(draw);
})();
