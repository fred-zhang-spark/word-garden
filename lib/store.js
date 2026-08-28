// 单词本存储：一个 JSON 文件 + 一个照片目录，都在 DATA_DIR 下。
// 之所以不用 localStorage 做唯一存储：清浏览记录、换浏览器、Safari 的 7 天存储回收
// 都会让孩子攒的词消失。文件放在自己机器上，随时能备份，以后搬去 iOS App 也是这份数据。
import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const DB_FILE = path.join(DATA_DIR, "garden.json");
const PHOTO_DIR = path.join(DATA_DIR, "photos");

const EMPTY = {
  version: 1,
  profiles: [{ id: "p1", name: "小园丁", emoji: "🌱" }],
  words: [],
  activity: [], // 用过的日子（本地日期），用来算连续天数
};

let cache = null;
let writeChain = Promise.resolve();

export async function init() {
  await fs.mkdir(PHOTO_DIR, { recursive: true });
  try {
    cache = JSON.parse(await fs.readFile(DB_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    cache = structuredClone(EMPTY);
    await flush();
  }
  // 老数据补字段，避免升级后炸掉
  cache.profiles ||= structuredClone(EMPTY.profiles);
  cache.words ||= [];
  cache.activity ||= [];
  return cache;
}

// 原子写：先写临时文件再 rename，中途断电不会写坏原文件
async function flush() {
  const tmp = `${DB_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
  await fs.rename(tmp, DB_FILE);
}

// 串行化写入，避免并发请求互相覆盖
function save() {
  writeChain = writeChain.then(flush, flush);
  return writeChain;
}

export function snapshot(profileId) {
  const words = cache.words.filter((w) => w.profileId === profileId);
  return { profiles: cache.profiles, profileId, words, activity: cache.activity };
}

// 记一笔"今天来过"。连续天数只看有没有来，不看做了多少——
// 孩子哪天只收了一个词，也算数。
function markActive() {
  const today = new Date().toLocaleDateString("sv");
  if (cache.activity.at(-1) !== today) {
    cache.activity.push(today);
    if (cache.activity.length > 400) cache.activity = cache.activity.slice(-400);
  }
}

export function listWords(profileId) {
  return cache.words.filter((w) => w.profileId === profileId);
}

const DAY = 86400000;
// Leitner 盒子：答对往上升一格，答错回第一格。间隔对孩子来说够用，
// 又不会像背单词软件那样把复习堆成大山。
export const INTERVALS_DAYS = [0, 1, 2, 4, 8, 16];

export async function addWords(profileId, items, source) {
  const now = Date.now();
  const existing = new Map(
    listWords(profileId).map((w) => [w.en.toLowerCase(), w]),
  );
  const added = [];
  const skipped = [];

  for (const item of items) {
    const en = String(item.en || "").trim();
    if (!en) continue;
    const dup = existing.get(en.toLowerCase());
    if (dup) {
      skipped.push(dup);
      continue;
    }
    const word = {
      id: `w_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      profileId,
      en,
      zh: item.zh || "",
      phonetic: item.phonetic || "",
      pos: item.pos || "",
      example_en: item.example_en || "",
      example_zh: item.example_zh || "",
      emoji: item.emoji || "🌿",
      photo: item.photo || null,
      source: source || "search",
      createdAt: now,
      box: 1,
      dueAt: now,
      seenCount: 0,
      wrongCount: 0,
      lastResult: null,
    };
    cache.words.push(word);
    existing.set(en.toLowerCase(), word);
    added.push(word);
  }
  if (added.length) {
    markActive();
    await save();
  }
  return { added, skipped };
}

export async function reviewWord(profileId, id, correct, hesitated) {
  const word = cache.words.find((w) => w.id === id && w.profileId === profileId);
  if (!word) return null;

  word.seenCount += 1;
  word.lastResult = correct ? "right" : "wrong";
  if (correct) {
    // 犹豫了就原地踏步——不惩罚，只是这个词还没到"记牢"的程度
    if (!hesitated) word.box = Math.min(word.box + 1, INTERVALS_DAYS.length - 1);
  } else {
    word.wrongCount += 1;
    word.box = 1;
  }
  markActive();
  const days = INTERVALS_DAYS[word.box];
  // 答错的词今天晚点还会再出现一次，别等到明天
  word.dueAt = correct ? Date.now() + days * DAY : Date.now() + 10 * 60 * 1000;
  await save();
  return word;
}

export async function removeWord(profileId, id) {
  const i = cache.words.findIndex((w) => w.id === id && w.profileId === profileId);
  if (i < 0) return false;
  const [gone] = cache.words.splice(i, 1);
  if (gone.photo) {
    await fs.rm(path.join(PHOTO_DIR, path.basename(gone.photo)), { force: true });
  }
  await save();
  return true;
}

export async function savePhoto(base64, ext = "jpg") {
  const name = `ph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await fs.writeFile(path.join(PHOTO_DIR, name), Buffer.from(base64, "base64"));
  return `/photos/${name}`;
}

export function photoPath(name) {
  return path.join(PHOTO_DIR, path.basename(name));
}
