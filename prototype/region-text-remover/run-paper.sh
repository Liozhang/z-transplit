#!/usr/bin/env bash
# 对一篇论文执行完整测试：OpenDataLoader 解析 → 提取区域 → 删除 → 验收探针。
# 用法: bash run-paper.sh <名称>   （要求 work/<名称>.pdf 已存在）
set -u
NAME="$1"
# 类路径必须是 Windows 风格路径；Git Bash 的 dirname 会给出 POSIX 风格，Java 无法识别
ROOT="D:/github_code/z-transplit/prototype/region-text-remover"
WORK="$ROOT/work"
ODL_JAR="D:/github_code/z-transplit/src/core/pdf/lib/opendataloader-pdf-cli.jar"
CP="$ROOT/build;$ROOT/lib/pdfbox-2.0.37.jar;$ROOT/lib/fontbox-2.0.37.jar;$ROOT/lib/commons-logging-1.2.jar"

cd "$WORK" || exit 1

echo "===== $NAME ====="
java -jar "$ODL_JAR" -f json "$NAME.pdf" 2>/dev/null | tail -1
python "$ROOT/extract_rects.py" "$NAME.json" "$NAME.rects"

java -cp "$CP" RegionTextRemover "$NAME.pdf" "$NAME.rects" "$NAME-clean.pdf" 2>&1 |
  grep -a "done" | sed 's/\[remover\] //'

java -cp "$CP" Probe "$NAME.pdf" "$NAME-clean.pdf" "$NAME.rects" 2>/dev/null |
  grep -aE "PROBE|VERDICT"
