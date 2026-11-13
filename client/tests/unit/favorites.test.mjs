import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { readFavorites, rememberFavorite } from '../../src/core/favorites.js';

/**
 * 「常用应用」记忆。
 *
 * 为什么值得测：它存在磁盘上（跨进程），而写它的动作发生在**注册应用**那条路上
 * —— 也就是说，一次普通的「加应用」会顺手改磁盘上的常用列表。
 * 万一它把别的东西擦了，用户丢的是白名单与登录凭据，而症状是「重启后配置没了」。
 */
describe('常用应用（favorites）', () => {
  let dir = '';
  let prevHome = '';

  beforeEach(() => {
    prevHome = process.env.MN_WS_HOME || '';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnws-fav-'));
    process.env.MN_WS_HOME = dir;
  });

  after(() => {
    if (prevHome) process.env.MN_WS_HOME = prevHome;
    else delete process.env.MN_WS_HOME;
  });

  const configFile = () => path.join(dir, 'config.json');
  const readRaw = () => {
    const f = configFile();
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  };

  it('记一次就有一��，读回来字段齐全', () => {
    rememberFavorite({ name: 'my-api', base: 'http://127.0.0.1:9999', title: '我的测试服务' });
    const list = readFavorites();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'my-api');
    assert.equal(list[0].base, 'http://127.0.0.1:9999');
    assert.equal(list[0].title, '我的测试服务');
    assert.ok(list[0].usedAt > 0, '要记下使用时间，否则没法排序');
  });

  it('同名覆盖而不是多出一条：同一个路由标识换了端口就该更新', () => {
    rememberFavorite({ name: 'my-api', base: 'http://127.0.0.1:9999' });
    rememberFavorite({ name: 'my-api', base: 'http://127.0.0.1:8888' });
    const list = readFavorites();
    assert.equal(list.length, 1, '同名不该出现两条 —— 用户点哪个全靠猜');
    assert.equal(list[0].base, 'http://127.0.0.1:8888');
  });

  it('最近用过的排前面', () => {
    rememberFavorite({ name: 'a-one', base: 'http://127.0.0.1:1' });
    rememberFavorite({ name: 'b-two', base: 'http://127.0.0.1:2' });
    const list = readFavorites();
    assert.equal(list[0].name, 'b-two', '最后记的那个应该在最前面');
  });

  it('不碰别的配置项：白名单与凭据原样留着', () => {
    // 预置一份带白名单与登录凭据的配置
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ apps: ['nx-kv'], customApps: [{ name: 'nx-kv', base: 'http://127.0.0.1:7877' }], token: 'keep-me' }),
      'utf8',
    );

    rememberFavorite({ name: 'my-api', base: 'http://127.0.0.1:9999' });

    const raw = readRaw();
    assert.deepEqual(raw.apps, ['nx-kv'], '白名单不能被常用列表的写入影响');
    assert.equal(raw.token, 'keep-me', '登录凭据不能被影响');
    assert.equal(raw.customApps.length, 1, '已登记应用不能被影响');
    assert.equal(raw.favorites.length, 1);
  });

  it('坏条目被丢弃而不是让整个面板崩', () => {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ favorites: [null, 'x', { name: 'ok', base: 'http://127.0.0.1:1' }, { name: 'no-base' }] }),
      'utf8',
    );
    const list = readFavorites();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'ok');
  });

  it('名字或基址为空就不记', () => {
    rememberFavorite({ name: '', base: 'http://127.0.0.1:1' });
    rememberFavorite({ name: 'x', base: '' });
    assert.equal(readFavorites().length, 0);
  });
});
