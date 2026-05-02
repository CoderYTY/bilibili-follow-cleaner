# Bilibili Follow Cleaner

一个 Codex Skill，用来帮助清理 B 站关注列表：扫描你关注的 UP 主，结合最近观看历史找出“很久没看过”的候选账号，生成名单，并在你确认后分批取消关注。

## 功能

- 扫描 B 站关注列表。
- 对比最近观看历史，找出指定天数内没有看过普通投稿视频的 UP 主。
- 导出候选名单为 Markdown、CSV 和 JSON。
- 在明确确认后批量取消关注。
- 遇到 B 站风控或频控时停止，并支持稍后继续处理剩余名单。

## 安装到 Codex

把仓库克隆到本机 Codex 技能目录。

Windows PowerShell:

```powershell
git clone https://github.com/CoderYTY/bilibili-follow-cleaner.git "$env:USERPROFILE\.codex\skills\bilibili-follow-cleaner"
```

macOS / Linux:

```bash
git clone https://github.com/CoderYTY/bilibili-follow-cleaner.git ~/.codex/skills/bilibili-follow-cleaner
```

安装后，重启 Codex 或开启一个新对话，让技能列表重新加载。

## 使用示例

在 Codex 里直接说：

```text
使用 $bilibili-follow-cleaner 打开 B 站，我自己登录后，帮我找出最近 180 天没看过视频的关注账号。
```

或者：

```text
使用 $bilibili-follow-cleaner 扫描我的 B 站关注列表，列出很久没看过的 UP 主，先不要取消关注。
```

当 Codex 生成候选名单后，你可以继续说：

```text
确认取消关注这些候选账号。每操作 50 个休息 1 分钟，遇到风控就停。
```

如果中途被 B 站频控，稍后可以继续：

```text
继续处理剩下没有取消成功的账号，跳过我已经手动取消的 UID 123456。
```

## 直接运行脚本

这个技能的核心脚本是：

```text
scripts/bilibili_follow_cleaner.mjs
```

脚本需要：

- Node.js
- Playwright
- 一个开启 CDP 远程调试端口的 Chrome 或 Edge 窗口
- 你在浏览器里手动登录 B 站

示例命令：

```powershell
$env:BILI_CDP_PORT="9227"
$env:BILI_DATA_DIR="$PWD\bili-output"
node scripts/bilibili_follow_cleaner.mjs scan 180
node scripts/bilibili_follow_cleaner.mjs report
```

取消关注前请先检查候选名单。确认后再运行：

```powershell
node scripts/bilibili_follow_cleaner.mjs unfollow
```

如果遇到频控，稍后重试失败项：

```powershell
node scripts/bilibili_follow_cleaner.mjs retry-failed 50 60000
node scripts/bilibili_follow_cleaner.mjs remaining-report
```

## 输出文件

默认输出到当前目录，或输出到 `BILI_DATA_DIR` 指定的目录：

- `bilibili-following-scan.json`
- `bilibili-following-candidates.md`
- `bilibili-following-candidates.csv`
- `bilibili-unfollow-result.json`
- `bilibili-unfollow-retry-result.json`
- `bilibili-unfollow-remaining.md`
- `bilibili-unfollow-remaining.csv`

这些文件包含账号关注和观看历史相关信息，建议只保存在本地，不要公开上传。

## 安全说明

- 技能不会要求你提供 B 站密码、短信验证码、OTP 或二维码登录令牌。
- 登录必须由你自己在浏览器里完成。
- 取消关注会修改你的 B 站账号关系，执行前必须明确确认。
- 如果 B 站返回连续 `-352` 或网络请求错误，应该暂停一段时间再继续。

## 许可证

未指定许可证前，默认保留所有权利。
