// 합성 전용 작업 프로세스: 웹 서버를 COMPOSE_WORKER=external로 띄우면 여기서 회차·예고편 합성을 처리합니다.
// 실행: npm run worker (웹 서버와 같은 DATABASE_URL · UPLOAD_DIR을 써야 합니다)
import path from 'node:path';
import { openDb, migrate } from './db.mjs';
import { createRenderWorker } from './ai/render-worker.mjs';

const db = await openDb();
await migrate(db);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
const worker = createRenderWorker({ db, uploadDir });
await worker.recover();
worker.start();
console.log('숏핑 합성 작업 프로세스를 시작했어요. 동시 합성 수:', process.env.COMPOSE_CONCURRENCY || 1);
const stop = () => {
  worker.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
