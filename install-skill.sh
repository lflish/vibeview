#!/usr/bin/env bash
# vibeview Skill 一键安装脚本
#
# 用法（在目标机器上执行）：
#   远程一键安装：
#     curl -fsSL https://raw.githubusercontent.com/lflish/vibeview/main/install-skill.sh | bash
#   或带参数非交互安装：
#     DVIEW_URL=https://your-domain.com DVIEW_TOKEN=xxx \
#       bash -c "$(curl -fsSL https://raw.githubusercontent.com/lflish/vibeview/main/install-skill.sh)"
#   本地仓库内执行：
#     bash install-skill.sh
#
# 作用：把 dview-upload Skill 安装到 ~/.claude/skills/，并把 DVIEW_URL / DVIEW_TOKEN
#       写入你的 shell 配置（~/.zshrc 或 ~/.bashrc），方便随时调用。

set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/lflish/vibeview/main"
SKILL_NAME="dview-upload"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
DEST="$SKILLS_DIR/$SKILL_NAME"

info()  { printf '\033[36m[vibeview]\033[0m %s\n' "$1"; }
warn()  { printf '\033[33m[vibeview]\033[0m %s\n' "$1"; }
err()   { printf '\033[31m[vibeview]\033[0m %s\n' "$1" >&2; }

info "安装 dview-upload Skill 到: $DEST"
mkdir -p "$DEST"

# 1. 获取 Skill 文件：优先用本地仓库副本，否则从 GitHub 拉取
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/skill/$SKILL_NAME/upload.sh" ]; then
  info "检测到本地仓库，复制 Skill 文件"
  cp "$SCRIPT_DIR/skill/$SKILL_NAME/upload.sh" "$DEST/upload.sh"
  cp "$SCRIPT_DIR/skill/$SKILL_NAME/SKILL.md" "$DEST/SKILL.md"
else
  info "从 GitHub 下载 Skill 文件"
  curl -fsSL "$REPO_RAW/skill/$SKILL_NAME/upload.sh" -o "$DEST/upload.sh"
  curl -fsSL "$REPO_RAW/skill/$SKILL_NAME/SKILL.md" -o "$DEST/SKILL.md"
fi
chmod +x "$DEST/upload.sh"
info "Skill 文件已就位"

# 2. 收集配置（环境变量优先，否则交互输入；管道执行时无 tty 则跳过）
URL="${DVIEW_URL:-}"
TOKEN="${DVIEW_TOKEN:-}"

if [ -z "$URL" ] || [ -z "$TOKEN" ]; then
  if [ -t 0 ]; then
    [ -z "$URL" ]   && read -r -p "请输入服务地址 DVIEW_URL (如 https://view.example.com): " URL
    [ -z "$TOKEN" ] && read -r -p "请输入上传 token DVIEW_TOKEN: " TOKEN
  else
    warn "未提供 DVIEW_URL / DVIEW_TOKEN，且非交互环境，跳过环境变量写入。"
    warn "稍后请手动 export DVIEW_URL 和 DVIEW_TOKEN。"
  fi
fi

# 3. 写入 shell 配置
if [ -n "$URL" ] && [ -n "$TOKEN" ]; then
  case "${SHELL:-}" in
    *zsh) RC="$HOME/.zshrc" ;;
    *bash) RC="$HOME/.bashrc" ;;
    *) RC="$HOME/.profile" ;;
  esac
  touch "$RC"
  # 移除旧的 vibeview 配置块再追加，避免重复
  if grep -q "# >>> vibeview >>>" "$RC" 2>/dev/null; then
    sed -i.bak '/# >>> vibeview >>>/,/# <<< vibeview <<</d' "$RC" && rm -f "$RC.bak"
  fi
  {
    echo "# >>> vibeview >>>"
    echo "export DVIEW_URL=\"$URL\""
    echo "export DVIEW_TOKEN=\"$TOKEN\""
    echo "# <<< vibeview <<<"
  } >> "$RC"
  info "已写入环境变量到 $RC（重开终端或执行 source $RC 生效）"
fi

echo ""
info "安装完成 ✅"
echo "  Skill 位置: $DEST"
echo "  使用方法:   bash $DEST/upload.sh <文件路径>"
echo "  或重载配置后直接让 AI 调用 dview-upload Skill。"
