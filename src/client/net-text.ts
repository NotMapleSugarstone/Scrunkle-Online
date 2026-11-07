import { STORAGE_PREFIX } from '../game/page.ts';

const NET_LANG_KEY = `${STORAGE_PREFIX}.netLang`;

export type NetLang = 'zh' | 'en';

const EN = {
  online: 'Online',
  name: 'Name',
  nameHint: 'Your Scratch username, or player and a number',
  host: 'Host an online game',
  roomCode: 'Room code',
  join: 'Join',
  code: 'Code',
  inputDelay: 'Input delay',
  start: 'Start',
  waitHost: 'Waiting for the host to start.',
  waitJoin: 'Waiting for another player to join with the code.',
  leaveRoom: 'Leave room',
  open: 'Open',
  you: 'you',
  hostTag: 'host',
  reconnecting: 'reconnecting',
  connecting: 'connecting',
  direct: 'direct link',
  relay: 'relayed',
  noticeTitle: 'Playing online',
  notice: "Online games connect you straight to the other players in your room (peer to peer, through WebRTC). This means you and they can see each other's IP addresses. Only play online with people you are comfortable sharing that with.",
  understand: 'I understand',
  cancel: 'Cancel',
  offline: 'Online play is not set up for this copy of the game.',
  nameRule: 'Names use letters, numbers, _ and -, as Scratch usernames do.',
  opening: 'Opening a room...',
  joining: 'Joining...',
  badCode: 'A room code is six letters and numbers.',
  connectionLost: 'Connection lost; reconnecting...',
  disconnected: 'Disconnected from the room.',
  startedWithout: 'The game started without you.',
  language: 'Language',
  switchLanguage: 'Switch to Chinese',
  playOffline: 'Play offline',
  on: 'On',
  off: 'Off',
  replays: 'Replays',
  none: 'None',
  touchControls: 'Touch controls',
  display: 'Display',
  displayHint: 'F2: next display mode',
  wearHats: 'Actually wear hats',
  wearHatsHint: "Each fighter's hat sits on its head and turns with it",
  controls: 'Controls',
  yourControls: 'Your controls',
  keys: 'Keys',
  touchButtons: 'Touch buttons',
  keysNote: 'Your keys for Player 1 and for your own player online.',
  roomKeysNote: 'Your own keys from Controls play your player. Arrows move, N attacks, M uses a special, B shields and V pauses unless you changed them.',
  resetDefaults: 'Reset to default',
  done: 'Done',
  tapSwap: 'Tap two buttons to swap them.',
  pressKey: 'Press a key',
  keyNone: 'None',
  upload: 'Upload',
  noReplays: 'No replays yet. After a match the game asks whether to save one.',
  delete: 'Delete',
  keep: 'Keep',
  deleteReplay: 'Delete this replay?',
  rename: 'Rename',
  watch: 'Watch',
  download: 'Download',
  videoOfReplay: 'A video of the replay',
  replayFile: 'The replay as a file another player can upload',
  videoQuality: 'Video quality',
  controllers: 'Controllers',
  controller: 'Controller',
  noController: 'No controller found. Connect one and press a button on it.',
  notUsed: 'Not used',
  couldNotLoad: 'Could not load the game: {error}',
  cannotRecord: 'This browser cannot record video.',
  replayMissing: 'This replay is not in this browser anymore.',
  replayDifferentVersion: 'A different version of the game saved this replay, so it may not play the same.',
  replayModeVersus: 'Versus',
  replayModeCpu: 'Against the CPU',
  replayModeStory: 'Story',
  replayModeTower: 'Tower',
  replayModeClassic: 'Classic',
  replayModeRosterFight: 'Roster fight',
  saved: 'Saved {name}.',
  savedWebm: 'Saved {name}. This browser records WebM rather than MP4.',
  displayAnnounce: 'Display: {name}',
  leaveGame: 'Leave game',
  backToStart: 'Back to the start screen',
  relayed: 'relayed',
  hudConnecting: 'connecting',
  rollbacks: 'rollbacks',
  waitingFor: 'Waiting for {names}...',
  leftGame: '{name} left the game.',
  outOfSync: 'Games went out of sync at frame {frame}. Please start a new room.',
  waitingTitle: 'Waiting for {name}',
  waitingText: 'Their game has not answered for {seconds} seconds. It may only be a slow connection.',
  waitingTextHost: 'Their game has not answered for {seconds} seconds. {host}, the host, can continue without them.',
  continueWithout: 'Continue without {name}',
  saveReplay: 'Save replay',
  noThanks: 'No thanks',
  saveReplayQuestion: 'Save a replay of {fighters} ({time})?',
  replaySaved: 'Replay saved under Replays on the start screen.',
  replaySaveFailed: 'The replay could not be saved: {error}',
  replayPrefix: 'Replay: {name}',
  cannotPlayReplay: 'This replay cannot play in this version of the game.',
  replayMismatch: 'From {time} on, this replay no longer plays the same as the match did.',
  endReplay: 'End of the replay. Play starts over.',
  replayRecording: 'Recording {quality} video',
  cancelRecording: 'Stop recording (Escape)',
  exit: 'Exit',
  exitHint: 'Back to the Replays screen (Escape)',
  pauseAction: 'Pause',
  play: 'Play',
  step: 'Step',
  back: 'Back',
  seekHint: 'Drag to move through the match',
  replayPauseHint: 'Stop the replay, or play it again (Space)',
  replayBackHint: 'One frame back (Left arrow)',
  replayStepHint: 'One frame forward (Right arrow)',
  replaySpeedHint: 'Playback speed',
  smooth: 'Smooth',
  oldFlashGame: 'Old flash game',
  handheld: 'Handheld',
  actionUp: 'Up',
  actionDown: 'Down',
  actionLeft: 'Left',
  actionRight: 'Right',
  actionAttack: 'Attack',
  actionSpecial: 'Special',
  actionShield: 'Shield',
  actionPause: 'Pause',
  paused: 'Paused',
  resume: 'Resume',
  quit: 'Quit',
  pauseHint: '{pauseKey} or Esc to resume, {quitKey}: {quit}',
  openTextFile: 'Open a .txt file',
  submitAnswer: 'Submit answer',
  onlinePrefix: 'Online ',
  players: 'Players',
  savedOn: 'saved',
  keyUpArrow: 'Up arrow',
  keyDownArrow: 'Down arrow',
  keyLeftArrow: 'Left arrow',
  keyRightArrow: 'Right arrow',
  keySpace: 'Space',
} as const;

