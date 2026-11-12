// 栏目管理：**容器 + 拖拽**。整页只有一个心智模型——
//   一个页面要么在「平铺」里、要么在某个分组里、要么在「隐藏」里；
//   拖，就是把它从一个容器挪到另一个。
//
// 「隐藏」不是开关，就是一个容器：拖进去 = 不出现在头部（深链仍然可用）。
//
// **拖动时不重排列表，只画一条落点指示线**：被拖的行原地变淡、占位不塌，
// 指示线标在指针算出的落点；松手才把数据一次性提交。这是拖拽分组的稳定做法——
// 若拖动中就把列表按落点重排，DOM 会在指针下移动，浏览器随即对新出现的行再触发
// dragover，落点又被重算，跨容器来回拖时尤其会反复重排「一直闪」（反馈回路）。
//
// **受控组件**：数据（cfg）与保存都在本页（首页）；这里只管画与调 onChange。
// 所有数据操作走 navModel 的纯函数（可单测），组件里不做状态体操。
import { Fragment, useState } from 'react';
import * as nav from '../../web/frontend/components/navModel.js';
import type { NavConfig, Target } from '../../web/frontend/components/navModel.js';

interface Section {
  id: string;
  title: string;
}

interface Props {
  sections: Section[];
  value: NavConfig;
  onChange: (next: NavConfig) => void;
}

type DragState = { kind: 'view'; vid: string } | { kind: 'group'; gi: number };
type OverState = { key: string; index: number | null; group?: boolean };

