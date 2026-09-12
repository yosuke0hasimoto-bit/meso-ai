import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase/client';

export const runtime = 'nodejs';

const QUESTIONS = [
  { field: 'name', prompt: '愛犬の名前を教えてください。' },
  { field: 'breed', prompt: '犬種を教えてください。' },
  { field: 'age_years', prompt: '年齢を教えてください（数字だけでOKです。例: 3）' },
  { field: 'gender', prompt: '性別を教えてください（オス/メス）' },
  { field: 'weight_kg', prompt: '体重を教えてください（kgで、例: 5.5）' },
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
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (existingDog) {
    await replyMessage(replyToken, 'プロフィール登録は完了しています。ご相談をどうぞ！');
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
    `${draft.name}のプロフィール登録が完了しました！これから一緒にしつけを頑張りましょう。`
  );
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
