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
    const aiReply = await askAI(existingDog, text);
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

async function askAI(dog: any, userMessage: string): Promise<string> {
  const systemPrompt = `あなたは犬のしつけ相談AI「Meso AI」です。以下の犬のプロフィールを踏まえて、飼い主からの相談に日本語で答えてください。

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

回答は必ず次の構成にしてください。
1. 状況の整理
2. 考えられる理由
3. 今は避けた方がいい対応
4. 今日からできること
5. 必要であれば追加の質問

断定的な診断はせず、重大な健康問題や危険性の高い攻撃行動が疑われる場合は、必ず獣医師や専門のドッグトレーナーへの相談を勧めてください。`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    return `すみません、AIとの通信でエラーが発生しました。(${errorText.slice(0, 100)})`;
  }

   const json = await res.json();
  const text = json.content?.[0]?.text;

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

