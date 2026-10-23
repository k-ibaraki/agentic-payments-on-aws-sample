/**
 * 繋ぎ直しのトークンの取り直し（createChat の refresh。決定72）に渡す、チャンネルの生の記述。
 *
 * Blocks の API はチャンネルを返すと、識別子（__blocks）を見てクライアントで購読できるチャンネルに
 * 組み立て直す。refresh が求めるのは組み立てる前の記述なので、識別子を外して返し、画面の側
 * （ui-rules.ts の toChannelDescriptor）で付け直す。この記述は接続と購読のトークンそのものなので、
 * 返す API には元のチャンネルを渡す API と同じ認可を掛けること
 */
export function rawChannelDescriptor(channel: {
  toJSON(): RawChannelDescriptor & { __blocks: string };
}): RawChannelDescriptor {
  const { __blocks: _tag, ...raw } = channel.toJSON();
  return raw;
}

/** 接続先とトークンなど。中身の名前は bb-realtime の内部なので、channel 以外は決め打ちしない */
export interface RawChannelDescriptor {
  channel: string;
  [key: string]: unknown;
}