export default function NavManager({ sections, value, onChange }: Props) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [over, setOver] = useState<OverState | null>(null);

  const allIds = sections.map((s) => s.id);
  const sectionOf = (id: string) => sections.find((s) => s.id === id) || null;

  const keyToTarget = (key: string): Target | null => {
    if (key === 'pool') return { kind: 'pool' };
    if (key === 'hidden') return { kind: 'hidden' };
    const gi = Number(key.slice(1));
    return Number.isFinite(gi) ? { kind: 'group', gi } : null;
  };

  const draggingVid = drag?.kind === 'view' ? drag.vid : null;
  const endDrag = () => { setDrag(null); setOver(null); };

  // 只在落点真的变了才 setState：dragover 每次鼠标移动都触发，不去重就会每动一下重算
  const setOverIfChanged = (next: OverState) => setOver((o) => (
    o && o.key === next.key && o.index === next.index && o.group === next.group ? o : next
  ));

  /** 松手按落点指示线提交：插入位经 insertionIndex 换算，再 moveToContainer 一次性落位。 */
  const commit = () => {
    if (drag?.kind === 'view' && over) {
      const target = keyToTarget(over.key);
      if (target) {
        const idx = nav.insertionIndex(value, drag.vid, target, over.index, allIds);
        const next = nav.moveToContainer(value, drag.vid, target, idx, allIds);
        if (next !== value) onChange(next);
      }
    }
    endDrag();
  };

  // 容器空白区：index 为 null = 追加到末尾。
  const zone = (key: string, base = '') => ({
    className: `${base} ${over?.key === key && !over.group ? 'drop-target' : ''}`,
    onDragOver: (e: React.DragEvent) => {
      if (draggingVid) { e.preventDefault(); setOverIfChanged({ key, index: null }); }
    },
    onDragLeave: (e: React.DragEvent) => {
      // 进入子元素也会触发容器的 dragleave，只在真正离开容器时才清
      const related = e.relatedTarget as Node | null;
      if (!related || !e.currentTarget.contains(related)) {
        setOver((o) => (o?.key === key ? null : o));
      }
    },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); commit(); },
  });

  /**
   * 行的落点判定。三条防抖铁律：
   *   ① 行内事件**就地拦下**（preventDefault + stopPropagation）：一旦冒泡到容器，
   *      容器会把它当成「拖到空白处」翻成「追加到末尾」——指针压在被拖的行上时来回切，就抖。
   *   ② 插入位取自**静态列表**（渲染即 value，不随拖动重排）里该行的渲染下标 rowIndex
   *      + 指针在上半/下半决定前后；列表不动，指针下的行不会自己漂移，落点才稳定。
   *   ③ 悬停在被拖的自己身上：保持当前落点，不重算。
   */
  const rowProps = (key: string, vid: string, rowIndex: number) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!draggingVid) return;
      e.preventDefault();
      e.stopPropagation();
      if (draggingVid === vid) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const below = e.clientY > rect.top + rect.height / 2;
      setOverIfChanged({ key, index: rowIndex + (below ? 1 : 0) });
    },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); commit(); },
    onDragStart: () => setDrag({ kind: 'view', vid }),
  });

  /**
   * 画一个容器的静态列表，并在落点处插一条指示线。
   * 空白区（index=null）的指示线落在列表末尾；空容器走 emptyHint。
   */
  const renderList = (key: string, vids: string[], actionFor: (vid: string) => React.ReactNode) => {
    const active = over?.key === key && !over.group;
    const ind = active
      ? (over.index === null ? vids.length : over.index)
      : null;
    return (
      <div className="nav-list">
        {ind === 0 && <DropIndicator />}
        {vids.map((vid, i) => (
          <Fragment key={vid}>
            <SectionRow section={sectionOf(vid)} vid={vid}
              dragging={draggingVid === vid}
              {...rowProps(key, vid, i)}
              onDragEnd={endDrag}
              actions={actionFor(vid)} />
            {ind === i + 1 && <DropIndicator />}
          </Fragment>
        ))}
      </div>
    );
  };

  const emptyHint = (key: string, text: string) => (
    <div className="row">
      <span className="desc">{text}</span>
      {over?.key === key && !over.group && <DropIndicator />}
    </div>
  );

  const poolVids = nav.poolIds(value, allIds);

  return (
    <div className="stack">
      {/* ① 平铺：不进分组也不隐藏的页面（= 头部平铺显示） */}
      <section {...zone('pool', 'nav-pool')}>
        <div className="hint">平铺：不进分组也不隐藏的页面，直接显示头部（拖到这里 = 移出分组 / 取消隐藏）</div>
        {poolVids.length
          ? renderList('pool', poolVids, () => null)
          : emptyHint('pool', '没有平铺的页面。')}
      </section>

      {/* ② 分组：组名可改、组间可拖把手换位 */}
      {value.groups.map((g, gi) => {
        const key = `g${gi}`;
        return (
          <section key={gi} {...zone(key, 'card nav-group')}>
            <div
              className={`colhead ${over?.key === key && over.group ? 'drop-target' : ''}`}
              onDragOver={(e) => {
                if (drag?.kind === 'group') { e.preventDefault(); setOverIfChanged({ key, index: null, group: true }); }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag?.kind === 'group' && drag.gi !== gi) onChange(nav.moveGroup(value, drag.gi, gi - drag.gi));
                endDrag();
              }}
            >
              <span className="grip" title="拖动调整分组顺序" draggable
                onDragStart={() => setDrag({ kind: 'group', gi })} onDragEnd={endDrag} />
              <input className="nav-title" placeholder="组名，如「求职」" value={g.title}
                onChange={(e) => onChange(nav.renameGroup(value, gi, e.target.value))} />
              <span className="muted">{g.views.length} 个页面</span>
              <span className="right rowgap">
                <button className="btn small ghost" onClick={() => onChange(nav.removeGroup(value, gi))}>删除组</button>
              </span>
            </div>
            {g.views.length
              ? renderList(key, g.views, (vid) => (
                <button className="btn small ghost" onClick={() => onChange(nav.toPool(value, vid, allIds))}>移出</button>
              ))
              : emptyHint(key, '空分组——把页面拖进来。')}
          </section>
        );
      })}

      {/* ③ 隐藏：与分组同构的容器——拖进去即「不进头部」 */}
      <section {...zone('hidden', 'card nav-group nav-hidden')}>
        <div className="colhead">
          隐藏
          <span className="muted">{value.hidden.length} 个页面</span>
          <span className="right muted">不进头部 · 深链仍可用</span>
        </div>
        {value.hidden.length
          ? renderList('hidden', value.hidden, () => null)
          : emptyHint('hidden', '没有隐藏的页面——把不常用的拖进来。')}
      </section>

      <div className="rowgap">
        <button className="btn" onClick={() => onChange(nav.addGroup(value))}>新增分组</button>
        <span className="hint">组顺序 = 头部显示顺序；组内顺序 = 展开列表顺序</span>
      </div>
    </div>
  );
}

/** 落点指示线：一条横线标「松手会插到这儿」。 */
function DropIndicator() {
  return <div className="drop-ind" aria-hidden="true" />;
}

/** 一行页面：把手（拖）+ 名称 + 容器自己的动作（移出 / 无）。 */
function SectionRow({ section, vid, dragging, actions, onDragStart, onDragEnd, onDragOver, onDrop }: {
  section: Section | null;
  vid: string;
  dragging: boolean;
  actions: React.ReactNode;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  return (
    <div className={`row nav-row ${dragging ? 'dragging' : ''}`} onDragOver={onDragOver} onDrop={onDrop}>
      <span className="grip" title="拖动：换位 / 换容器" draggable onDragStart={onDragStart} onDragEnd={onDragEnd} />
      <span className="name">{section ? section.title : `页面已删除（${vid}）`}</span>
      <span className="desc">{section ? vid : '保存前请移出'}</span>
      <span className="acts">{actions}</span>
    </div>
  );
}