export type NetTextKey = keyof typeof EN;

const ZH: Record<NetTextKey, string> = {
  online: '在线',
  name: '名称',
  nameHint: '你的 Scratch 用户名，或 player 加数字',
  host: '创建在线游戏',
  roomCode: '房间代码',
  join: '加入',
  code: '房间代码',
  inputDelay: '输入延迟',
  start: '开始',
  waitHost: '等待房主开始游戏。',
  waitJoin: '等待另一名玩家使用房间代码加入。',
  leaveRoom: '离开房间',
  open: '空位',
  you: '你',
  hostTag: '房主',
  reconnecting: '重新连接中',
  connecting: '连接中',
  direct: '直连',
  relay: '中继',
  noticeTitle: '在线游戏',
  notice: '在线游戏会通过 WebRTC 直接连接房间内的其他玩家（点对点）。这意味着你和他们可以互相看到 IP 地址。请只与你愿意共享该信息的人一起游玩。',
  understand: '我明白了',
  cancel: '取消',
  offline: '此版本尚未配置在线游戏。',
  nameRule: '名称只能使用字母、数字、_ 和 -，与 Scratch 用户名一致。',
  opening: '正在创建房间……',
  joining: '正在加入……',
  badCode: '房间代码为六位字母或数字。',
  connectionLost: '连接中断，正在重新连接……',
  disconnected: '已断开与房间的连接。',
  startedWithout: '游戏已开始，但你不在本局中。',
  language: '语言',
  switchLanguage: '切换到英文',
  playOffline: '离线游戏',
  on: '开',
  off: '关',
  replays: '回放',
  none: '无',
  touchControls: '触屏控制',
  display: '显示',
  displayHint: 'F2：切换显示模式',
  wearHats: '实际戴上帽子',
  wearHatsHint: '每位斗士的帽子都会戴在头上并随之转动',
  controls: '操作',
  yourControls: '你的操作',
  keys: '按键',
  touchButtons: '触屏按钮',
  keysNote: '你的按键用于玩家 1，以及在线时你自己的角色。',
  roomKeysNote: '你自己的按键会控制你的角色。方向键移动，N 攻击，M 使用必杀，B 防御，V 暂停；如果你改过按键，则以你的设置为准。',
  resetDefaults: '恢复默认',
  done: '完成',
  tapSwap: '点击两个按钮以交换它们。',
  pressKey: '按下按键',
  keyNone: '无',
  upload: '上传',
  noReplays: '还没有回放。每场比赛结束后，游戏会询问是否保存。',
  delete: '删除',
  keep: '保留',
  deleteReplay: '删除这个回放？',
  rename: '重命名',
  watch: '观看',
  download: '下载',
  videoOfReplay: '回放的视频',
  replayFile: '可作为文件供其他玩家上传的回放',
  videoQuality: '视频质量',
  controllers: '控制器',
  controller: '控制器',
  noController: '未检测到控制器。请连接一个并按下其上的按钮。',
  notUsed: '未使用',
  couldNotLoad: '无法加载游戏：{error}',
  cannotRecord: '此浏览器无法录制视频。',
  replayMissing: '此回放已不在该浏览器中。',
  replayDifferentVersion: '此回放由另一个版本的游戏保存，播放效果可能不同。',
  replayModeVersus: '对战',
  replayModeCpu: '对战电脑',
  replayModeStory: '剧情',
  replayModeTower: '高塔',
  replayModeClassic: '经典',
  replayModeRosterFight: '阵容战',
  saved: '已保存 {name}。',
  savedWebm: '已保存 {name}。此浏览器录制的是 WebM，而非 MP4。',
  displayAnnounce: '显示：{name}',
  leaveGame: '离开游戏',
  backToStart: '返回开始界面',
  relayed: '中继',
  hudConnecting: '连接中',
  rollbacks: '回滚',
  waitingFor: '正在等待 {names}……',
  leftGame: '{name} 离开了游戏。',
  outOfSync: '游戏在第 {frame} 帧失去同步。请创建新房间。',
  waitingTitle: '正在等待 {name}',
  waitingText: '对方已经 {seconds} 秒没有响应，可能只是连接较慢。',
  waitingTextHost: '对方已经 {seconds} 秒没有响应。房主 {host} 可以继续而不等待对方。',
  continueWithout: '不等待 {name}，继续',
  saveReplay: '保存回放',
  noThanks: '不用了',
  saveReplayQuestion: '保存 {fighters}（{time}）的回放？',
  replaySaved: '回放已保存到开始界面的“回放”中。',
  replaySaveFailed: '无法保存回放：{error}',
  replayPrefix: '回放：{name}',
  cannotPlayReplay: '此回放在当前版本中无法播放。',
  replayMismatch: '从 {time} 开始，此回放与当时的比赛不再一致。',
  endReplay: '回放结束。将从头开始播放。',
  replayRecording: '正在录制 {quality} 视频',
  cancelRecording: '停止录制（Esc）',
  exit: '退出',
  exitHint: '返回回放界面（Esc）',
  pauseAction: '暂停',
  play: '播放',
  step: '下一帧',
  back: '上一帧',
  seekHint: '拖动以浏览比赛',
  replayPauseHint: '暂停回放，或再次播放（空格）',
  replayBackHint: '后退一帧（左箭头）',
  replayStepHint: '前进一帧（右箭头）',
  replaySpeedHint: '播放速度',
  smooth: '平滑',
  oldFlashGame: '旧 Flash 游戏',
  handheld: '掌机',
  actionUp: '上',
  actionDown: '下',
  actionLeft: '左',
  actionRight: '右',
  actionAttack: '攻击',
  actionSpecial: '必杀',
  actionShield: '防御',
  actionPause: '暂停',
  paused: '已暂停',
  resume: '继续',
  quit: '退出',
  pauseHint: '{pauseKey} 或 Esc 继续，{quitKey}：{quit}',
  openTextFile: '打开 .txt 文件',
  submitAnswer: '提交答案',
  onlinePrefix: '在线 ',
  players: '玩家',
  savedOn: '保存于',
  keyUpArrow: '上箭头',
  keyDownArrow: '下箭头',
  keyLeftArrow: '左箭头',
  keyRightArrow: '右箭头',
  keySpace: '空格',
};

