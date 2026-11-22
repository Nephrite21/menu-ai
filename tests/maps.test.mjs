import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMapUrl, toWebMercator, zoomForRadius, RADII, SERVICES } from '../web/js/maps.js';

const SEOUL = { lat: 37.5665, lng: 126.978 };

test('웹 메르카토르 변환: 역변환하면 원래 좌표', () => {
  const { x, y } = toWebMercator(SEOUL.lat, SEOUL.lng);
  const R = 6378137;
  const lng = (x / R) * 180 / Math.PI;
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
  assert.ok(Math.abs(lat - SEOUL.lat) < 1e-9);
  assert.ok(Math.abs(lng - SEOUL.lng) < 1e-9);
  assert.ok(x > 1.4e7 && x < 1.42e7, `x=${x}`);       // 서울은 대략 14,135,000
  assert.ok(y > 4.4e6 && y < 4.6e6, `y=${y}`);        // 서울은 대략 4,518,000
});

test('줌: 반경이 클수록 작아지고 범위 안에 있다', () => {
  const zs = RADII.map((r) => zoomForRadius(SEOUL.lat, r));
  for (let i = 1; i < zs.length; i++) assert.ok(zs[i] <= zs[i - 1], zs.join(','));
  assert.ok(zs.every((z) => z >= 10 && z <= 19));
  assert.ok(zs[0] > zs[zs.length - 1]);
});

test('구글: 위치가 있으면 @위도,경도,줌z 형식', () => {
  const u = buildMapUrl('google', { query: '치킨', ...SEOUL, radiusM: 1000 });
  assert.match(u, /^https:\/\/www\.google\.com\/maps\/search\/%EC%B9%98%ED%82%A8\/@37\.566500,126\.978000,\d+z\?hl=ko$/);
});

test('구글: 위치가 없으면 문서화된 api=1 검색 주소', () => {
  assert.equal(buildMapUrl('google', { query: '치킨' }), 'https://www.google.com/maps/search/?api=1&query=%EC%B9%98%ED%82%A8');
});

test('카카오: 위치가 있으면 m.map.kakao.com/scheme/search 에 p=위도,경도', () => {
  const u = buildMapUrl('kakao', { query: '맘스터치', ...SEOUL });
  assert.equal(u, 'https://m.map.kakao.com/scheme/search?q=%EB%A7%98%EC%8A%A4%ED%84%B0%EC%B9%98&p=37.566500%2C126.978000');
  assert.equal(buildMapUrl('kakao', { query: 'a b' }), 'https://map.kakao.com/?q=a%20b');
});

test('네이버: 위치가 있으면 c=x,y,줌,0,0,0,dh (웹 메르카토르 미터), 없으면 키워드만', () => {
  const u = buildMapUrl('naver', { query: '치킨', ...SEOUL, radiusM: 2000 });
  const m = u.match(/^https:\/\/map\.naver\.com\/p\/search\/%EC%B9%98%ED%82%A8\?c=([\d.]+),([\d.]+),(\d+),0,0,0,dh$/);
  assert.ok(m, u);
  assert.ok(Number(m[1]) > 1.4e7 && Number(m[2]) > 4.4e6);
  assert.equal(buildMapUrl('naver', { query: '치킨' }), 'https://map.naver.com/p/search/%EC%B9%98%ED%82%A8');
});

test('검색어는 URL 인코딩되고(특수문자 포함) 비어 있으면 거절', () => {
  const u = buildMapUrl('google', { query: 'a&b=c/d?e#f', ...SEOUL });
  assert.ok(!/[&?#]b=c|\/d\?e/.test(u.split('@')[0].replace('/maps/search/', '')), u);
  assert.throws(() => buildMapUrl('kakao', { query: '   ' }));
  assert.throws(() => buildMapUrl('bing', { query: 'x' }));
});

test('잘못된 좌표는 위치 없는 주소로 처리', () => {
  assert.equal(buildMapUrl('kakao', { query: 'x', lat: 999, lng: 10 }), 'https://map.kakao.com/?q=x');
  assert.equal(buildMapUrl('kakao', { query: 'x', lat: NaN, lng: 10 }), 'https://map.kakao.com/?q=x');
});

test('서비스 목록', () => {
  assert.deepEqual(Object.keys(SERVICES), ['kakao', 'naver', 'google']);
});
