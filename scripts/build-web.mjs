#!/usr/bin/env node
// build-web.mjs - 브라우저가 fetch 해야 하는 정적 파일을 web/ 아래로 복사한다.
//   data/dict/*.json -> web/dict/*.json   (B 의 재료·분류 사전. 브라우저의 parseQuery/recommend 가 사용)
// 사용법: node scripts/build-web.mjs
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'data', 'dict');
const DST = join(ROOT, 'web', 'dict');

await mkdir(DST, { recursive: true });
const files = (await readdir(SRC)).filter((f) => f.endsWith('.json'));
for (const f of files) await copyFile(join(SRC, f), join(DST, f));
console.log(`web/dict: ${files.length}개 복사 (${files.join(', ')})`);
