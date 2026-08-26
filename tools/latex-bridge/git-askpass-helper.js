#!/usr/bin/env node
'use strict';

// v2 Pass P24：Overleaf git 集成的 GIT_ASKPASS 助手。
//
// git 需要凭证时会调 `<GIT_ASKPASS> "<提示文字>"`，期待 stdout 打印答案。这个助手不接受、
// 也不需要任何命令行参数里的真实凭证——token 只从 OVL_GIT_TOKEN 这一个环境变量读，
// 环境变量不会出现在 Windows 的 Win32_Process.CommandLine 里，这是本文件存在的唯一理由
// （见 tools/latex-bridge/server.js 里 runGitCommand 的头部注释，同一份安全设计）。
//
// Overleaf 的 git 鉴权是 HTTP Basic：用户名随意/可留空，密码 = 项目级 Git Token。git 通常会
// 先问 "Username for '...':" 再问 "Password for '...':"——用户名问题一律回空字符串（Overleaf
// 不检查用户名），密码问题回 OVL_GIT_TOKEN。
const prompt = process.argv[2] || '';
process.stdout.write(/username/i.test(prompt) ? '' : (process.env.OVL_GIT_TOKEN || ''));
