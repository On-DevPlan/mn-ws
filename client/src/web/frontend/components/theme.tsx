// 色彩主题：头部切换按钮 + 首页分段选择器。
//
// 主题存放在后端 settings（setting.set --key theme --value light|dark|auto），
// 与导航配置同源；App 负责把当前主题写到 <html data-theme>，CSS 只覆盖 token。
// 图标用 SVG 描边（无 emoji，符合视觉规范）。
import type { ReactNode } from 'react';
import { api } from '../api/client.js';
import { useStore } from '../store.jsx';
import type { SettingsResponse } from '../store.jsx';

export interface ThemeOption {
  id: string;
  label: string;
}

export const THEMES: ThemeOption[] = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'auto', label: '跟随系统' },
];

export function currentTheme(settings: SettingsResponse | null): string {
  const t = settings?.settings?.theme;
  return t && THEMES.some((x) => x.id === t) ? t : 'light';
}

export function SunIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function MoonIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

export function AutoIcon(): ReactNode {
  // 半明半暗：左半边填实、右半边留白，表达「跟随系统」
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity="0.25" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function ThemeIcon({ theme }: { theme: string }): ReactNode {
  if (theme === 'light') return <SunIcon />;
  if (theme === 'dark') return <MoonIcon />;
  return <AutoIcon />;
}

async function changeTheme(next: string, refreshSettings: () => Promise<SettingsResponse>): Promise<void> {
  await api('/api/settings', { method: 'PATCH', body: { key: 'theme', value: next } });
  await refreshSettings();
}

/** 头部按钮：light → dark → auto 循环。 */
export function ThemeToggle(): ReactNode {
  const { settings, refreshSettings } = useStore();
  const theme = currentTheme(settings);
  const cur = THEMES.find((t) => t.id === theme) ?? THEMES[0]!;
  const idx = THEMES.indexOf(cur);
  const next = THEMES[(idx + 1) % THEMES.length]!;
  return (
    <button
      className="theme-toggle"
      title={`色彩主题：${cur.label}（点击切到${next.label}）`}
      onClick={() => { void changeTheme(next.id, refreshSettings); }}
    >
      <ThemeIcon theme={theme} />
    </button>
  );
}

/** 首页分段选择器：三选一，点击即保存。 */
export function ThemePicker(): ReactNode {
  const { settings, refreshSettings } = useStore();
  const theme = currentTheme(settings);
  return (
    <div className="seg">
      {THEMES.map((t) => (
        <button
          key={t.id}
          className={t.id === theme ? 'active' : ''}
          title={t.label}
          onClick={() => { void changeTheme(t.id, refreshSettings); }}
        >
          <ThemeIcon theme={t.id} />
          {t.label}
        </button>
      ))}
    </div>
  );
}
