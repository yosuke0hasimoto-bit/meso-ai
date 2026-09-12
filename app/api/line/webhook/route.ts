import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase/client';

export const runtime = 'nodejs';

type RegistrationState = {
  step: number;
  draft: Record<string, string>;
};

type ConsultationHistory = {
  user_message: string;
  ai_response: string;
};

const QUESTIONS = [
  {
    field: 'name',
    prompt: 'まず、愛犬の名前を教えてね🐶',
  },
  {
    field: 'breed',
    prompt: '犬種は？',
  },
  {
    field: 'age_years',
    prompt: '何歳？\n数字だけでOKだよ。例：3',
  },
  {
    field: 'gender',
    prompt: '性別は？\n「オス」か「メス」で教えてね。',
  },
  {
    field: 'weight_kg',
    prompt: '体重は何kg？\n例：5.5',
  },
  {
    field: 'personality',
    prompt: 'どんな性格？\n例：甘えん坊、怖がり、人が好き',
  },
  {
    field: 'likes',
    prompt: '好きなものは？🍖\nおやつ・おもちゃ・遊びなど何でもOK！',
  },
  {
    field: 'dislikes',
    prompt: '苦手なものはある？\n例：大きな音、知らない人、他の犬',
  },
  {
    field: 'current_issue',
    prompt:
      '今いちばん困っていることはある？\nなければ「特になし」でOK！',
  },
] as const;

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const signature = request.headers.get('x-line-signature') ?? '';

    const channelSecret = process.env.LINE_CHANNEL_SECRET;

    if (!channelSecret) {
      console.error('LINE_CHANNEL_SECRET is missing');
      return NextResponse.json(
        { error: 'server configuration error' },
        { status: 500 }
      );
    }

    const hash = crypto
      .createHmac('sha256', channelSecret)
      .update(body)
      .digest('base64');

    const expected = Buffer.from(hash);
    const received = Buffer.from(signature);

    if (
      expected.length !== received.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      return NextResponse.json(
        { error: 'invalid signature' },
        { status: 401 }
      );
    }

    const data = JSON.parse(body);
    const events = data.events ?? [];

    for (const event of events) {
      if (
        event.type === 'message' &&
        event.message?.type === 'text' &&
        event.source?.userId
      ) {
        await handleMessage(
          event.source.userId,
          event.message.text.trim(),
          event.replyToken
        );
      }
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook error:', error);

    return NextResponse.json(
      { error: 'internal server error' },
      { status: 500 }
    );
  }
}

