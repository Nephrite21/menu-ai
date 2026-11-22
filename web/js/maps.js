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

/* 위치는 이 모듈의 메모리에만 5분간 둔다(저장소·서버로 보내지 않음). 같은 메뉴에서 다른 지도 버튼을 누를 때 다시 묻지 않게 하려는 용도다. */
const CACHE_MS = 5 * 60 * 1000;
let cached = null; // { lat, lng, accuracy, t }
export function cachedLocation() { return cached && Date.now() - cached.t < CACHE_MS ? { ...cached } : null; }
export function clearLocationCache() { cached = null; }

/** 위치 권한 상태: 'granted' | 'prompt' | 'denied' | 'unknown' (Permissions API 를 못 쓰면 unknown) */
export async function permissionState() {
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { return 'unknown'; }
}

const once = (opts) => new Promise((resolve, reject) => {
  navigator.geolocation.getCurrentPosition(
    (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
    (e) => reject(Object.assign(new Error(e.message), { code: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' })),
    opts,
  );
});

/**
 * 브라우저 위치를 1회 요청한다(권한 안내는 호출한 페이지에 뜬다 → 반드시 사용자가 보고 있는 창에서 호출할 것).
 * 정밀 모드로 먼저 시도하고, 시간 초과·사용 불가면 빠른(네트워크 기반) 모드로 한 번 더 시도한다. 거절이면 바로 실패.
 * 실패 사유: 'denied' | 'unavailable' | 'timeout' | 'unsupported'
 */
export async function getPosition({ timeout = 8000 } = {}) {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
  }
  let pos;
  try { pos = await once({ enableHighAccuracy: true, timeout, maximumAge: CACHE_MS }); }
  catch (e) {
    if (e.code === 'denied') throw e;
    pos = await once({ enableHighAccuracy: false, timeout: Math.min(timeout, 6000), maximumAge: CACHE_MS });
  }
  cached = { ...pos, t: Date.now() };
  return { ...pos };
}

/** 위치 오차 설명. PC 는 GPS 가 없어 Wi-Fi/IP 로 추정하므로 수백 m~수 km 어긋날 수 있다. */
export function accuracyText(loc) {
  if (!loc) return '';
  const a = loc.accuracy;
  if (!Number.isFinite(a)) return '위치를 확인했어요.';
  const km = a >= 1000 ? `${(a / 1000).toFixed(1)}km` : `${Math.round(a)}m`;
  return a > 1500
    ? `위치를 확인했어요 · 오차 약 ${km}. PC는 GPS가 없어 IP/Wi-Fi로 추정해서 많이 어긋날 수 있어요. 검색어에 동네 이름을 붙이면(예: 수영구 치킨) 더 정확해요.`
    : `위치를 확인했어요 · 오차 약 ${km}`;
}

/**
 * 지도 검색 주소를 새 창으로 연다. 클릭(사용자 동작) 직후에 불러야 팝업이 막히지 않는다.
 * 위치를 비동기로 받은 뒤에는 브라우저가 팝업을 막을 수 있어서, 막히면 blocked:true 를 돌려주고 호출한 쪽이 "한 번 더 눌러 주세요"를 안내한다.
 * @returns {{ url: string, blocked: boolean }}
 */
export function openMapNow(service, { query, radiusM = 1000, loc = null } = {}) {
  const url = buildMapUrl(service, { query, radiusM, ...(loc || {}) });
  const w = window.open('', '_blank');
  if (!w) return { url, blocked: true };
  w.opener = null;            // 열린 창이 이 페이지를 조작하지 못하게
  w.location.replace(url);
  return { url, blocked: false };
}