const ZH_REASONS: Record<string, string> = {
  'The lobby sent an answer this version cannot read.': '大厅返回了此版本无法读取的响应。',
  'The matchmaking server could not be reached.': '无法连接匹配服务器。',
  'Too many rooms are open right now. Try again in a minute.': '当前开放的房间太多，请稍后再试。',
  'This address has three rooms open already. Use one, or wait for one to lapse.': '此地址已有三个房间开放。请使用其中一个，或等待其过期。',
  'The rooms are full for today. They open again at midnight UTC.': '今天的房间已满，将在 UTC 午夜重新开放。',
  'No room has that code. A code lasts 30 minutes.': '没有房间使用该代码。房间代码有效期为 30 分钟。',
  'That room runs a different version of the game. Everyone should reload the page.': '该房间运行的是另一个游戏版本。请所有人刷新页面。',
  'The request could not be read.': '无法读取请求。',
  'A code is six letters and numbers.': '房间代码为六位字母或数字。',
  'This room was made by a different version of the game. Reload the page.': '该房间由另一个游戏版本创建。请刷新页面。',
  'That seat is no longer held.': '该座位已不再保留。',
  'This game has already started.': '游戏已经开始。',
  'This room is full.': '房间已满。',
  'Say hello first.': '请先发送问候消息。',
  'The names of Scratch Team members cannot be used.': '不能使用 Scratch 团队成员的名称。',
};