async function handleMessage(
  lineUserId: string,
  text: string,
  replyToken: string
) {
  if (!text) {
    await replyMessage(
      replyToken,
      'メッセージが空みたい🐶\nもう一度送ってみてね。'
    );
    return;
  }

  const user = await ensureUser(lineUserId);

  if (!user) {
    await replyMessage(
      replyToken,
      'うまく読み込めなかったみたい💦\nもう一度送ってみてね。'
    );
    return;
  }

  /*
   * すでに犬が登録済みか確認
   * 現在は1ユーザーにつき1頭のMVP仕様
   */
  const { data: existingDog, error: dogError } = await supabase
    .from('dogs')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (dogError) {
    console.error('Dog lookup error:', dogError);

    await replyMessage(
      replyToken,
      'プロフィールの読み込みでエラーが起きたみたい💦\n少ししてからもう一度試してね。'
    );
    return;
  }

  /*
   * 登録済みなら通常のAI相談
   */
  if (existingDog) {
    const { data: history, error: historyError } = await supabase
      .from('consultations')
      .select('user_message, ai_response')
      .eq('dog_id', existingDog.id)
      .order('created_at', { ascending: false })
      .limit(6);

    if (historyError) {
      console.error('History lookup error:', historyError);
    }

    const orderedHistory: ConsultationHistory[] = (
      history ?? []
    ).reverse();

    const aiReply = await askAI(
      existingDog,
      text,
      orderedHistory
    );

    await replyMessage(replyToken, aiReply);

    /*
     * MVPではcategory/risk_levelは仮置き。
     * 後でAI分類に変更可能。
     */
    const { error: consultationError } = await supabase
      .from('consultations')
      .insert({
        user_id: user.id,
        dog_id: existingDog.id,
        user_message: text,
        ai_response: aiReply,
        category: guessCategory(text),
        risk_level: guessRiskLevel(text),
      });

    if (consultationError) {
      console.error(
        'Consultation save error:',
        consultationError
      );
    }

    return;
  }

  /*
   * 以下プロフィール登録
   */
  const state =
    user.registration_state as RegistrationState | null;

  if (!state) {
    const initialState: RegistrationState = {
      step: 0,
      draft: {},
    };

    await supabase
      .from('users')
      .update({
        registration_state: initialState,
      })
      .eq('id', user.id);

    await replyMessage(
      replyToken,
      `Meso AIへようこそ🐶\n\n${QUESTIONS[0].prompt}`
    );

    return;
  }

  const currentQuestion = QUESTIONS[state.step];

  /*
   * DB上のstateがおかしい場合の復旧
   */
  if (!currentQuestion) {
    await supabase
      .from('users')
      .update({
        registration_state: {
          step: 0,
          draft: {},
        },
      })
      .eq('id', user.id);

    await replyMessage(
      replyToken,
      `プロフィール登録を最初からやり直そう🐶\n\n${QUESTIONS[0].prompt}`
    );

    return;
  }

  /*
   * 入力チェック
   */
  const validationError = validateRegistrationAnswer(
    currentQuestion.field,
    text
  );

  if (validationError) {
    await replyMessage(replyToken, validationError);
    return;
  }

  const normalizedValue = normalizeRegistrationValue(
    currentQuestion.field,
    text
  );

  const draft = {
    ...state.draft,
    [currentQuestion.field]: normalizedValue,
  };

  const nextStep = state.step + 1;

  if (nextStep < QUESTIONS.length) {
    await supabase
      .from('users')
      .update({
        registration_state: {
          step: nextStep,
          draft,
        },
      })
      .eq('id', user.id);

    await replyMessage(
      replyToken,
      QUESTIONS[nextStep].prompt
    );

    return;
  }

  /*
   * 登録完了
   */
  const age = parseJapaneseNumber(draft.age_years);
  const weight = parseJapaneseDecimal(draft.weight_kg);

  const { error: insertError } = await supabase
    .from('dogs')
    .insert({
      user_id: user.id,
      name: draft.name,
      breed: draft.breed,
      age_years: age,
      gender: draft.gender,
      weight_kg: weight,
      personality: draft.personality,
      likes: draft.likes,
      dislikes: draft.dislikes,
      current_issue: draft.current_issue,
    });

  if (insertError) {
    console.error('Dog insert error:', insertError);

    await replyMessage(
      replyToken,
      'プロフィール登録でエラーが起きたみたい💦\nもう一度試してみてね。'
    );

    return;
  }

  await supabase
    .from('users')
    .update({
      registration_state: null,
    })
    .eq('id', user.id);

  await replyMessage(
    replyToken,
    `${draft.name}ちゃん、登録完了🐶✨\n\nこれから${draft.name}ちゃんのことを覚えながら、一緒に練習していくね。\n\n今気になってることを、そのまま話しかけてみて！`
  );
}

