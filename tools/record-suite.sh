#!/usr/bin/env bash
# 用 tools/drive.ts 录制 tests/scenarios 中的一致性场景。修改菜单路线后，
# 在项目根目录运行它；一致性运行只需要保存的文件。
set -e
INTRO="wait/700 space*3/60 wait/100 space*3/60 wait/150 N*3/40"
VS="$INTRO N*3/40 down_arrow*3/30 N*3/40 N*3/40"
drive() { npx tsx tools/drive.ts "$2" "$1" "$3" | tail -1; }

# 两位玩家：默认斗士和舞台，然后用各自按键选择其他斗士和舞台。
drive versus "$VS N*3/40 N*3/40 F*3/40 N*3/60 wait/150 fuzz/2400 wait/100" 3
drive versus-2 "$VS right_arrow*3/20 right_arrow*3/20 right_arrow*3/30 N*3/40 right_arrow*3/20 right_arrow*3/20 down_arrow*3/20 N*3/40 A*3/20 A*3/20 A*3/20 F*3/40 N*3/60 wait/150 fuzz/2000 wait/100" 5
drive versus-3 "$VS down_arrow*3/20 right_arrow*3/20 right_arrow*3/20 right_arrow*3/20 right_arrow*3/30 N*3/40 right_arrow*3/20 right_arrow*3/20 right_arrow*3/20 right_arrow*3/20 right_arrow*3/30 N*3/40 S*3/20 D*3/20 D*3/20 D*3/20 F*3/40 N*3/60 wait/150 fuzz/2000 wait/100" 11
drive versus-4 "$VS left_arrow*3/30 N*3/40 down_arrow*3/20 left_arrow*3/20 left_arrow*3/30 N*3/40 S*3/20 A*3/20 A*3/20 A*3/20 A*3/20 F*3/40 N*3/60 wait/150 fuzz/2000 wait/100" 13

# 一位玩家在另一舞台和斗士上对战 CPU。
drive cpu "$INTRO N*3/40 N*3/40 N*3/40 right_arrow*3/20 right_arrow*3/30 N*3/40 down_arrow*3/20 right_arrow*3/20 right_arrow*3/20 right_arrow*3/30 N*3/40 N*3/60 wait/150 fuzz/1800 wait/100" 17

# 从菜单进入训练、故事模式和塔，然后在其中随机按键。
drive training "$INTRO N*3/40 down_arrow*3/20 down_arrow*3/30 N*3/60 N*3/40 N*3/40 N*3/60 wait/150 fuzz/1500 wait/100" 19
drive story "$INTRO N*3/40 down_arrow*3/20 down_arrow*3/20 down_arrow*3/30 N*3/60 wait/100 N*3/40 N*3/40 N*3/40 N*3/40 N*3/40 wait/100 fuzz/1500 wait/100" 23
drive tower "$INTRO down_arrow*3/30 N*3/60 wait/100 N*3/40 N*3/40 N*3/40 N*3/40 wait/100 fuzz/1500 wait/100" 29

# 设置和额外内容：用玩家 1 的按键浏览菜单。
drive settings "$INTRO down_arrow*3/20 down_arrow*3/20 down_arrow*3/30 N*3/60 down_arrow*3/20 down_arrow*3/20 right_arrow*3/20 left_arrow*3/20 N*3/40 down_arrow*3/20 N*3/40 M*3/40 M*3/40 M*3/60 down_arrow*3/20 down_arrow*3/30 N*3/60 wait/100" 31
drive extras "$INTRO down_arrow*3/20 down_arrow*3/30 N*3/60 down_arrow*3/20 N*3/60 wait/100 M*3/40 down_arrow*3/20 down_arrow*3/20 N*3/60 wait/100 M*3/40 down_arrow*3/20 N*3/60 wait/150 M*3/60 wait/100" 37