const UNKNOWN_SCRATCH_NAME = /^There is no Scratch account named (.+)\. Use your Scratch username, or a name like player1234\.$/;

const ACTION_KEYS: Record<string, NetTextKey> = {
  Up: 'actionUp',
  Down: 'actionDown',
  Left: 'actionLeft',
  Right: 'actionRight',
  Attack: 'actionAttack',
  Special: 'actionSpecial',
  Shield: 'actionShield',
  Pause: 'actionPause',
};

const DISPLAY_KEYS: Record<string, NetTextKey> = {
  smooth: 'smooth',
  flash: 'oldFlashGame',
  handheld: 'handheld',
};

const MODE_KEYS: Record<string, NetTextKey> = {
  Versus: 'replayModeVersus',
  'Against the CPU': 'replayModeCpu',
  Story: 'replayModeStory',
  Tower: 'replayModeTower',
  Classic: 'replayModeClassic',
  'Roster fight': 'replayModeRosterFight',
};

const KEY_KEYS: Record<string, NetTextKey> = {
  'up arrow': 'keyUpArrow',
  'down arrow': 'keyDownArrow',
  'left arrow': 'keyLeftArrow',
  'right arrow': 'keyRightArrow',
  space: 'keySpace',
};

export function loadNetLang(): NetLang {
  try {
    return localStorage.getItem(NET_LANG_KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function saveNetLang(lang: NetLang): void {
  try {
    localStorage.setItem(NET_LANG_KEY, lang);
  } catch {
  }
}

export function netText(lang: NetLang, key: NetTextKey): string {
  return (lang === 'en' ? EN : ZH)[key];
}

export function currentText(key: NetTextKey): string {
  return netText(loadNetLang(), key);
}

export function formatText(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}

export function currentFormat(key: NetTextKey, vars: Record<string, string | number>): string {
  return formatText(currentText(key), vars);
}

export function netFrameDelay(lang: NetLang, frames: number): string {
  const ms = Math.round((frames * 1000) / 30);
  return lang === 'en' ? `${frames} frame${frames === 1 ? '' : 's'} (${ms} ms)` : `${frames} 帧（${ms} 毫秒）`;
}

export function displayLabel(mode: string): string {
  return currentText(DISPLAY_KEYS[mode] ?? 'smooth');
}

export function modeLabel(mode: string): string {
  return currentText(MODE_KEYS[mode] ?? 'replayModeVersus');
}

export function actionLabel(action: string): string {
  return currentText(ACTION_KEYS[action] ?? 'actionAttack');
}

export function keyLabel(name: string): string {
  if (!name) return currentText('keyNone');
  const known = KEY_KEYS[name.toLowerCase()];
  return known ? currentText(known) : name[0].toUpperCase() + name.slice(1);
}

export function netReason(lang: NetLang, reason: string): string {
  if (lang === 'en') return reason;
  const known = ZH_REASONS[reason];
  if (known) return known;
  const name = UNKNOWN_SCRATCH_NAME.exec(reason);
  return name ? `不存在名为 ${name[1]} 的 Scratch 账号。请使用你的 Scratch 用户名，或类似 player1234 的名称。` : reason;
}
