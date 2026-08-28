# 单词花园 Word Garden

给孩子的"活的英语单词本"：自己查、自己拍，收进花园；每天浇一次水（复习），
系统会自动让不熟的词多出现、记牢的词少出现。

跑在家里的 Mac mini 上，家里任何设备用浏览器打开就能用。

## 跑起来

```bash
npm install
cp .env.example .env      # 填上 ANTHROPIC_API_KEY
npm start                 # 打开 http://localhost:5173
```

没有 API key 也能跑：单词本、浇水复习都正常，只有查词和拍照识物会提示去配 key。

## 女儿从别的电脑访问（Tailscale）

Mac mini 保持开机、服务在跑，MacBook Air 上直接打开：

```
http://100.103.126.20:5173
```

想要更好的体验（能"添加到程序坞"当独立 App 用、断网也能打开已收的词），
在 Mac mini 上开一次 HTTPS：

```bash
tailscale serve --bg 5173
# 之后地址变成 https://chriss-mac-mini.tail19f969.ts.net
```

Tailscale 是点对点的，不在同一个 WiFi 也能用——孩子带电脑出门照样能开。
前提是 Mac mini 别休眠（`caffeinate -s` 或系统设置里关掉自动睡眠）。

## 数据在哪

- `data/garden.json` —— 所有单词、复习进度、活跃天数。**这个文件就是全部家当**，
  复制走就是备份。已经在 `.gitignore` 里，不会进公开仓库。
- `data/photos/` —— 孩子自己拍的照片。

浏览器只存一份只读快照（离线时能看），真正的数据永远以服务端文件为准。

## 目录

```
server.js          HTTP 服务 + API 路由
lib/store.js       单词本存储、Leitner 复习盒子
lib/ai.js          调 Claude：查词 / 拍照识物 / 词表 OCR
public/            前端（原生 JS，无构建步骤）
docs/              风格小样
```

## 复习是怎么自适应的

每个词有一个 1-5 的"盒子"。答对升一格，答错回第一格，犹豫超过 8 秒不升级。
盒子越高，下次出现间隔越长（0 / 1 / 2 / 4 / 8 / 16 天）。
答错的词 10 分钟后就会再出现一次，不用等到明天。

题型跟着熟练度走：刚收的词只做选择题，熟一点了挖例句填空，记牢了才让拼写。