async function askAI(
  dog: any,
  userMessage: string,
  history: ConsultationHistory[]
): Promise<string> {
  const systemPrompt = `
あなたは犬のしつけ相談AI「Meso AI」です。

あなたの役割は、
「犬について詳しく説明する専門家」
ではありません。

「その犬のことを覚えていて、飼い主と一緒に少しずつ改善していくLINE上のコーチ」
です。

LINEで会話していることを常に意識してください。

【犬のプロフィール】

名前：${dog.name}
犬種：${dog.breed ?? '不明'}
年齢：${dog.age_years ?? '不明'}歳
性別：${dog.gender ?? '不明'}
体重：${dog.weight_kg ?? '不明'}kg
性格：${dog.personality ?? '不明'}
好きなもの：${dog.likes ?? '不明'}
苦手なもの：${dog.dislikes ?? '不明'}
現在困っていること：${dog.current_issue ?? '特になし'}

【Meso AIで最も大切なこと】

一度の返信ですべて解決しようとしないでください。

1往復ごとに、飼い主と犬が少しだけ前に進むことを目指してください。

過去の会話がある場合は、必ずその流れを考慮してください。

前回の相談への返事や経過報告の場合は、
新しい相談として最初から説明し直さないでください。

例えば、

前回：
「人から5mくらい離れて練習してみよう」

今回：
「今日は2回吠えた」

という流れなら、

「散歩中に人へ吠える理由は〜」

と最初から説明してはいけません。

「2回だったんだね。前回より減っているならいい感じ👍」
のように続きを話してください。

【ユーザーの発言を内部的に判断する】

返信を書く前に、ユーザーの発言が次のどれに近いか判断してください。

A：新しい相談
B：前回の質問への回答
C：練習結果・経過報告
D：雑談や簡単な質問

この分類名をユーザーに表示してはいけません。

B・Cの場合は特に短く返してください。

【文章量】

通常は100〜220文字程度を目安にしてください。

必要があっても原則300文字以内です。

「短く答えられるなら短い方が良い」
を最優先してください。

飼い主が散歩中にスマホを見ても、
10秒程度で内容が理解できる返信を目指してください。

【書き方】

・Markdownの # や ## の見出しは禁止
・原因候補を大量に並べない
・長い箇条書きを作らない
・一度に提案する行動は1つ。必要な場合のみ2つまで
・説明より「次に何をやるか」を優先
・犬の名前を自然に使う
・プロフィール情報は必要な場合だけ自然に使う
・毎回犬種や年齢を復唱しない
・専門用語をできるだけ避ける
・短い段落と改行を使う
・絵文字は少量だけ使用してよい
・「〜とのことですね」のようなAI的な復唱は禁止
・同じテンプレートを毎回繰り返さない
・犬の気持ちや原因を断定しない

【会話の基本】

毎回、

共感
↓
説明
↓
注意
↓
質問

という形式にする必要はありません。

必要なものだけ使ってください。

通常は、

短いコメント
↓
今日やること
↓
必要なら質問1つ

程度で十分です。

ユーザーが短い返事をした場合は、
前置きを極力省き、その答えを受けて次へ進んでください。

【質問】

質問する場合は原則1つだけにしてください。

答えやすい質問を優先してください。

例：

「人が何mくらいまで近づくと吠える？」

「今日は何回くらい成功した？」

「①ほぼできた ②少しできた ③難しかった」

など。

複数の質問を一度にしないでください。

【トレーニング】

一度に宿題をたくさん出さないでください。

基本は「今日やること1つ」です。

具体的で、飼い主がその日の散歩ですぐ実践できる形にしてください。

例：

「人が見えたら5mくらい離れて、吠れる前におやつ」

のようにします。

成功条件もできるだけ簡単にしてください。

例：

「今日は3回できればOK」

【プロフィールの使い方】

好きなものが分かっている場合は、
ご褒美として自然に活用してください。

例：

好きなもの：芋

→
「吠れる前にめそちゃんの好きな芋をあげてみよう🍠」

ただし毎回プロフィール情報を無理に盛り込まないでください。

【安全】

以下の場合は簡潔さより安全を優先してください。

・人や犬へ実際に噛みついている
・噛みつく危険性が高い
・急に性格や行動が変化した
・痛みや病気の可能性がある
・意識、呼吸、嘔吐、けいれん等の健康上重大な異常

診断はしないでください。

必要に応じて、
動物病院、獣医行動診療、適切なドッグトレーナー等への相談を勧めてください。

【最終チェック】

返信を書く前に心の中で確認してください。

「これはLINEで10秒程度で読めるか？」

「今の飼い主に必要なことを1つに絞れているか？」

「前回の会話を無視して最初から説明していないか？」

長ければ削ってください。
`.trim();

  const messages = [
    ...history.flatMap((h) => [
      {
        role: 'user' as const,
        content: h.user_message,
      },
      {
        role: 'assistant' as const,
        content: h.ai_response,
      },
    ]),
    {
      role: 'user' as const,
      content: userMessage,
    },
  ];

  try {
    const res = await fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key':
            process.env.ANTHROPIC_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:
            process.env.ANTHROPIC_MODEL ??
            'claude-sonnet-5',

          /*
           * LINE返信なので出力をかなり絞る
           */
          max_tokens: 500,

          /*
           * Sonnet 5の推論負荷を軽めにする
           */
          output_config: {
            effort: 'low',
          },

          system: systemPrompt,
          messages,
        }),
      }
    );

    if (!res.ok) {
      const errorText = await res.text();

      console.error(
        'Anthropic API error:',
        res.status,
        errorText
      );

      return 'ごめんね、今ちょっと考えられなかったみたい💦\nもう一度送ってみてね。';
    }

    const json = await res.json();

    const textBlock = json.content?.find(
      (block: any) => block.type === 'text'
    );

    const generatedText =
      textBlock?.text?.trim();

    if (!generatedText) {
      console.error(
        'No text returned from Anthropic:',
        JSON.stringify(json)
      );

      return 'うまく返事を作れなかったみたい💦\nもう一度聞いてみてね。';
    }

    return cleanAIReply(generatedText);
  } catch (error) {
    console.error('askAI error:', error);

    return 'AIとの通信がうまくいかなかったみたい💦\nもう一度送ってみてね。';
  }
}

