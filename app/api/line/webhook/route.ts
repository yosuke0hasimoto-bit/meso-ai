import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase/client';

export const runtime = 'nodejs';

const QUESTIONS = [
  { field: 'name', prompt: '愛犬の名前を教えてください。' },
  { field: 'breed', prompt: '犬種を教えてください。' },
  { field: 'age_years', prompt: '年齢を教えてください(数字だけでOKです。例: 3)' },
  { field: 'gender', prompt: '性別を教えてください(オス/メス)' },
  { field: 'weight_kg', prompt: '体重を教えてください(kgで、例: 5.5)' },
  { field: 'personality', prompt: '性格を教えてください。' },
  { field: 'likes', prompt: '好きなものを教えてください。' },
  { field: 'dislikes', prompt: '苦手なものを教えてください。' },
  { field: 'current_issue', prompt: '今、困っている行動があれば教えてください。特になければ「特になし」と送ってください。' },
];

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get('x-line-signature') ?? '';

  const channelSecret = process.env.LINE_CHANNEL_SECRET!;
  const hash = crypto.createHmac('sha256', channelSecret).update(body).digest('base64');

  if (hash !== signature) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  const data = JSON.parse(body);
  const events = data.events ?? [];

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleMessage(event.source.userId, event.message.text, event.replyToken);
    }
  }

  return NextResponse.json({ status: 'ok' });
}

async function handleMessage(lineUserId: string, text: string, replyToken: string) {
  const user = await ensureUser(lineUserId);

  if (!user) {
    await replyMessage(replyToken, 'エラーが発生しました。もう一度お試しください。');
    return;
  }

  const { data: existingDog } = await supabase
    .from('dogs')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (existingDog) {
    const { data: history } = await supabase
      .from('consultations')
      .select('user_message, ai_response')
      .eq('dog_id', existingDog.id)
      .order('created_at', { ascending: false })
      .limit(6);

    const orderedHistory = (history ?? []).reverse();

    const aiReply = await askAI(existingDog, text, orderedHistory);
    await replyMessage(replyToken, aiReply);

    await supabase.from('consultations').insert({
      user_id: user.id,
      dog_id: existingDog.id,
      user_message: text,
      ai_response: aiReply,
      category: 'other',
      risk_level: 'low',
    });
    return;
  }

  const state = user.registration_state as { step: number; draft: Record<string, string> } | null;

  if (!state) {
    await supabase
      .from('users')
      .update({ registration_state: { step: 0, draft: {} } })
      .eq('id', user.id);

    await replyMessage(replyToken, `愛犬のプロフィールを登録しましょう！\n\n${QUESTIONS[0].prompt}`);
    return;
  }

  const currentQuestion = QUESTIONS[state.step];
  const draft = { ...state.draft, [currentQuestion.field]: text };
  const nextStep = state.step + 1;

  if (nextStep < QUESTIONS.length) {
    await supabase
      .from('users')
      .update({ registration_state: { step: nextStep, draft } })
      .eq('id', user.id);

    await replyMessage(replyToken, QUESTIONS[nextStep].prompt);
    return;
  }

  const { error: insertError } = await supabase.from('dogs').insert({
    user_id: user.id,
    name: draft.name,
    breed: draft.breed,
    age_years: draft.age_years ? parseInt(draft.age_years, 10) : null,
    gender: draft.gender,
    weight_kg: draft.weight_kg ? parseFloat(draft.weight_kg) : null,
    personality: draft.personality,
    likes: draft.likes,
    dislikes: draft.dislikes,
    current_issue: draft.current_issue,
  });

  await supabase.from('users').update({ registration_state: null }).eq('id', user.id);

  if (insertError) {
    await replyMessage(replyToken, `登録エラー: ${insertError.message}`);
    return;
  }

  await replyMessage(
    replyToken,
    `${draft.name}ちゃんのプロフィール登録が完了しました！これから一緒にしつけを頑張りましょう。何か気になることがあれば、いつでも話しかけてください。`
  );
}

