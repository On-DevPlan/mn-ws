// auth 模块：统一登录（go-ah auth-hub）与本机多账号账号簿。
//
//   login   弹浏览器完成一次授权 → 换回设备令牌，之后免手填
//   list    列出本机已存账号（标出当前生效的那个）
//   switch  切换当前生效账号（多人共用这台电脑时就是换人）
//   status  查看当前身份、令牌剩余有效期
//   logout  清除登录凭据（默认只清当前账号，--all 清空全部）
//
// 与 mn-rt 的 auth 同一套形状（命令名、账号簿语义、--new-account 都对齐）。
import { defineAction } from '../../runtime/types/action.js';
import { defineModule } from '../../runtime/types/module.js';
import { getController } from '../../core/controller.js';
import {
  login, listAccountsView, switchAccount, authStatus, logout,
  renderLogin, renderList, renderSwitch, renderStatus, renderLogout,
} from './service.js';

export default defineModule({
  id: 'auth',
  title: '登录',
  order: 3,
  actions: [
    defineAction({
      id: 'auth.login',
      cli: ['auth', 'login'],
      http: ['POST', '/api/auth/login/start'],
      summary: '统一登录（弹浏览器）：换回设备令牌，之后免手填',
      flags: {
        'new-account': { type: 'boolean', hint: '强制认证中心重新登录（换人用）' },
        'no-open': { type: 'boolean', hint: '只打印授权地址、不弹浏览器' },
      },
    })(
      async (ctx, meta) => login(getController(), {
        newAccount: ctx['new-account'] === true,
        noOpen: ctx['no-open'] === true,
        // 面板与 CLI 的登录流程**发起位置不同**：
        //   CLI   → 自己起一个随机端口的回环监听
        //   面板  → 回调落在面板自己的 /callback（端口是面板运行时选的）
        transport: meta?.transport,
      }),
      (r) => renderLogin(r),
    ),

    defineAction({
      id: 'auth.list',
      cli: ['auth', 'list'],
      http: ['GET', '/api/auth/accounts'],
      summary: '列出本机已存账号',
    })(
      () => listAccountsView(getController()),
      (r) => renderList(r),
    ),

    defineAction({
      id: 'auth.switch',
      cli: ['auth', 'switch'],
      http: ['POST', '/api/auth/switch'],
      summary: '切换当前生效账号（序号/邮箱/用户名/昵称）',
      args: [{ name: 'account', required: false }],
    })(
      (ctx) => switchAccount(getController(), String(ctx.account || '')),
      (r) => renderSwitch(r),
    ),

    defineAction({
      id: 'auth.status',
      cli: ['auth', 'status'],
      http: ['GET', '/api/auth/status'],
      summary: '查看当前身份、令牌剩余有效期',
    })(
      () => authStatus(getController()),
      (r) => renderStatus(r),
    ),

    defineAction({
      id: 'auth.logout',
      cli: ['auth', 'logout'],
      http: ['POST', '/api/auth/logout'],
      summary: '清除登录凭据（--all 清空全部账号）',
      flags: { all: { type: 'boolean', hint: '清空全部账号' } },
    })(
      (ctx) => logout(getController(), ctx.all === true),
      (r) => renderLogout(r),
    ),
  ],
});
