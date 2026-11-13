// ESLint 扁平配置。
//
// 这里主要管的不是代码风格（那个交给约定与编辑器），而是**分层约束**：
// 把「谁可以依赖谁」写成机器可检查的规则。架构意图一旦只写在文档里，
// 就会随提交次数慢慢衰减；写成 lint 规则则会当场拦下。
import tseslint from 'typescript-eslint';

// 单文件字符数闸门。
//
// 与下面的 max-lines 是同一件事的两把尺子：行数管「结构」，字符数管「密度」。
// 只看行数时，把每行拉长就能继续膨胀；只看字符数时，密集短行又会被误伤。
// 两者都按「有效代码」计（跳过空行与注释），阈值 15000 对当前最大文件
// （scripts/link-local.mjs，约 12.7k 有效字符）留出余量：再翻一倍就该拆了。
//
// ESLint 没有内置的「单文件字符数」规则，这里用一份内联插件补上，
// 免得为一个阈值去引第三方插件或额外文件。
const FILE_SIZE = {
  rules: {
    'max-file-chars': {
      meta: {
        type: 'suggestion',
        docs: { description: '单个文件的有效字符数上限，防止文件体积膨胀' },
        schema: [
          {
            type: 'object',
            properties: { max: { type: 'integer', minimum: 1 } },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        const max = (context.options[0] && context.options[0].max) || 15000;
        return {
          Program(node) {
            const source = context.sourceCode || context.getSourceCode();
            let text = source.getText();
            // 注释区间整段剔除：比正则可靠，不会误伤字符串里的 `//`
            for (const comment of [...source.getAllComments()].reverse()) {
              text = text.slice(0, comment.range[0]) + text.slice(comment.range[1]);
            }
            const count = text.replace(/\s/g, '').length;
            if (count > max) {
              // 消息用字符串拼接，**不要**用 ESLint 的 messages/messageId 插值：
              // 那套语法是「双花括号 + 变量名」，而本文件是模板文件，模板引擎
              // 同样把双花括号当生成变量，生成项目时直接报「未声明的变量」。
              // 连这段注释里都不能出现双花括号，否则生成期一样会红。
              context.report({
                node,
                message: `单文件有效字符数 ${count} 超过上限 ${max}，请按职责拆分文件。`,
              });
            }
          },
        };
      },
    },
  },
};

// 操作成对闸门：一条 action 要么同时有 CLI 与 HTTP，要么显式承认只做 CLI。
//
// 运行时注册表已经在装载期拦「没有 CLI 的 action」，但那是启动后才失败；
// 而且「http: null」一直是个无声出口——写了纯 CLI 命令没人知道是有意还是漏了。
// 这条规则把判决提前到编辑器/lint：http: null 必须二选一——
//   a) 属于豁免前缀（serve / server / skill，这些天然是 CLI 侧能力），或
//   b) 显式写 web: false，表明「这个操作就是不给面板入口」。
// 反向也管：同时声明 http 与 web: false 是语义冲突，当场报错。
//
// 规则扫的是 action 对象字面量（以 id 字符串为锚点，兼容 JS 的 run 写法和
// TS 的 defineAction 两段式写法），不是运行时值——所以它不需要跑起来。
const ACTION_PARITY = {
  rules: {
    'action-parity': {
      meta: {
        type: 'problem',
        docs: {
          description: 'action 必须同时声明 CLI 与 HTTP；纯 CLI 需显式 web: false 或属于豁免前缀',
        },
        schema: [
          {
            type: 'object',
            properties: { cliOnlyPrefixes: { type: 'array', items: { type: 'string' } } },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        const opts = context.options[0] || {};
        // 豁免名单同时也是 runtime/registry 的常量；两处必须一致（有单测对账）
        const prefixes = opts.cliOnlyPrefixes || ['serve', 'server', 'skill'];

        // 读对象里的字面量属性（只认 Identifier / Literal 键，不碰计算属性）
        //
        // ⚠️ 属性可能不是 Property —— 展开语法 `...x` 是 SpreadElement，**没有 key**。
        //    直接读 p.key.type 会在遇到它时崩掉（整个 lint 挂掉，而不是报一条错）。
        //    所以先挡掉没有 key 的属性再比。
        const propOf = (obj, name) =>
          obj.properties.find(
            (p) =>
              p.key &&
              !p.computed &&
              ((p.key.type === 'Identifier' && p.key.name === name) ||
                (p.key.type === 'Literal' && p.key.value === name))
          );
        const literalString = (node) =>
          node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;

        // CLI 可能写成 ['a','b']，也可能写成 [[别名路径], ['另一条路径']]
        function firstCliSegment(cliProp) {
          if (!cliProp || cliProp.value.type !== 'ArrayExpression') return null;
          const first = cliProp.value.elements[0];
          if (!first) return null;
          if (first.type === 'Literal') return literalString(first);
          if (first.type === 'ArrayExpression') return literalString(first.elements[0]);
          return null;
        }

        return {
          ObjectExpression(node) {
            const idProp = propOf(node, 'id');
            const id = idProp ? literalString(idProp.value) : null;
            if (!id) return;

            const cliProp = propOf(node, 'cli');
            const httpProp = propOf(node, 'http');
            const webProp = propOf(node, 'web');
            const runProp = propOf(node, 'run');

            // 只认 action 字面量：模块对象（id + actions）不满足下面任一特征
            if (!runProp && !cliProp && !httpProp) return;

            const report = (n, message) => context.report({ node: n || node, message });

            if (
              !cliProp ||
              cliProp.value.type !== 'ArrayExpression' ||
              cliProp.value.elements.length === 0
            ) {
              report(cliProp || idProp, `action ${id} 必须声明非空 cli（Web 操作必须有 CLI 等价命令）`);
            }

            if (!httpProp) {
              report(idProp, `action ${id} 必须声明 http 路由；纯 CLI 请写 http: null 并标注 web: false`);
              return;
            }

            const httpValue = httpProp.value;
            const isNull = httpValue.type === 'Literal' && httpValue.value === null;
            const webFalse =
              webProp && webProp.value.type === 'Literal' && webProp.value.value === false;

            if (isNull) {
              const segment = firstCliSegment(cliProp);
              const exempt = segment && prefixes.includes(segment);
              if (!exempt && !webFalse) {
                report(
                  httpProp,
                  `action ${id} 声明了 http: null，但既不在豁免前缀（${prefixes.join(' / ')}）内，也没有显式 web: false——CLI 与 Web 必须成对`
                );
              }
              return;
            }

            if (httpValue.type === 'ArrayExpression') {
              if (
                httpValue.elements.length !== 2 ||
                !literalString(httpValue.elements[0]) ||
                !literalString(httpValue.elements[1])
              ) {
                report(httpProp, `action ${id} 的 http 必须是 [method, path] 两个字面量`);
              }
              if (webFalse) {
                report(webProp, `action ${id} 同时声明了 http 与 web: false，语义冲突`);
              }
            }
          },
        };
      },
    },
  },
};

// 两个内联插件合并成一个，避免同一个文件被两个 plugins 块重复声明。
const LOCAL_RULES = { rules: { ...FILE_SIZE.rules, ...ACTION_PARITY.rules } };

export default tseslint.config(
  {
    // e2e-remote.cjs 必须保持 CommonJS：client 包写着 "type": "module"，
    // 写成 .js 会被当 ESM 加载，而这个脚本用 require —— 改成 ESM 会直接跑不起来。
    // 所以按扩展名忽略它，而不是把 require 改成 import。
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'src/web/frontend/public/**',
      '**/*.cjs',
    ],
  },

  // TS / TSX：typescript-eslint 推荐规则集
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      // 文件行数上限：防止单文件持续膨胀。跳过空行与注释，统计的是有效代码行；
      // 新增代码前先看看目标文件是否已逼近上限，超限应先拆分文件。
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 非空断言在本项目里与品牌类型/校验成对出现，不全局禁用
      '@typescript-eslint/no-non-null-assertion': 'off',
      // 函数式 builder 里空函数体等场景
      '@typescript-eslint/no-empty-function': 'off',
      // 显式 any 仅警告——类型边界处保留逃生舱
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // 纯 JS（bin / scripts / tests）：基础规则
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      eqeqeq: ['error', 'smart'],
      // 与 TS 块一致的文件行数上限
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // 字符数闸门：覆盖所有被 lint 的文件，不给任何目录开豁免 ——
  // 体积上限是产品约束，不是「代码 / 非代码」的区分。
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'],
    plugins: { local: LOCAL_RULES },
    rules: { 'local/max-file-chars': ['error', { max: 15000 }] },
  },

  // 操作成对：每条 action 必须同时有 CLI 与 HTTP（纯 CLI 走豁免前缀或 web: false）
  {
    files: ['src/modules/*/index.ts'],
    plugins: { local: LOCAL_RULES },
    rules: {
      'local/action-parity': ['error', { cliOnlyPrefixes: ['serve', 'server', 'skill'] }],
    },
  },

  // ---- 分层约束（对应「依赖只能向下 core ← modules ← runtime」）----

  {
    // core 是最底层：零业务语义的基础设施。它一旦依赖上层，分层就塌了。
    files: ['src/core/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../modules/**', '../runtime/**', '../web/**',
                '../../modules/**', '../../runtime/**', '../../web/**',
              ],
              message: 'core 是最底层，不得依赖 modules / runtime / web。',
            },
          ],
        },
      ],
    },
  },

  {
    // 业务模块：模块之间禁止互相值依赖。新增模块时把它的路径补进 files 与
    // group 枚举（逐模块枚举，漏补会静默失效）。
    files: [
      'src/modules/home/**/*.{ts,tsx}',
      'src/modules/bridge/**/*.{ts,tsx}',
      'src/modules/auth/**/*.{ts,tsx}',
      'src/modules/skill/**/*.{ts,tsx}',
    ],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../home/*', '../home/**',
                '../bridge/*', '../bridge/**',
                '../auth/*', '../auth/**',
                '../skill/*', '../skill/**',
              ],
              allowTypeImports: true,
              message:
                '模块之间不得做值依赖；共享逻辑请下沉到 core/（类型引用允许 import type）。',
            },
          ],
        },
      ],
    },
  },

  {
    // 前端（含 modules/home 下的视图 tsx）：这条规则价值最高——
    // 把 Node 侧代码值导入视图，Vite 会把 node: 内置模块一起打进浏览器包。
    //
    // 关键：Node 侧的**类型**导入是允许的（typed client 的类型由注册表推出），
    // 因此用 allowTypeImports 放行；node:* 内置连类型一起禁。
    files: [
      'src/web/frontend/**/*.{ts,tsx}',
      'src/modules/home/**/*.tsx',
      'src/modules/bridge/**/*.tsx',
      'src/modules/auth/**/*.tsx',
    ],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: '前端不能引用 Node 内置模块。',
            },
            {
              group: [
                '**/modules/*/index.ts',
                '**/modules/*/service.ts',
                '**/runtime/**/*.ts',
                '**/core/**/*.ts',
              ],
              allowTypeImports: true,
              message:
                '前端只能以 import type 引用 Node 侧（index/service/runtime/core）；' +
                '值导入会把 node: 内置模块一起打进浏览器包。',
            },
          ],
        },
      ],
    },
  },
);
