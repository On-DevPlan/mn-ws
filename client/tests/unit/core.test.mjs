// 单元测试：home 业务逻辑 + 存储事务 + 路径常量。
// 经 tsx 直接跑 src 源码；每个用例用独立存储，不写脏用户目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 给当前用例一个全新的存储路径
function withStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mn-ws-unit-'));
  process.env.MN_WS_STORE = join(dir, 'store.json');
}

test('greet: 计数递增，loud 时整句大写', async () => {
  withStore();
  const { greet } = await import('../../src/modules/home/service.ts');
  const a = await greet('甲');
  assert.equal(a.count, 1);
  assert.match(a.greeting, /甲/);
  const b = await greet('乙', true);
  assert.equal(b.count, 2);
  assert.equal(b.greeting, b.greeting.toUpperCase());
});

test('store: 读-改-写事务把字段持久化', async () => {
  withStore();
  const store = await import('../../src/core/store.ts');
  await store.mutateStore((s) => {
    s.foo = 'bar';
  });
  const s = await store.loadStore();
  assert.equal(s.foo, 'bar');
});

test('store: 事务函数抛错则不落盘', async () => {
  withStore();
  const store = await import('../../src/core/store.ts');
  await assert.rejects(
    store.mutateStore((s) => {
      s.baz = 1;
      throw new Error('boom');
    }),
  );
  const s = await store.loadStore();
  assert.equal(s.baz, undefined);
});

test('paths: 常量已由模板渲染成形', async () => {
  const paths = await import('../../src/core/paths.ts');
  assert.equal(paths.APP_NAME, 'mn-ws');
  assert.ok(paths.DEFAULT_PORT > 0);
  assert.match(paths.STORE_ENV, /_STORE$/);
});
