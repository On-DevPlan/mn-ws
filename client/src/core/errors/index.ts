// 错误契约：**失败抛 NxError，业务结果返回 {status}**。
//
// 这条边界是整个项目最重要的一条约定，判定标准是「调用方要不要处理它」：
//
// - 失败（参数非法、目标不存在、外部命令挂掉、数据损坏）
//   → throw。调用方无从处理，只能中断当前操作并上报。API 映射成 4xx/5xx，
//     CLI 映射成 exit 1 + 可解析文本。
// - 业务结果（同步遇到冲突等待选侧、幂等跳过、规则阻止删除）
//   → return { status: 'ok' | 'skipped' | 'conflict' | 'blocked', ... }。
//     这不是错误——UI 要拿它弹窗让用户决策，所以绝不能抛。
//
// 历史教训：改造前同一层里并存 throw / {ok:false} / {status} / {available} 四种
// 表达，上层只能靠字符串猜，无法程序化分支。
//
// 命名说明：类名是 NxError 而非 AppError——「App」在这个家族里指代不明
// （哪个 app？），而这类项目通名是 nx-xx，NxError 表意更准。
//
// 兼容约束：assets 里的 agent 文档教 agent 用错误文本中的「用法:」「未设置」
// 「不存在」三个子串分类失败。message 可以追加内容，但不得删除它们。

export const CODES = {
  INVALID_INPUT: 'INVALID_INPUT', // 参数缺失/非法/越界
  NOT_FOUND: 'NOT_FOUND', // 目标不存在
  CONFLICT: 'CONFLICT', // 状态冲突，需调用方决策
  BLOCKED: 'BLOCKED', // 业务规则主动阻止
  EXTERNAL: 'EXTERNAL', // 外部命令（git / gh）失败
  SPEC_ERROR: 'SPEC_ERROR', // action 声明本身有误（写错了，不是用户输入错）
  INTERNAL: 'INTERNAL', // 兜底
} as const;

export type ErrorCode = (typeof CODES)[keyof typeof CODES];

// code -> HTTP 状态。只在这里映射一次，api.js 不再自行判断。
// Record 穷尽性：新增错误码漏映射，编译期立即报错。
const HTTP_STATUS: Record<ErrorCode, number> = {
  [CODES.INVALID_INPUT]: 400,
  [CODES.NOT_FOUND]: 404,
  [CODES.CONFLICT]: 409,
  [CODES.BLOCKED]: 409,
  [CODES.EXTERNAL]: 502,
  [CODES.SPEC_ERROR]: 500, // 声明写错是开发者的错，不是调用方的错
  [CODES.INTERNAL]: 500,
};

// code -> 进程退出码。CLI 只区分「成功 / 失败」，保持 agent-workflow.md 声明的契约。
const EXIT_CODE: Record<ErrorCode, number> = {
  [CODES.INVALID_INPUT]: 1,
  [CODES.NOT_FOUND]: 1,
  [CODES.CONFLICT]: 1,
  [CODES.BLOCKED]: 1,
  [CODES.EXTERNAL]: 1,
  [CODES.SPEC_ERROR]: 1,
  [CODES.INTERNAL]: 1,
};

export class NxError extends Error {
  code: ErrorCode;
  details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'NxError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export function httpStatusOf(code: ErrorCode): number {
  return HTTP_STATUS[code] ?? 500;
}

export function exitCodeOf(code: ErrorCode): number {
  return EXIT_CODE[code] ?? 1;
}

// 把任意抛出物归一成 ErrorPayload，供 API / CLI 统一序列化。
// 非 NxError 一律归为 INTERNAL——不把内部堆栈细节泄漏给 agent。
export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof NxError) {
    const out: ErrorPayload = { code: err.code, message: err.message };
    if (err.details !== undefined) out.details = err.details;
    return out;
  }
  return { code: CODES.INTERNAL, message: String((err as { message?: string } | null)?.message || err) };
}

// ---- 构造快捷方式：让 service 层读起来是「为什么失败」而不是「怎么构造」 ----

export const badInput = (message: string, details?: unknown) =>
  new NxError(CODES.INVALID_INPUT, message, details);
export const notFound = (message: string, details?: unknown) =>
  new NxError(CODES.NOT_FOUND, message, details);
export const conflict = (message: string, details?: unknown) =>
  new NxError(CODES.CONFLICT, message, details);
export const blocked = (message: string, details?: unknown) =>
  new NxError(CODES.BLOCKED, message, details);
export const external = (message: string, details?: unknown) =>
  new NxError(CODES.EXTERNAL, message, details);

// action 声明写错了（不是用户输入错）。
// 由 core 抛出、spec.js 调用——这正是把它放在 core 的原因：spec 是 runtime 层，
// core 不能依赖它，而「声明有误」这个错误码是两层共用的名词。
export const specError = (message: string, details?: unknown) =>
  new NxError(CODES.SPEC_ERROR, message, details);
