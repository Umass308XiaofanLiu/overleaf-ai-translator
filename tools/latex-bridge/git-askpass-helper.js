#!/usr/bin/env node
'use strict';

// v2 Pass P24：Overleaf git 集成的 GIT_ASKPASS 助手。
//
// git 需要凭证时会调 `<GIT_ASKPASS> "<提示文字>"`，期待 stdout 打印答案。这个助手不接受、
// 也不需要任何命令行参数里的真实凭证——token 只从 OVL_GIT_TOKEN 这一个环境变量读，
// 环境变量不会出现在 Windows 的 Win32_Process.CommandLine 里，这是本文件存在的唯一理由
// （见 tools/latex-bridge/server.js 里 runGitCommand 的头部注释，同一份安全设计）。
//
// Overleaf 的 git 鉴权是 HTTP Basic，密码 = 项目级 Git Token。git 通常会先问
// "Username for '...':" 再问 "Password for '...':"——密码问题回 OVL_GIT_TOKEN。
//
// v2 Pass P133f：用户名问题曾经一律回空字符串（旧注释误写"Overleaf 不检查用户名"），但
// Overleaf 官方文档明确要求用户名必须是字面量 "git"（本仓库 origin remote URL 形如
// https://git.overleaf.com/<projectId>，不带用户名，git 发出的 Basic 认证用户名因此原本
// 是空串）。本机此前"能用"是因为 Windows 凭据管理器里存了一份 git 用户名的旧凭据在垫背；
// jump 上没有这层（P133e 已经把 credential.helper 清空，逼真条件走 askpass），空用户名会
// 让 Overleaf 直接 401。现在优先读 OVL_GIT_USERNAME 环境变量（server.js 的 runGitCommand
// 固定注入 'git'），该变量未设时也兜底成 'git'，不再回空字符串。
const prompt = process.argv[2] || '';
process.stdout.write(/username/i.test(prompt) ? (process.env.OVL_GIT_USERNAME || 'git') : (process.env.OVL_GIT_TOKEN || ''));
