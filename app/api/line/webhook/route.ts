import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase/client';

export const runtime = 'nodejs';

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
      const lineUserId = event.source.userId;
      const debugInfo = await ensureUser(lineUserId);
      await replyMessage(event.replyToken, `オウム返し: ${event.message.text}\n[DEBUG] ${debugInfo}`);
    }
  }

  return NextResponse.json({ status: 'ok' });
}

async function ensureUser(lineUserId: string): Promise<string> {
  const { data: existing, error: selectError } = await supabase
    .from('users')
    .select('id')
    .eq('line_user_id', lineUserId)
    .maybeSingle();

  if (selectError) {
    return `検索エラー: ${selectError.message}`;
  }

  if (existing) {
    return '既存ユーザーでした';
  }

  const { error: insertError } = await supabase
    .from('users')
    .insert({ line_user_id: lineUserId });

  if (insertError) {
    return `登録エラー: ${insertError.message}`;
  }

  return '新規登録に成功しました';
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
