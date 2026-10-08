#!/usr/bin/env bash
# vibeview 一键安装：Skill + CLI + 环境变量
#
# 用法（在目标机器上执行）：
#   远程一键安装：
#     curl -fsSL https://raw.githubusercontent.com/lflish/vibeview/main/install-skill.sh | bash
#   非交互（环境变量）：
#     DVIEW_URL=https://your-domain.com DVIEW_TOKEN=xxx \
#       bash -c "$(curl -fsSL https://raw.githubusercontent.com/lflish/vibeview/main/install-skill.sh)"
#   非交互（参数）：
#     bash install-skill.sh --url https://your-domain.com --token xxx --cli
#   本地仓库内执行：
#     bash install-skill.sh
#
# 选项：
#   --url URL          服务地址
#   --token TOKEN      上传 token
#   --cli              安装 CLI 到 ~/.local/bin（默认开启）
#   --no-cli           不安装 CLI
#   --no-claude        不安装 Claude Skill / 命令
#   --cli-prefix DIR   CLI 安装目录（默认 ~/.local/bin）
#   -h, --help         显示帮助
#
# 作用：把 dview-upload Skill 装到 ~/.claude/skills/，把 /dview 命令装到
#       ~/.claude/commands/，把 bin/dview 装到 PATH，并把 DVIEW_* 写入 shell rc。

set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/lflish/vibeview/main"
SKILL_NAME="dview-upload"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
DEST="$SKILLS_DIR/$SKILL_NAME"
COMMANDS_DIR="${CLAUDE_COMMANDS_DIR:-$HOME/.claude/commands}"
COMMAND_NAME="dview"
CLI_PREFIX="${DVIEW_CLI_PREFIX:-$HOME/.local/bin}"
INSTALL_CLI=1
INSTALL_CLAUDE=1
URL="${DVIEW_URL:-}"
TOKEN="${DVIEW_TOKEN:-}"

info()  { printf '\033[36m[vibeview]\033[0m %s\n' "$1"; }
warn()  { printf '\033[33m[vibeview]\033[0m %s\n' "$1"; }
err()   { printf '\033[31m[vibeview]\033[0m %s\n' "$1" >&2; }

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \?//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --url)
      [ "$#" -ge 2 ] || { err "--url 需要参数"; exit 1; }
      URL="$2"
      shift 2
      ;;
    --token)
      [ "$#" -ge 2 ] || { err "--token 需要参数"; exit 1; }
      TOKEN="$2"
      shift 2
      ;;
    --cli)
      INSTALL_CLI=1
      shift
      ;;
    --no-cli)
      INSTALL_CLI=0
      shift
      ;;
    --no-claude)
      INSTALL_CLAUDE=0
      shift
      ;;
    --cli-prefix)
      [ "$#" -ge 2 ] || { err "--cli-prefix 需要参数"; exit 1; }
      CLI_PREFIX="$2"
      shift 2
      ;;
    *)
      err "未知参数: $1"
      usage >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

fetch_or_copy() {
  local rel="$1"
  local dest="$2"
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/$rel" ]; then
    cp "$SCRIPT_DIR/$rel" "$dest"
  else
    curl -fsSL "$REPO_RAW/$rel" -o "$dest"
  fi
}

# ---- Claude Skill + command ----
if [ "$INSTALL_CLAUDE" = "1" ]; then
  info "安装 dview-upload Skill 到: $DEST"
  mkdir -p "$DEST"
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

  info "安装 /$COMMAND_NAME 命令到: $COMMANDS_DIR/$COMMAND_NAME.md"
  mkdir -p "$COMMANDS_DIR"
  fetch_or_copy "command/$COMMAND_NAME.md" "$COMMANDS_DIR/$COMMAND_NAME.md"
  info "命令文件已就位（在 Claude Code 中输入 /$COMMAND_NAME 使用）"
else
  info "跳过 Claude Skill / 命令安装（--no-claude）"
fi

# ---- CLI ----
CLI_PATH=""
if [ "$INSTALL_CLI" = "1" ]; then
  mkdir -p "$CLI_PREFIX"
  CLI_PATH="$CLI_PREFIX/dview"
  info "安装 CLI 到: $CLI_PATH"
  fetch_or_copy "bin/dview" "$CLI_PATH"
  chmod +x "$CLI_PATH"
  case ":$PATH:" in
    *":$CLI_PREFIX:"*) ;;
    *)
      warn "$CLI_PREFIX 不在 PATH 中；请把它加进 PATH，或重开终端（安装脚本会写入 shell rc）"
      ;;
  esac
fi

# ---- 收集配置 ----
if [ -z "$URL" ] || [ -z "$TOKEN" ]; then
  if [ -t 0 ]; then
    [ -z "$URL" ]   && read -r -p "请输入服务地址 DVIEW_URL (如 https://view.example.com): " URL
    [ -z "$TOKEN" ] && read -r -p "请输入上传 token DVIEW_TOKEN: " TOKEN
  else
    warn "未提供 DVIEW_URL / DVIEW_TOKEN，且非交互环境，跳过环境变量写入。"
    warn "稍后请手动 export，或重新运行: bash install-skill.sh --url ... --token ..."
  fi
fi

# ---- 写入 shell 配置 ----
if [ -n "$URL" ] && [ -n "$TOKEN" ]; then
  case "${SHELL:-}" in
    *zsh) RC="$HOME/.zshrc" ;;
    *bash) RC="$HOME/.bashrc" ;;
    *) RC="$HOME/.profile" ;;
  esac
  touch "$RC"
  if grep -q "# >>> vibeview >>>" "$RC" 2>/dev/null; then
    # portable delete of marker block
    if sed --version >/dev/null 2>&1; then
      sed -i.bak '/# >>> vibeview >>>/,/# <<< vibeview <<</d' "$RC" && rm -f "$RC.bak"
    else
      sed -i.bak '/# >>> vibeview >>>/,/# <<< vibeview <<</d' "$RC" && rm -f "$RC.bak"
    fi
  fi
  {
    echo "# >>> vibeview >>>"
    echo "export DVIEW_URL=\"$URL\""
    echo "export DVIEW_TOKEN=\"$TOKEN\""
    if [ "$INSTALL_CLI" = "1" ]; then
      echo "export PATH=\"$CLI_PREFIX:\$PATH\""
    fi
    echo "# <<< vibeview <<<"
  } >> "$RC"
  info "已写入环境变量到 $RC（重开终端或执行 source $RC 生效）"
fi

echo ""
info "安装完成 ✅"
[ "$INSTALL_CLAUDE" = "1" ] && echo "  Skill 位置: $DEST"
[ "$INSTALL_CLAUDE" = "1" ] && echo "  命令位置:   $COMMANDS_DIR/$COMMAND_NAME.md"
[ -n "$CLI_PATH" ] && echo "  CLI 位置:   $CLI_PATH"
echo "  使用方法:"
[ "$INSTALL_CLAUDE" = "1" ] && echo "    Claude Code: /$COMMAND_NAME <页面描述>"
[ -n "$CLI_PATH" ] && echo "    CLI:         dview upload <文件路径>"
[ "$INSTALL_CLAUDE" = "1" ] && echo "    Skill 脚本:  bash $DEST/upload.sh <文件路径>"
echo "  其它 AI / CI: 见仓库 docs/integrations.md 与 AGENTS.md"