function cleanAIReply(text: string): string {
  /*
   * 万が一Markdown見出しを出してきた場合に除去
   */
  let cleaned = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  /*
   * 異常に長い出力だけ保険で制限
   * 安全関連の文章を途中で乱暴に切らないため、
   * 基本はプロンプトとmax_tokensで制御する。
   */
  const HARD_LIMIT = 700;

  if (cleaned.length > HARD_LIMIT) {
    const candidate = cleaned.slice(0, HARD_LIMIT);

    const lastBreak = Math.max(
      candidate.lastIndexOf('。'),
      candidate.lastIndexOf('！'),
      candidate.lastIndexOf('？'),
      candidate.lastIndexOf('\n')
    );

    if (lastBreak > 300) {
      cleaned =
        candidate.slice(0, lastBreak + 1).trim();
    }
  }

  return cleaned;
}

function validateRegistrationAnswer(
  field: string,
  text: string
): string | null {
  if (!text.trim()) {
    return '空欄みたい🐶\nもう一度教えてね。';
  }

  if (field === 'age_years') {
    const age = parseJapaneseNumber(text);

    if (
      age === null ||
      age < 0 ||
      age > 30
    ) {
      return '年齢がうまく読み取れなかったよ🐶\n「5」のように数字で教えてね。';
    }
  }

  if (field === 'weight_kg') {
    const weight = parseJapaneseDecimal(text);

    if (
      weight === null ||
      weight <= 0 ||
      weight > 100
    ) {
      return '体重がうまく読み取れなかったよ🐶\n「3.2」のようにkgで教えてね。';
    }
  }

  if (field === 'gender') {
    const normalized = text
      .replace(/\s/g, '')
      .toLowerCase();

    const valid =
      normalized.includes('オス') ||
      normalized.includes('雄') ||
      normalized.includes('男') ||
      normalized.includes('メス') ||
      normalized.includes('雌') ||
      normalized.includes('女');

    if (!valid) {
      return '「オス」か「メス」で教えてね🐶';
    }
  }

  return null;
}

