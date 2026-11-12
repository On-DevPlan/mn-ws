# Changelog

本文件记录对外可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

- 新条目写在文件最上面；尚未发版的收进 [Unreleased]，发版时改成 `版本号 - 日期`（YYYY-MM-DD）
- 条目按 Added / Changed / Deprecated / Removed / Fixed / Security 分组，没有的组不写
- 只记对外可见的变更：CLI 命令行为、HTTP API、配置项、依赖与安全；内部重构不记

## [Unreleased]

### Added

- 初始骨架：TypeScript 版骨架，自带编译期类型安全系统（由 nx-nx 的 `server-cli-web-ts` 模板生成）。
