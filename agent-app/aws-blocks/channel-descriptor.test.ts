// 繋ぎ直しのトークンの取り直し（refresh）に渡す、チャンネルの生の記述（決定72）
import { describe, expect, it } from 'vitest';
import { rawChannelDescriptor } from './channel-descriptor.js';

describe('rawChannelDescriptor', () => {
  // 識別子（__blocks）が付いたまま返すと、応答の途中で Blocks のクライアントが購読できるチャンネルに
  // 組み立て直してしまう。createChat の refresh は生の記述を求めるので外して返し、画面の側で付け直す
  it('Realtime のチャンネルの識別子を外し、トークンなどはそのまま返す', () => {
    const channel = {
      toJSON: () => ({ __blocks: 'realtime/channel' as const, channel: 'c-1', token: 't', connectToken: 'ct' }),
    };

    expect(rawChannelDescriptor(channel)).toEqual({ channel: 'c-1', token: 't', connectToken: 'ct' });
  });
});
