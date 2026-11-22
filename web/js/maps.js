/* 지도 서비스에서 "내 주변" 검색을 여는 도우미. API 키 없이 각 서비스의 공개 검색 주소(URL)만 쓴다.
   사용자가 지도 앱 검색창에 직접 입력하는 것과 같은 동작이다.

   검증 수준(2026-11 실측, docs/tech-notes.md 참고):
   - google: 확인됨. `/maps/search/<검색어>/@위도,경도,줌z` 는 지정한 중심으로 열린다(문서화되지 않은 형식).
             문서화된 `?api=1&query=` 형식은 위치를 지정할 수 없어(서울로 열림) 위치가 없을 때만 쓴다.
   - kakao : 확인됨. `m.map.kakao.com/scheme/search?q=&p=위도,경도` 가 좌표를 변환해 map.kakao.com 으로 넘겨 준다. 반경 지정은 불가.
   - naver : 미확인. 웹 주소의 좌표 형식을 문서로 확인하지 못했고(자동 접근이 차단됨) `c=x,y,줌,0,0,0,dh`(웹 메르카토르 미터)로 추정했다.
             틀려도 키워드 검색 자체는 열린다(위치만 기본값).
   반경은 정확한 거리 필터가 아니라 "처음 보여 줄 지도 범위(줌)"를 맞추는 값이다. */

export const SERVICES = Object.freeze({
  kakao: { label: '카카오맵' },
  naver: { label: '네이버지도' },
  google: { label: '구글지도' },
});
export const RADII = Object.freeze([500, 1000, 2000, 3000, 5000]); // m

const R = 6378137; // 웹 메르카토르 지구 반지름(m)

/** WGS84 위경도 → 웹 메르카토르(EPSG:3857) 미터 */
export function toWebMercator(lat, lng) {
  return {
    x: (lng * Math.PI / 180) * R,
    y: Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R,
  };
}

/** 반경(m)이 화면(약 viewPx 픽셀 폭)에 들어오도록 하는 웹 지도 줌 레벨(내림 → 반경이 확실히 포함됨) */
export function zoomForRadius(lat, radiusM, viewPx = 800) {
  const z = Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) * viewPx / (2 * radiusM));
  return Math.max(10, Math.min(19, Math.floor(z)));
}

const hasLoc = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/**
 * @param {'kakao'|'naver'|'google'} service
 * @param {{ query: string, lat?: number, lng?: number, radiusM?: number }} p  위치가 없으면 위치 없는 검색 주소를 만든다
 */
export function buildMapUrl(service, { query, lat, lng, radiusM = 1000 } = {}) {
  const q = encodeURIComponent(String(query ?? '').trim());
  if (!q) throw new Error('검색어가 비어 있어요');
  const loc = hasLoc(lat, lng);
  const la = loc ? lat.toFixed(6) : '', ln = loc ? lng.toFixed(6) : '';
  switch (service) {
    case 'google':
      return loc
        ? `https://www.google.com/maps/search/${q}/@${la},${ln},${zoomForRadius(lat, radiusM)}z?hl=ko`
        : `https://www.google.com/maps/search/?api=1&query=${q}`;
    case 'kakao':
      return loc
        ? `https://m.map.kakao.com/scheme/search?q=${q}&p=${la}%2C${ln}`
        : `https://map.kakao.com/?q=${q}`;
    case 'naver': {
      if (!loc) return `https://map.naver.com/p/search/${q}`;
      const { x, y } = toWebMercator(lat, lng);
      return `https://map.naver.com/p/search/${q}?c=${x.toFixed(1)},${y.toFixed(1)},${zoomForRadius(lat, radiusM)},0,0,0,dh`;
    }
    default:
      throw new Error(`알 수 없는 지도 서비스: ${service}`);
  }
}

/** 브라우저 위치 1회 요청. 실패 사유: 'denied' | 'unavailable' | 'timeout' | 'unsupported' */
export function getPosition({ timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return reject(Object.assign(new Error('unsupported'), { code: 'unsupported' }));
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(Object.assign(new Error(e.message), { code: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' })),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    );
  });
}

/**
 * 클릭 직후 호출한다. 팝업 차단을 피하려고 새 창을 먼저 열고, 위치를 받은 뒤 그 창을 지도 주소로 보낸다.
 * 위치는 이 함수 안에서 주소 문자열에만 쓰이고 저장·전송되지 않는다.
 * @returns {Promise<{ url: string, located: boolean, reason?: string, blocked?: boolean }>}
 */
export async function openMapSearch(service, { query, radiusM = 1000, timeout } = {}) {
  const w = window.open('', '_blank');
  if (w) {
    try {
      w.opener = null;
      w.document.title = '위치 확인 중…';
      w.document.body.style.cssText = 'margin:0;height:100vh;display:grid;place-items:center;background:#0b0c1a;color:#dfe3ff;font:16px system-ui,sans-serif';
      w.document.body.textContent = '내 위치를 확인하고 있어요…';
    } catch { /* 안내 문구는 없어도 된다 */ }
  }
  let loc = null, reason;
  try { loc = await getPosition({ timeout }); } catch (e) { reason = e.code || 'unavailable'; }
  const url = buildMapUrl(service, { query, radiusM, ...(loc || {}) });
  if (!w) return { url, located: !!loc, reason, blocked: true };
  w.location.replace(url);
  return { url, located: !!loc, reason };
}
