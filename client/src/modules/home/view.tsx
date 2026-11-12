// 首页视图：面板落地页，把「演示动作 + 运行信息 + 本机设置」放在同一页。
//
// 所有请求走类型安全 client：action id、参数名、flag 值类型、返回数据
// 全部由注册表类型推出，写错在编译期就红。
//
// 页面分两部分：上半是演示动作（问候）与运行信息，
// 下半是本机设置（外观主题、栏目管理）。主题点击即保存；栏目管理一页一保存。
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.js';
import { Copyable, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { ThemePicker } from '../../web/frontend/components/theme.jsx';
import { useStore } from '../../web/frontend/store.js';
import * as nav from '../../web/frontend/components/navModel.js';
import type { NavConfig } from '../../web/frontend/components/navModel.js';
import NavManager from './navManager.js';
import type { GreetingResult } from './service.js';

// 面板里也把 CLI 等价写法亮出来（agent 与人都能照着敲）
const NAV_CLI_HINT = `mn-ws setting set --set 'navGroups=[{"title":"求职","views":["home"]}]'`
  + ` / --set navHidden=home / --set navOrder=["home"]`;

export default function HomeView() {
  const { boot, client, settings, refreshSettings } = useStore();
  const toast = useToast();
  const guard = useGuard();

  // 问候（演示动作）
  const [name, setName] = useState('');
  const [loud, setLoud] = useState(false);
  const [result, setResult] = useState<GreetingResult | null>(null);
  const [busy, setBusy] = useState(false);

  // 栏目管理工作副本（编辑都在副本上，放弃即丢弃）
  const [cfg, setCfg] = useState<NavConfig>(nav.emptyConfig());
  const [baseline, setBaseline] = useState<NavConfig>(nav.emptyConfig());

  const sections = useMemo(
    () => (settings?.views || []).map((v) => ({ id: v.id, title: v.title })),
    [settings],
  );
  const allIds = useMemo(() => sections.map((s) => s.id), [sections]);

  // 后端配置 → 工作副本
  useEffect(() => {
    if (!settings) return;
    const next = nav.configFromSettings(settings.settings);
    setCfg(next);
    setBaseline(next);
  }, [settings]);

  const problems = useMemo(() => nav.validate(cfg, allIds), [cfg, allIds]);
  const dirty = nav.isDirty(cfg, baseline);

  async function send() {
    if (!name.trim()) {
      toast('请先填写名字');
      return;
    }
    setBusy(true);
    try {
      const r = await client['home.greet']({ name: name.trim(), loud });
      setResult(r);
    } catch (err) {
      toast(String((err as { message?: string })?.message || err));
    } finally {
      setBusy(false);
    }
  }

  // useGuard 是「跑一次并兜错」（不是包装器）：直接调用它，失败的 toast 由它统一发
  const save = () => guard(async () => {
    if (problems.length) { toast(`保存失败：${problems[0]!.message}`); return; }
    await api('/api/settings', { method: 'PATCH', body: { set: nav.configToPayload(cfg) } });
    await refreshSettings();
    toast('设置已保存');
  });

  const discard = () => setCfg(structuredClone(baseline));

  return (
    <div className="stack" style={{ padding: 16 }}>
      {/* ① 演示动作 + 运行信息 */}
      <div className="card">
        <div className="colhead">问候（演示动作）</div>
        <div style={{ padding: 14 }}>
          <div className="toolbar">
            <input
              value={name}
              placeholder="你的名字"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void send();
              }}
            />
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={loud} onChange={(e) => setLoud(e.target.checked)} />
              大声
            </label>
            <button className="btn" disabled={busy} onClick={() => void send()}>
              {busy ? '问候中…' : '打招呼'}
            </button>
          </div>
          {result && (
            <div style={{ marginTop: 12 }}>
              <strong>{result.greeting}</strong>
              <div className="muted" style={{ marginTop: 4 }}>
                第 {result.count} 次 · {result.at}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="colhead">运行信息</div>
        <dl className="kv">
          <div className="kv-row">
            <dt>应用</dt>
            <dd>{boot ? `${boot.app.name} v${boot.app.version}` : '加载中…'}</dd>
          </div>
          <div className="kv-row">
            <dt>存储</dt>
            <dd>
              <Copyable text={boot?.storePath || ''}>{boot?.storePath || '…'}</Copyable>
            </dd>
          </div>
          <div className="kv-row">
            <dt>环境变量</dt>
            <dd>{boot?.storeEnv}</dd>
          </div>
        </dl>
      </div>

      {/* ② 本机设置：外观 */}
      <div className="card">
        <div className="colhead">
          外观
          <span className="right muted">色彩主题 · 点击即保存</span>
        </div>
        <div style={{ padding: 12 }} className="stack">
          <div className="toolbar">
            <ThemePicker />
            <span className="muted">
              浅色 / 深色 / 跟随系统（深色下自动切换为暗色 token）；CLI 等价：
              <code>{'mn-ws setting set --key theme --value dark'}</code>
            </span>
          </div>
        </div>
      </div>

      {/* ② 本机设置：栏目管理 */}
      <div className="card">
        <div className="colhead">
          栏目管理
          <span className="right muted">
            头部显示 {allIds.length - cfg.hidden.length} 个 · 隐藏 {cfg.hidden.length} 个
            {cfg.groups.length ? ` · ${cfg.groups.length} 个分组` : ''}
          </span>
        </div>
        <div style={{ padding: 12 }} className="stack">
          <div className="toolbar">
            <span className="muted">
              拖动就是把结构摆成你要的样子：页面可以拖进分组、组内换位、拖回平铺区即移出；拖分组把手换分组顺序。
              被隐藏的页面只是头部不显示入口，用 <code>#/页面id</code> 直达仍然可用。
            </span>
            <span className="right rowgap">
              {dirty ? (
                <>
                  <span className="tag">有未保存的改动</span>
                  <button className="btn small" onClick={() => { void save(); }}>保存</button>
                  <button className="btn small ghost" onClick={discard}>放弃改动</button>
                </>
              ) : <span className="muted">已保存</span>}
            </span>
          </div>
          <NavManager sections={sections} value={cfg} onChange={setCfg} />
          {problems.map((p) => <div key={p.field} className="bad">· {p.message}</div>)}
        </div>
      </div>

      <div className="muted" style={{ padding: '0 2px' }}>
        CLI 等价：<code>{NAV_CLI_HINT}</code>
      </div>

      <CliHints module="home" />
    </div>
  );
}