async function askAI(
  dog: any,
  userMessage: string,
  history: { user_message: string; ai_response: string }[]
): Promise<string> {
  const systemPrompt = `あなたは犬のしつけ相談AI「Meso AI」です。飼い主からの相談に、LINEで読みやすい短い返信をする「対話型トレーニングコーチ」として答えてください。

【犬のプロフィール】
名前: ${dog.name}
犬種: ${dog.breed ?? '不明'}
年齢: ${dog.age_years ?? '不明'}歳
性別: ${dog.gender ?? '不明'}
体重: ${dog.weight_kg ?? '不明'}kg
性格: ${dog.personality ?? '不明'}
好きなもの: ${dog.likes ?? '不明'}
苦手なもの: ${dog.dislikes ?? '不明'}
現在困っている行動: ${dog.current_issue ?? '特になし'}

【最も大事な価値観】
Meso AIの価値は「一度の相談で大量の知識を提供すること」ではなく「その犬のことを覚えていて、前回の続きから一緒に改善していくこと」です。会話の履歴がある場合は、それを踏まえて自然に話を続けてください(例:「昨日は5mくらい離れて練習したね。今日はどうだった?」)。

【回答の基本ルール】
- 文字数は原則200〜300文字程度。長々と説明しない
- Markdownの見出し(#、##など)は使わない
- 原因の候補を大量に列挙しない
- 一度に教える行動は原則1つ、多くても2つまで
- 犬の名前(${dog.name})を自然に呼びかけに使う
- プロフィール(犬種・性格・好き嫌いなど)をさりげなく反映する
- 専門用語は避け、飼い主が実際にできる行動として伝える
- LINEで読みやすいよう、短い段落・改行を使う
- 絵文字(🐶👍🍖⚠️など)は少量だけ使ってよい
- 「〜とのことですね」のようなAI的な復唱・要約はしない
- 毎回同じテンプレート的な文章にせず、自然な言葉で書く
- 根拠なく犬の気持ちや原因を断定しない

【基本の返信の流れ】
1. 短い共感・状況整理(1〜2文)
2. 今日やること(具体的に1つ、多くて2つ)
3. 注意点(⚠️を使って1文程度)
4. 追加質問を1つ

一度の返信ですべてを説明しようとせず、飼い主の返事を受けて次のアドバイスを調整してください。必要に応じて「①ほぼできた ②少しできた ③難しかった」のような、LINEで簡単に答えられる選択肢を出し、結果に応じて次回の難易度を調整してください。

【安全最優先のケース】
噛みつきの危険、急激な行動変化、痛みや病気が疑われる場合は、上記の文字数や形式のルールより安全を優先し、断定はせず、必ず動物病院・獣医行動診療科・専門のドッグトレーナーへの相談を勧めてください。`;

  const messages = [
    ...history.flatMap((h) => [
      { role: 'user' as const, content: h.user_message },
      { role: 'assistant' as const, content: h.ai_response },
    ]),
    { role: 'user' as const, content: userMessage },
  ];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    return `すみません、AIとの通信でエラーが発生しました。(${errorText.slice(0, 100)})`;
  }

  const json = await res.json();
  const textBlock = json.content?.find((block: any) => block.type === 'text');
  const text = textBlock?.text;

  if (!text) {
    return `回答を生成できませんでした。[DEBUG] stop_reason=${json.stop_reason} / content=${JSON.stringify(json.content)}`;
  }

  return text;
}

async function ensureUser(lineUserId: string) {
  const { data: existing } = await supabase
    .from('users')
    .select('id, registration_state')
    .eq('line_user_id', lineUserId)
    .maybeSingle();

  if (existing) {
    return existing;
  }

  const { data: created } = await supabase
    .from('users')
    .insert({ line_user_id: lineUserId })
    .select('id, registration_state')
    .single();

  return created;
}

async function replyMessage(replyToken: string, text: string) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });
}