function normalizeRegistrationValue(
  field: string,
  text: string
): string {
  const trimmed = text.trim();

  if (field === 'gender') {
    if (
      trimmed.includes('メス') ||
      trimmed.includes('雌') ||
      trimmed.includes('女')
    ) {
      return 'メス';
    }

    return 'オス';
  }

  return trimmed;
}

function normalizeFullWidthNumber(
  value: string
): string {
  return value.replace(/[０-９．]/g, (char) => {
    if (char === '．') return '.';

    return String.fromCharCode(
      char.charCodeAt(0) - 0xfee0
    );
  });
}

function parseJapaneseNumber(
  value?: string
): number | null {
  if (!value) return null;

  const normalized =
    normalizeFullWidthNumber(value);

  const match =
    normalized.match(/\d+/);

  if (!match) return null;

  const number = Number(match[0]);

  return Number.isFinite(number)
    ? number
    : null;
}

function parseJapaneseDecimal(
  value?: string
): number | null {
  if (!value) return null;

  const normalized =
    normalizeFullWidthNumber(value);

  const match =
    normalized.match(/\d+(?:\.\d+)?/);

  if (!match) return null;

  const number = Number(match[0]);

  return Number.isFinite(number)
    ? number
    : null;
}

function guessCategory(text: string): string {
  const value = text.toLowerCase();

  if (
    value.includes('吠') ||
    value.includes('ほえ')
  ) {
    return 'barking';
  }

  if (
    value.includes('噛') ||
    value.includes('かむ') ||
    value.includes('咬')
  ) {
    return 'biting';
  }

  if (
    value.includes('散歩') ||
    value.includes('リード') ||
    value.includes('引っ張')
  ) {
    return 'walking';
  }

  if (
    value.includes('トイレ') ||
    value.includes('おしっこ') ||
    value.includes('うんち')
  ) {
    return 'toilet';
  }

  if (
    value.includes('留守番') ||
    value.includes('分離')
  ) {
    return 'separation';
  }

  if (
    value.includes('おもちゃ') ||
    value.includes('取ろう') ||
    value.includes('唸')
  ) {
    return 'resource_guarding';
  }

  return 'other';
}

function guessRiskLevel(
  text: string
): 'low' | 'medium' | 'high' {
  if (
    /噛みついた|噛んだ|出血|血が出|けいれん|痙攣|呼吸でき|意識が|倒れた/.test(
      text
    )
  ) {
    return 'high';
  }

  if (
    /噛みそう|噛もう|飛びかか|唸る|パニック/.test(
      text
    )
  ) {
    return 'medium';
  }

  return 'low';
}

async function ensureUser(
  lineUserId: string
) {
  const { data: existing, error: findError } =
    await supabase
      .from('users')
      .select('id, registration_state')
      .eq('line_user_id', lineUserId)
      .maybeSingle();

  if (findError) {
    console.error('User lookup error:', findError);
    return null;
  }

  if (existing) {
    return existing;
  }

  const { data: created, error: createError } =
    await supabase
      .from('users')
      .insert({
        line_user_id: lineUserId,
      })
      .select('id, registration_state')
      .single();

  if (createError) {
    console.error(
      'User creation error:',
      createError
    );

    return null;
  }

  return created;
}

async function replyMessage(
  replyToken: string,
  text: string
) {
  const accessToken =
    process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!accessToken) {
    console.error(
      'LINE_CHANNEL_ACCESS_TOKEN is missing'
    );
    return;
  }

  try {
    const response = await fetch(
      'https://api.line.me/v2/bot/message/reply',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          replyToken,
          messages: [
            {
              type: 'text',
              text,
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      console.error(
        'LINE reply error:',
        response.status,
        await response.text()
      );
    }
  } catch (error) {
    console.error(
      'LINE reply fetch error:',
      error
    );
  }
}