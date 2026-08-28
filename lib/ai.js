// 调 Claude：查词、拍照识物、拍词表 OCR。
// 全部要求结构化输出，前端拿到的永远是同一个 word 形状。
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const MODEL = process.env.WORD_GARDEN_MODEL || "claude-opus-5";

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export function hasKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const WordSchema = z.object({
  en: z.string().describe("英文单词或短语，小写，除非是专有名词"),
  phonetic: z.string().describe("英式或美式音标，带斜杠，如 /ˈbʌtəflaɪ/"),
  pos: z.string().describe("词性缩写：n. / v. / adj. / adv. 等"),
  zh: z.string().describe("中文释义，一到四个字最好，孩子能懂的说法"),
  example_en: z.string().describe("一句适合 9-12 岁孩子的简单例句，不超过 12 个词"),
  example_zh: z.string().describe("例句的中文翻译"),
  emoji: z.string().describe("一个最能代表这个词的 emoji"),
});

const LookupSchema = z.object({
  found: z.boolean().describe("能不能找到对应的英文词；查询看不懂时为 false"),
  message: z.string().describe("found 为 false 时，给孩子一句中文提示；否则留空"),
  word: WordSchema.nullable(),
});

const ItemsSchema = z.object({
  items: z.array(WordSchema),
});

const KID_CONTEXT = `你在帮一个 9-12 岁、母语是中文、正在学英语的孩子建自己的单词本。
要求：
- 给最常用、最日常的那个说法，不要生僻词、不要一次给一堆同义词。
- 例句短、具体、有画面感，用孩子生活里会遇到的场景，不要教科书腔。
- 中文释义用孩子能懂的说法，不要照抄词典的长解释。
- 音标要准确。`;

async function ask({ messages, schema, maxTokens = 2000 }) {
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: maxTokens,
    system: KID_CONTEXT,
    messages,
    output_config: {
      effort: "low", // 孩子在等，这类任务不需要深想
      format: zodOutputFormat(schema),
    },
  });

  if (response.parsed_output) return response.parsed_output;

  // 兜底：结构化解析失败时，自己从文本里抠 JSON
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("模型没有返回可解析的结果");
  return schema.parse(JSON.parse(match[0]));
}

// 中文（或任何语言）查一个词
export async function lookup(query) {
  return ask({
    schema: LookupSchema,
    messages: [
      {
        role: "user",
        content: `孩子想知道「${query}」用英语怎么说。给出对应的英文单词。
如果这段输入看不懂、或者不是一个能翻译成单词的东西，把 found 设为 false，并在 message 里用一句中文告诉孩子换个说法试试。`,
      },
    ],
  });
}

// 拍实物 → 认出主要物体，给英文词
export async function identifyPhoto(base64, mediaType) {
  const result = await ask({
    schema: ItemsSchema,
    maxTokens: 3000,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          {
            type: "text",
            text: `孩子拍了这张照片，想知道里面的东西英语叫什么。
认出照片里最主要的 1-3 个物体，按显眼程度排序，第一个是最主要的那个。
只给看得清楚、能确定的东西；照片糊或者认不出来时返回空数组。`,
          },
        ],
      },
    ],
  });
  return result.items.slice(0, 3);
}

// 拍纸质单词表 → 批量识别
export async function readWordList(base64, mediaType) {
  const result = await ask({
    schema: ItemsSchema,
    maxTokens: 8000,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          {
            type: "text",
            text: `这是一张纸质单词表的照片（可能是课本、作业本或老师发的讲义）。
把上面的英文单词按原顺序识别出来，每个都补上音标、词性、中文释义和例句。
只要单词，不要句子、标题、页码。最多 30 个。看不清的跳过，不要猜。`,
          },
        ],
      },
    ],
  });
  return result.items.slice(0, 30);
}
