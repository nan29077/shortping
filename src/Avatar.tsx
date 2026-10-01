import type { User } from './api';
import { asset } from './platform';

// 프로필 이미지. 계정 설정 화면을 나중에 내려받아도 머리글 · 목록에서 바로 쓸 수 있게 따로 둬요.
export function Avatar({ user }: { user: Pick<User, 'name' | 'avatar'> }) {
  return (
    <img
      className="profile-image"
      src={asset(user.avatar || '/avatars/block-01.webp')}
      alt={user.name + ' 프로필'}
      onError={(e) => {
        e.currentTarget.onerror = null;
        if (!e.currentTarget.src.endsWith('/avatars/block-01.webp'))
          e.currentTarget.src = '/avatars/block-01.webp';
      }}
    />
  );
}
